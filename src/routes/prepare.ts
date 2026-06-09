import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import {
  getPrepareContext,
  getPrepareDocument,
  replaceDraftFields,
  sendDraftByPrepareToken,
} from "../signing/requests.js";

/**
 * Sender field-placement ("prepare") surface. Authenticated solely by the high-entropy prepare
 * token in the URL (NOT the backend API key — a browser page can't hold it). Lets a sender open a
 * DRAFT, place Signature/Initials/Date/Text boxes on the PDF per signer, and send.
 */

const tokenParams = z.object({ token: z.string().min(20).max(200) });
const fieldType = z.enum(["SIGNATURE", "INITIALS", "DATE", "TEXT"]);

const fieldsSchema = z.object({
  fields: z
    .array(
      z.object({
        signerIndex: z.number().int().nonnegative(),
        type: fieldType,
        label: z.string().max(255).optional(),
        required: z.boolean().optional(),
        pageIndex: z.number().int().nonnegative(),
        x: z.number(),
        y: z.number(),
        width: z.number().positive(),
        height: z.number().positive(),
      }),
    )
    .default([]),
});

const PAGE_PATH = join(process.cwd(), "public", "prepare.html");
let cached: string | null = null;

async function renderPage(): Promise<string> {
  if (cached && env.isProduction) return cached;
  const raw = await readFile(PAGE_PATH, "utf8");
  const html = raw
    .replaceAll("{{BRAND_NAME}}", env.BRAND_NAME)
    .replaceAll("{{BRAND_PRIMARY_COLOR}}", env.BRAND_PRIMARY_COLOR)
    .replaceAll("{{BRAND_LOGO_URL}}", env.BRAND_LOGO_URL ?? "");
  cached = html;
  return html;
}

export async function prepareRoutes(app: FastifyInstance): Promise<void> {
  // The placement page shell (token read client-side from the URL).
  app.get("/prepare/:token", async (_req, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(await renderPage());
  });

  // Document name, signers, page geometry, and any already-placed fields.
  app.get("/api/prepare/:token", async (req) => {
    const { token } = tokenParams.parse(req.params);
    return getPrepareContext(token);
  });

  // The source PDF bytes (rendered with pdf.js in the page).
  app.get("/api/prepare/:token/document", async (req, reply) => {
    const { token } = tokenParams.parse(req.params);
    const pdf = await getPrepareDocument(token);
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", "inline; filename=document.pdf");
    return reply.send(pdf);
  });

  // Replace the whole field layout for the draft.
  app.put("/api/prepare/:token/fields", async (req) => {
    const { token } = tokenParams.parse(req.params);
    const { fields } = fieldsSchema.parse(req.body);
    return replaceDraftFields(token, fields);
  });

  // Send the draft for signature (mints signer links + emails them).
  app.post("/api/prepare/:token/send", async (req) => {
    const { token } = tokenParams.parse(req.params);
    const links = await sendDraftByPrepareToken(token);
    return { sent: links.length };
  });
}
