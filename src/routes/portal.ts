import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";

/**
 * Serves the signer portal — a single self-contained HTML page. The token is part of the URL
 * path and read client-side; this route just returns the (brand-injected) shell for any
 * /sign/<token> URL.
 *
 * Deliberate v1 simplicity: a static page served by the backend rather than a separate Next.js
 * app, so the whole product is one Heroku dyno. The signing API is the real contract and the
 * portal can be replaced with an SPA later without backend changes.
 */

const PORTAL_PATH = join(process.cwd(), "public", "portal.html");

let cached: string | null = null;

async function renderPortal(): Promise<string> {
  if (cached && env.isProduction) return cached;
  const raw = await readFile(PORTAL_PATH, "utf8");
  const html = raw
    .replaceAll("{{BRAND_NAME}}", env.BRAND_NAME)
    .replaceAll("{{BRAND_PRIMARY_COLOR}}", env.BRAND_PRIMARY_COLOR)
    .replaceAll("{{BRAND_LOGO_URL}}", env.BRAND_LOGO_URL ?? "");
  cached = html;
  return html;
}

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  app.get("/sign/:token", async (_req, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(await renderPortal());
  });
}
