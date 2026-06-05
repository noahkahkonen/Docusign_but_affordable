import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasSalesforceCredentials } from "../config/env.js";
import { salesforce } from "../salesforce/client.js";
import {
  listRecordFiles,
  getLatestRecordFile,
  downloadFileBytes,
} from "../salesforce/files.js";
import { sha256 } from "../lib/hash.js";

const recordParams = z.object({ recordId: z.string().min(15).max(18) });
const fileParams = z.object({ contentVersionId: z.string().min(15).max(18) });

/**
 * M1 read-path routes. These prove the data flow end-to-end: from a Salesforce record Id to
 * the latest attached file's bytes (and its hash) — no signing yet.
 *
 * Every handler requires Salesforce to be configured; we return a clear 503 otherwise so a
 * half-provisioned environment fails legibly.
 */
export async function salesforceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (_req, reply) => {
    if (!hasSalesforceCredentials()) {
      reply.code(503).send({
        error: "salesforce_not_configured",
        message:
          "Salesforce credentials are not set. Configure SF_CLIENT_ID, SF_USERNAME and SF_PRIVATE_KEY.",
      });
    }
  });

  // Identity / connectivity probe.
  app.get("/api/salesforce/status", async () => {
    const who = await salesforce.whoami();
    return { connected: true, ...who };
  });

  // All files on a record, newest first.
  app.get("/api/salesforce/records/:recordId/files", async (req) => {
    const { recordId } = recordParams.parse(req.params);
    const files = await listRecordFiles(recordId);
    return { recordId, count: files.length, files };
  });

  // Just the most-recent file (what the "Send for Signature" button defaults to).
  app.get("/api/salesforce/records/:recordId/files/latest", async (req, reply) => {
    const { recordId } = recordParams.parse(req.params);
    const file = await getLatestRecordFile(recordId);
    if (!file) {
      return reply.code(404).send({
        error: "no_files",
        message: `Record ${recordId} has no attached files.`,
      });
    }
    return file;
  });

  // Download + hash a file without returning the (potentially large) bytes over JSON.
  // Confirms the binary download path and produces the original-document SHA-256.
  app.get("/api/salesforce/files/:contentVersionId/hash", async (req) => {
    const { contentVersionId } = fileParams.parse(req.params);
    const bytes = await downloadFileBytes(contentVersionId);
    return {
      contentVersionId,
      byteLength: bytes.length,
      sha256: sha256(bytes),
    };
  });
}
