import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  // Redact anything that could leak signer PII or secrets into logs.
  redact: {
    paths: [
      "req.headers.authorization",
      "*.access_token",
      "*.accessToken",
      "*.SF_PRIVATE_KEY",
      "*.privateKey",
      "*.accessTokenHash",
    ],
    censor: "[redacted]",
  },
  transport: env.isProduction
    ? undefined
    : { target: "pino/file", options: { destination: 1 } },
});
