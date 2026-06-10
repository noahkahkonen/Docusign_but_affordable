import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { registerApiKeyGuard } from "../lib/api-key-guard.js";
import {
  createSignatureRequest,
  createRequestFromDeal,
  sendSignatureRequest,
  resendSignatureRequest,
  getRequestStatus,
  getSignedPdf,
  getCertificatePdf,
} from "../signing/requests.js";
import { attemptWriteback } from "../signing/writeback.js";

/**
 * Sender/admin API — used by the Salesforce LWC (via Named Credential) to create and send
 * signature requests, and to read status. Guarded by the shared x-api-key secret (BACKEND_API_KEY)
 * via registerApiKeyGuard. In dev with no key set, the guard is disabled and we warn once at boot.
 */

// Coordinates must be finite (z.number() rejects NaN but ACCEPTS Infinity — a poison value that
// would corrupt the final flatten) and arrays bounded against DB/CPU abuse.
const coord = z.number().finite();
const dimension = z.number().finite().positive().max(20000);

const fieldSchema = z.object({
  signerIndex: z.number().int().nonnegative(),
  type: z.enum(["SIGNATURE", "INITIALS", "DATE", "TEXT"]),
  label: z.string().max(255).optional(),
  required: z.boolean().optional(),
  pageIndex: z.number().int().nonnegative(),
  x: coord,
  y: coord,
  width: dimension,
  height: dimension,
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
        // CRE party this signer represents; omit for ad-hoc signers on custom documents.
        role: z.enum(["BUYER", "SELLER", "TENANT", "LANDLORD", "OTHER"]).optional(),
        // Field types to auto-place for this signer (the LWC sends these instead of x/y boxes).
        autoFields: z.array(fieldType).max(10).optional(),
      }),
    )
    .min(1)
    .max(50),
  fields: z.array(fieldSchema).max(500).default([]),
  // When true, create an empty DRAFT to be configured in the browser placement page (no fields
  // or autoFields required up front).
  prepare: z.boolean().optional(),
});

const fromDealSchema = z.object({
  salesforceRecordId: z.string().min(15).max(18),
  salesforceObjectType: z.string().min(1).max(80),
  contentVersionId: z.string().min(15).max(18),
  documentName: z.string().min(1).max(255),
  // Tolerant of null/empty (e.g. a stale caller that doesn't send it) — treat as "no key".
  documentType: z.string().max(120).nullish().transform((v) => v || undefined),
});

export async function requestRoutes(app: FastifyInstance): Promise<void> {
  registerApiKeyGuard(app);

  // Create a DRAFT request from a Salesforce file + signers + field placements.
  app.post("/api/requests", async (req, reply) => {
    const body = createSchema.parse(req.body);
    const result = await createSignatureRequest(body);
    // The sender opens this to place fields in the browser (then send from there).
    const prepareUrl = `${env.APP_BASE_URL}/prepare/${result.prepareToken}`;
    return reply.code(201).send({ ...result, prepareUrl });
  });

  // Create a draft by ROUTING: derive the signers from the Deal's record type + party contacts.
  // The caller supplies only the deal + document; who-signs is computed from the routing matrix.
  app.post("/api/requests/from-deal", async (req, reply) => {
    const body = fromDealSchema.parse(req.body);
    const result = await createRequestFromDeal(body);
    const prepareUrl = `${env.APP_BASE_URL}/prepare/${result.prepareToken}`;
    return reply.code(201).send({ ...result, prepareUrl });
  });

  // Mint signer tokens and move to SENT. Returns the per-signer signing links.
  app.post("/api/requests/:id/send", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const links = await sendSignatureRequest(id);
    return { requestId: id, links };
  });

  // Re-mint links for unsigned signers and re-email them (missed/expired invitation).
  app.post("/api/requests/:id/resend", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const links = await resendSignatureRequest(id);
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
