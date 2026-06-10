import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { healthRoutes } from "./routes/health.js";
import { salesforceRoutes } from "./routes/salesforce.js";
import { requestRoutes } from "./routes/requests.js";
import { signingRoutes } from "./routes/signing.js";
import { portalRoutes } from "./routes/portal.js";
import { prepareRoutes } from "./routes/prepare.js";

/**
 * Build the Fastify app. Kept separate from server bootstrap so tests can construct it
 * without binding a port.
 */
export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    // Trust exactly ONE proxy hop (the Heroku router) for X-Forwarded-For. `true` would trust
    // the whole client-supplied chain, letting a signer spoof the IP recorded as ESIGN evidence.
    trustProxy: 1,
    bodyLimit: 25 * 1024 * 1024, // 25 MB; CRE PDFs can be large
  });

  await app.register(sensible);
  // The portal and prepare pages are served same-origin by this app, and the Salesforce callout
  // is server-to-server (CORS doesn't apply) — so cross-origin browser access isn't needed at
  // all. Reflecting any origin WITH credentials (the previous setting) is the canonical CORS
  // anti-pattern; allow only our own origin, no credentials.
  await app.register(cors, {
    origin: [new URL(env.APP_BASE_URL).origin],
    credentials: false,
  });

  // Surface validation errors (zod throws) as clean 400s instead of 500s.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err.name === "ZodError") {
      return reply.code(400).send({ error: "invalid_request", detail: err.message });
    }
    app.log.error(err);
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({
      error: status >= 500 ? "internal_error" : "request_error",
      message: env.isProduction && status >= 500 ? "Internal Server Error" : err.message,
    });
  });

  await app.register(healthRoutes);
  await app.register(salesforceRoutes);
  await app.register(requestRoutes);
  await app.register(signingRoutes);
  await app.register(portalRoutes);
  await app.register(prepareRoutes);

  return app;
}
