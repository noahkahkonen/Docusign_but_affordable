import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Shared x-api-key guard for the backend's privileged APIs (sender/admin + Salesforce read path).
 *
 * Fastify plugins are encapsulated: a preHandler added inside one route plugin does NOT cover a
 * sibling plugin. So every privileged plugin must register this guard itself — that's the whole
 * reason it lives here rather than inline in one route file.
 *
 * In production BACKEND_API_KEY is mandatory (enforced at boot in env.ts). If it's unset here we're
 * in dev/test with the guard intentionally disabled; we warn once at boot.
 */

/** Constant-time string equality (length-independent via SHA-256 of each side). */
function secretEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** True if the request presents a valid key; otherwise sends 401 and returns false. */
export function requireApiKey(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!env.BACKEND_API_KEY) return true; // guard disabled in dev/test (warned at boot)
  const header = req.headers["x-api-key"];
  // Reject multi-valued headers outright; compare in constant time.
  const presented = typeof header === "string" ? header : "";
  if (!presented || !secretEquals(presented, env.BACKEND_API_KEY)) {
    reply.code(401).send({ error: "unauthorized", message: "Invalid or missing API key" });
    return false;
  }
  return true;
}

let warnedOnce = false;

/** Add the x-api-key preHandler to a plugin scope. Call this first so it runs before other hooks. */
export function registerApiKeyGuard(app: FastifyInstance): void {
  if (!env.BACKEND_API_KEY && !warnedOnce) {
    warnedOnce = true;
    logger.warn(
      "BACKEND_API_KEY is not set — the privileged APIs (sender + Salesforce read path) are UNGUARDED. Set it before production.",
    );
  }
  app.addHook("preHandler", async (req, reply) => {
    if (!requireApiKey(req, reply)) return reply; // short-circuit
  });
}
