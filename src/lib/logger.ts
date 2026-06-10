import pino from "pino";
import { env } from "../config/env.js";

/**
 * Signer/prepare tokens are bearer credentials carried in URL paths (/sign/<token>,
 * /api/sign/<token>/..., /prepare/<token>), and Fastify logs req.url on every request — without
 * masking, every signing link would land in the log infrastructure (Heroku logplex, drains).
 * Mask just the token segment so request logs stay useful.
 */
const TOKEN_PATH_RE = /(\/(?:api\/)?(?:sign|prepare)\/)[A-Za-z0-9_-]{20,}/g;

export function maskTokensInUrl(url: string): string {
  return url.replace(TOKEN_PATH_RE, "$1[token]");
}

export const logger = pino({
  level: env.LOG_LEVEL,
  // Redact anything that could leak signer PII or secrets into logs.
  redact: {
    paths: [
      "req.headers.authorization",
      'req.headers["x-api-key"]',
      "*.access_token",
      "*.accessToken",
      "*.SF_PRIVATE_KEY",
      "*.privateKey",
      "*.accessTokenHash",
    ],
    censor: "[redacted]",
  },
  serializers: {
    // Mirrors Fastify's standard req serializer fields, with the token-bearing path masked.
    req(req: { method?: string; url?: string; headers?: Record<string, unknown>; ip?: string }) {
      return {
        method: req.method,
        url: req.url ? maskTokensInUrl(req.url) : req.url,
        ip: req.ip,
      };
    },
  },
  transport: env.isProduction
    ? undefined
    : { target: "pino/file", options: { destination: 1 } },
});
