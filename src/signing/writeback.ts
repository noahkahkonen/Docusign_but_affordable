import { prisma } from "../db/prisma.js";
import { hasSalesforceCredentials } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { sha256, toPrismaBytes } from "../lib/hash.js";
import { recordAudit } from "./audit.js";
import { buildCertificate, type CertificateInput } from "./certificate.js";
import { flattenFields, type FieldPlacement } from "./pdf.js";
import {
  uploadFileToRecord,
  upsertSignatureRequestRecord,
} from "../salesforce/writeback.js";
import type { RequestContext } from "./requests.js";

/**
 * Flatten all filled fields into the source PDF, hash it, and persist signedPdf + docHashFinal
 * with the COMPLETED audit event. Idempotent: a request whose signedPdf already exists is left
 * untouched, so this doubles as crash recovery — if the process died between the COMPLETED
 * status election and the flatten, the write-back retry endpoint re-runs this and heals the
 * request. Only call once the request status is COMPLETED (the caller owns that election).
 */
export async function finalizeCompletion(
  requestId: string,
  ctx: RequestContext = {},
): Promise<void> {
  const request = await prisma.signatureRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { fields: true },
  });
  if (request.signedPdf) return; // already finalized
  if (request.status !== "COMPLETED") {
    throw new Error(`Request ${requestId} is ${request.status}; cannot finalize an incomplete request`);
  }
  if (!request.originalPdf) throw new Error("Source document missing; cannot complete");

  const placements: FieldPlacement[] = request.fields
    .filter((f) => f.value != null && f.value !== "")
    .map((f) => ({
      type: f.type as FieldPlacement["type"],
      pageIndex: f.pageIndex,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      value: f.value as string,
    }));

  const signedPdf = await flattenFields(Buffer.from(request.originalPdf), placements);
  const docHashFinal = sha256(signedPdf);

  await prisma.$transaction(async (tx) => {
    await tx.signatureRequest.update({
      where: { id: requestId },
      data: { signedPdf: toPrismaBytes(signedPdf), docHashFinal },
    });
    await recordAudit(tx, {
      requestId,
      eventType: "COMPLETED",
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { docHashFinal },
    });
  });

  logger.info({ requestId, docHashFinal }, "Signature request finalized (flattened + hashed)");
}

/** Strip a trailing extension so we can append " (Signed)" cleanly. */
function baseName(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, "");
}

function safeFileName(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 120);
}

/**
 * Build the Certificate of Completion from stored request data and persist it
 * (signatureRequest.certificatePdf). Returns the certificate bytes.
 */
export async function generateCertificate(requestId: string): Promise<Buffer> {
  const request = await prisma.signatureRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: {
      signers: { orderBy: { createdAt: "asc" } },
      auditEvents: { orderBy: { occurredAt: "asc" } },
    },
  });

  const signerNameById = new Map(request.signers.map((s) => [s.id, s.name]));

  const input: CertificateInput = {
    documentName: request.documentName,
    requestId: request.id,
    status: request.status,
    docHashOriginal: request.docHashOriginal,
    docHashFinal: request.docHashFinal,
    createdAt: request.createdAt,
    sentAt: request.sentAt,
    completedAt: request.completedAt,
    signers: request.signers.map((s) => ({
      name: s.name,
      email: s.email,
      entityLabel: s.entityLabel,
      authMethod: s.authMethod,
      consentedAt: s.consentedAt,
      consentIp: s.consentIp,
      signedAt: s.signedAt,
    })),
    events: request.auditEvents.map((e) => ({
      occurredAt: e.occurredAt,
      eventType: e.eventType,
      signerName: e.signerId ? signerNameById.get(e.signerId) ?? null : null,
      ipAddress: e.ipAddress,
    })),
  };

  const certificate = await buildCertificate(input);
  await prisma.signatureRequest.update({
    where: { id: requestId },
    data: { certificatePdf: toPrismaBytes(certificate) },
  });
  return certificate;
}

function buildSignerSummary(
  signers: { name: string; email: string; entityLabel: string | null; status: string; signedAt: Date | null }[],
): string {
  return signers
    .map((s) => {
      const entity = s.entityLabel ? ` (${s.entityLabel})` : "";
      const when = s.signedAt ? ` signed ${new Date(s.signedAt).toISOString()}` : "";
      return `• ${s.name}${entity} <${s.email}> — ${s.status}${when}`;
    })
    .join("\n");
}

export interface WritebackResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  signatureRequestRecordId?: string;
  signedContentVersionId?: string;
  certificateContentVersionId?: string;
}

/**
 * Write the signed document + the Certificate of Completion back to the originating Salesforce
 * record as two separate Files, and upsert the Signature_Request__c mirror.
 *
 * The "(Signed)" file is the standalone flattened signed PDF, so its SHA-256 equals the stored
 * docHashFinal (Final_Document_Hash__c) — i.e. the hash on the record and printed on the
 * certificate verifies the exact bytes a recipient downloads. The certificate is uploaded
 * alongside it as its own file.
 *
 * Safe to call when Salesforce isn't configured (returns skipped), and IDEMPOTENT on retry:
 * each upload's ContentDocumentId is persisted the moment it succeeds, and a re-run skips any
 * upload that already landed — a partial failure resumes instead of duplicating Files on the
 * record. It also self-heals: a request that was elected COMPLETED but crashed before
 * flattening (or before the certificate was generated) is finalized here first.
 */
export async function attemptWriteback(
  requestId: string,
  ctx: RequestContext = {},
): Promise<WritebackResult> {
  if (!hasSalesforceCredentials()) {
    logger.warn({ requestId }, "Salesforce not configured — skipping write-back");
    return { ok: false, skipped: true, reason: "salesforce_not_configured" };
  }

  // Crash recovery: regenerate the signed PDF and certificate if a previous attempt died
  // between the COMPLETED election and producing the artifacts. Both are idempotent no-ops
  // when the artifacts already exist.
  await finalizeCompletion(requestId, ctx);
  {
    const probe = await prisma.signatureRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { certificatePdf: true },
    });
    if (!probe.certificatePdf) await generateCertificate(requestId);
  }

  const request = await prisma.signatureRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { signers: { orderBy: { createdAt: "asc" } } },
  });

  if (!request.signedPdf || !request.certificatePdf) {
    throw new Error("Signed PDF or certificate is missing; cannot write back");
  }

  try {
    const signedBuf = Buffer.from(request.signedPdf);
    const certBuf = Buffer.from(request.certificatePdf);
    const base = baseName(request.documentName);

    // Upload the standalone flattened signed PDF (NOT signed+cert merged) so re-hashing the
    // delivered file reproduces docHashFinal / Final_Document_Hash__c. Skip anything a prior
    // attempt already uploaded; persist each id immediately so a crash mid-way resumes.
    let signedContentDocumentId = request.signedContentDocumentId;
    let signedContentVersionId: string | undefined;
    if (!signedContentDocumentId) {
      const signed = await uploadFileToRecord(
        request.salesforceRecordId,
        `${base} (Signed)`,
        safeFileName(`${base}-signed.pdf`),
        signedBuf,
      );
      signedContentDocumentId = signed.contentDocumentId;
      signedContentVersionId = signed.contentVersionId;
      await prisma.signatureRequest.update({
        where: { id: requestId },
        data: { signedContentDocumentId },
      });
    } else {
      logger.info({ requestId, signedContentDocumentId }, "Signed PDF already uploaded — skipping");
    }

    let certificateContentDocumentId = request.certificateContentDocumentId;
    let certificateContentVersionId: string | undefined;
    if (!certificateContentDocumentId) {
      const certificate = await uploadFileToRecord(
        request.salesforceRecordId,
        `${base} - Certificate of Completion`,
        safeFileName(`${base}-certificate.pdf`),
        certBuf,
      );
      certificateContentDocumentId = certificate.contentDocumentId;
      certificateContentVersionId = certificate.contentVersionId;
      await prisma.signatureRequest.update({
        where: { id: requestId },
        data: { certificateContentDocumentId },
      });
    } else {
      logger.info(
        { requestId, certificateContentDocumentId },
        "Certificate already uploaded — skipping",
      );
    }

    const signatureRequestRecordId = await upsertSignatureRequestRecord({
      backendRequestId: request.id,
      status: request.status,
      documentName: request.documentName,
      sourceRecordId: request.salesforceRecordId,
      sourceObjectType: request.salesforceObjectType,
      sentAt: request.sentAt,
      completedAt: request.completedAt,
      docHashOriginal: request.docHashOriginal,
      docHashFinal: request.docHashFinal,
      signerSummary: buildSignerSummary(request.signers),
      signedDocumentId: signedContentDocumentId,
      certificateDocumentId: certificateContentDocumentId,
    });

    await prisma.$transaction(async (tx) => {
      await tx.signatureRequest.update({
        where: { id: requestId },
        data: { salesforceRequestRecordId: signatureRequestRecordId },
      });
      await recordAudit(tx, {
        requestId,
        eventType: "WRITEBACK_SUCCEEDED",
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: {
          signedContentDocumentId,
          certificateContentDocumentId,
          ...(signedContentVersionId ? { signedContentVersionId } : {}),
          ...(certificateContentVersionId ? { certificateContentVersionId } : {}),
          signatureRequestRecordId,
        },
      });
    });

    logger.info({ requestId, signatureRequestRecordId }, "Write-back to Salesforce succeeded");
    return {
      ok: true,
      signatureRequestRecordId,
      signedContentVersionId,
      certificateContentVersionId,
    };
  } catch (err) {
    // Record the failure for auditability/retry discovery — but never let the audit write
    // mask the original error (e.g. when the DB itself is the thing failing).
    try {
      await recordAudit(prisma, {
        requestId,
        eventType: "WRITEBACK_FAILED",
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: { error: (err as Error).message },
      });
    } catch (auditErr) {
      logger.error({ requestId, auditErr }, "Failed to record WRITEBACK_FAILED audit event");
    }
    logger.error({ requestId, err }, "Write-back to Salesforce failed");
    throw err;
  }
}
