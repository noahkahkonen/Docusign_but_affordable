import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import {
  createSignatureRequest,
  sendSignatureRequest,
  getRequestStatus,
} from "../signing/requests.js";

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
      }),
    )
    .min(1),
  fields: z.array(fieldSchema).default([]),
});

function requireApiKey(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!env.BACKEND_API_KEY) return true; // dev mode, guard disabled (warned at boot)
  const presented = req.headers["x-api-key"];
  if (presented !== env.BACKEND_API_KEY) {
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
}
