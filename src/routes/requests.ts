import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import {
  createSignatureRequest,
  sendSignatureRequest,
  getRequestStatus,
  getSignedPdf,
  getCertificatePdf,
} from "../signing/requests.js";
import { attemptWriteback } from "../signing/writeback.js";

/**
 * Sender/admin API — used by the Salesforce LWC (via Named Credential) to create and send
 * signature requests, and to read status. Guarded by a shared secret (BACKEND_API_KEY). In dev
 * with no key set, the guard is disabled and we warn once at boot.
 */

const fieldSchema = z.object({
  signerIndex: z.number().int().nonnegative(),
  type: z.enum(["SIGNATURE", "INITIALS", "DATE", "TEXT"]),
  label: z.string().max(255).optional(),
  required: z.boolean().optional(),
  pageIndex: z.number().int().nonnegative(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

const fieldType = z.enum(["SIGNATURE", "INITIALS", "DATE", "TEXT"]);

const createSchema = z.object({
  salesforceRecordId: z.string().min(15).max(18),
  salesforceObjectType: z.string().min(1).max(80),
  contentVersionId: z.string().min(15).max(18),
  documentName: z.string().min(1).max(255),
  signers: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        email: z.string().email(),
        entityLabel: z.string().max(255).optional(),
        // Field types to auto-place for this signer (the LWC sends these instead of x/y boxes).
        autoFields: z.array(fieldType).optional(),
      }),
    )
    .min(1),
  fields: z.array(fieldSchema).default([]),
});

/** Constant-time string equality (length-independent via SHA-256). */
function secretEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function requireApiKey(req: FastifyRequest, reply: FastifyReply): boolean {
  // In production the key is required (enforced at boot in env.ts); if it's unset here we're in
  // dev/test with the guard intentionally disabled (warned at boot).
  if (!env.BACKEND_API_KEY) return true;
  const header = req.headers["x-api-key"];
  // Reject multi-valued headers outright; compare in constant time.
  const presented = typeof header === "string" ? header : "";
  if (!presented || !secretEquals(presented, env.BACKEND_API_KEY)) {
    reply.code(401).send({ error: "unauthorized", message: "Invalid or missing API key" });
    return false;
  }
  return true;
}

export async function requestRoutes(app: FastifyInstance): Promise<void> {
  if (!env.BACKEND_API_KEY) {
    logger.warn(
      "BACKEND_API_KEY is not set — the sender/admin API is UNGUARDED. Set it before production.",
    );
  }

  app.addHook("preHandler", async (req, reply) => {
    if (!requireApiKey(req, reply)) return reply; // short-circuit
  });

  // Create a DRAFT request from a Salesforce file + signers + field placements.
  app.post("/api/requests", async (req, reply) => {
    const body = createSchema.parse(req.body);
    const result = await createSignatureRequest(body);
    return reply.code(201).send(result);
  });

  // Mint signer tokens and move to SENT. Returns the per-signer signing links.
  app.post("/api/requests/:id/send", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const links = await sendSignatureRequest(id);
    return { requestId: id, links };
  });

  // Sender status view, including the full audit trail.
  app.get("/api/requests/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const status = await getRequestStatus(id);
    if (!status) return reply.code(404).send({ error: "not_found" });
    return status;
  });

  // Retry the Salesforce write-back (e.g. after a transient failure or once SF is configured).
  app.post("/api/requests/:id/writeback", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return attemptWriteback(id, { ip: req.ip, userAgent: req.headers["user-agent"] });
  });

  // Download the flattened signed PDF.
  app.get("/api/requests/:id/signed", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const doc = await getSignedPdf(id);
    if (!doc) return reply.code(404).send({ error: "not_available" });
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", `inline; filename="${encodeURIComponent(doc.name)}-signed.pdf"`);
    return reply.send(doc.bytes);
  });

  // Download the Certificate of Completion.
  app.get("/api/requests/:id/certificate", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const doc = await getCertificatePdf(id);
    if (!doc) return reply.code(404).send({ error: "not_available" });
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", `inline; filename="${encodeURIComponent(doc.name)}-certificate.pdf"`);
    return reply.send(doc.bytes);
  });
}
