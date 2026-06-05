import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  getSignerContext,
  getSignerDocument,
  recordSignerConsent,
  submitSignerFields,
  declineSignature,
  type RequestContext,
} from "../signing/requests.js";

/**
 * Signer-facing API — authenticated solely by the high-entropy token in the URL (not yet single-
 * use; see README "Known limitations"). No Salesforce login. Every handler captures IP +
 * user-agent for the audit trail.
 */

const tokenParams = z.object({ token: z.string().min(20).max(200) });

const submitSchema = z.object({
  values: z
    .array(z.object({ fieldId: z.string().uuid(), value: z.string().min(1) }))
    .default([]),
});

const declineSchema = z.object({ reason: z.string().max(1000).optional() });

function ctxOf(req: FastifyRequest): RequestContext {
  return { ip: req.ip, userAgent: req.headers["user-agent"] };
}

export async function signingRoutes(app: FastifyInstance): Promise<void> {
  // Everything the portal needs to render the signing experience for this token.
  app.get("/api/sign/:token", async (req) => {
    const { token } = tokenParams.parse(req.params);
    return getSignerContext(token, ctxOf(req));
  });

  // The source PDF bytes for this token (the portal renders them with pdf.js).
  app.get("/api/sign/:token/document", async (req, reply) => {
    const { token } = tokenParams.parse(req.params);
    const pdf = await getSignerDocument(token);
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", "inline; filename=document.pdf");
    return reply.send(pdf);
  });

  // Affirmative ESIGN/UETA consent. Must happen before submit.
  app.post("/api/sign/:token/consent", async (req) => {
    const { token } = tokenParams.parse(req.params);
    return recordSignerConsent(token, ctxOf(req));
  });

  // Submit field values and sign.
  app.post("/api/sign/:token/submit", async (req) => {
    const { token } = tokenParams.parse(req.params);
    const { values } = submitSchema.parse(req.body);
    return submitSignerFields(token, values, ctxOf(req));
  });

  // Decline to sign.
  app.post("/api/sign/:token/decline", async (req) => {
    const { token } = tokenParams.parse(req.params);
    const { reason } = declineSchema.parse(req.body);
    return declineSignature(token, reason, ctxOf(req));
  });
}
