import type { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma.js";
import { hasSalesforceCredentials } from "../config/env.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness: is the process up at all.
  app.get("/health", async () => ({ status: "ok" }));

  // Readiness: can we reach the things we depend on. Reports per-dependency so a partially
  // configured environment (e.g. SF not wired yet) is legible rather than a blanket 500.
  app.get("/health/ready", async () => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = { ok: true };
    } catch (err) {
      checks.database = { ok: false, detail: (err as Error).message };
    }

    checks.salesforceConfigured = { ok: hasSalesforceCredentials() };

    const ok = Object.values(checks).every((c) => c.ok);
    return { status: ok ? "ready" : "degraded", checks };
  });
}
