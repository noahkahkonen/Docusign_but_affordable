import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { healthRoutes } from "./routes/health.js";
import { salesforceRoutes } from "./routes/salesforce.js";

/**
 * Build the Fastify app. Kept separate from server bootstrap so tests can construct it
 * without binding a port.
 */
export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    // Trust the Heroku router's X-Forwarded-For so req.ip is the real client IP — this is
    // load-bearing for the audit trail (signer IP capture), not a nicety.
    trustProxy: true,
    bodyLimit: 25 * 1024 * 1024, // 25 MB; CRE PDFs can be large
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: true, // tightened per-environment once the portal origin is known
    credentials: true,
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

  return app;
}
