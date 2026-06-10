import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { requireApiKey } from "../lib/api-key-guard.js";
import {
  getPrepareContext,
  getPrepareDocument,
  replaceDraftFields,
  sendDraftByPrepareToken,
} from "../signing/requests.js";
import {
  saveTemplateFromDraft,
  listTemplates,
  applyTemplateToDraft,
} from "../signing/templates.js";

/**
 * Sender field-placement ("prepare") surface. Authenticated solely by the high-entropy prepare
 * token in the URL (NOT the backend API key — a browser page can't hold it). Lets a sender open a
 * DRAFT, place Signature/Initials/Date/Text boxes on the PDF per signer, and send.
 */

const tokenParams = z.object({ token: z.string().min(20).max(200) });
const fieldType = z.enum(["SIGNATURE", "INITIALS", "DATE", "TEXT"]);

// Coordinates must be finite (z.number() rejects NaN but ACCEPTS Infinity, which would poison
// the final flatten of a completed request) and arrays bounded (a token holder could otherwise
// createMany a million rows / melt the flattener).
const coord = z.number().finite();
const dimension = z.number().finite().positive().max(20000);

const fieldsSchema = z.object({
  fields: z
    .array(
      z.object({
        signerIndex: z.number().int().nonnegative(),
        type: fieldType,
        label: z.string().max(255).optional(),
        required: z.boolean().optional(),
        pageIndex: z.number().int().nonnegative(),
        x: coord,
        y: coord,
        width: dimension,
        height: dimension,
      }),
    )
    .max(500)
    .default([]),
});

const roleFieldsSchema = z.object({
  name: z.string().min(1).max(120),
  documentType: z.string().max(120).nullish().transform((v) => v || undefined),
  autoSend: z.boolean().optional(),
  fields: z
    .array(
      z.object({
        role: z.enum(["BUYER", "SELLER", "TENANT", "LANDLORD", "OTHER"]),
        type: fieldType,
        label: z.string().max(255).optional(),
        required: z.boolean().optional(),
        pageIndex: z.number().int().nonnegative(),
        x: coord,
        y: coord,
        width: dimension,
        height: dimension,
      }),
    )
    .min(1)
    .max(200),
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

  // Templates: list all, save the current layout as a new template, or apply one to this draft.
  app.get("/api/prepare/:token/templates", async (req) => {
    tokenParams.parse(req.params); // validate the token shape (listing is global)
    return { templates: await listTemplates() };
  });

  app.post("/api/prepare/:token/templates", async (req, reply) => {
    const { token } = tokenParams.parse(req.params);
    const { name, fields, documentType, autoSend } = roleFieldsSchema.parse(req.body);
    // Marking a template TRUSTED (autoSend) arms the no-review send path for every future
    // matching document — that authority must not ride on a per-draft prepare token someone
    // could lift from a browser URL. Require the admin API key for the flag specifically;
    // ordinary (non-trusted) template saves remain prepare-token-only for the browser page.
    if (autoSend && !requireApiKey(req, reply)) return reply;
    return saveTemplateFromDraft(token, name, fields, { documentType, autoSend });
  });

  app.post("/api/prepare/:token/apply-template", async (req) => {
    const { token } = tokenParams.parse(req.params);
    const { templateId } = z.object({ templateId: z.string().uuid() }).parse(req.body);
    return applyTemplateToDraft(token, templateId);
  });
}
