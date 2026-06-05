import { prisma } from "../db/prisma.js";
import { hasSalesforceCredentials } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { toPrismaBytes } from "../lib/hash.js";
import { recordAudit } from "./audit.js";
import { buildCertificate, type CertificateInput } from "./certificate.js";
import { mergePdfs } from "./pdf.js";
import {
  uploadFileToRecord,
  upsertSignatureRequestRecord,
} from "../salesforce/writeback.js";
import type { RequestContext } from "./requests.js";

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
 * Write the signed document (with the certificate appended) + the standalone certificate back to
 * the originating Salesforce record, and upsert the Signature_Request__c mirror.
 *
 * Safe to call when Salesforce isn't configured (returns skipped) and safe to retry — uploads
 * create new file versions and the request record is upserted by external id.
 */
export async function attemptWriteback(
  requestId: string,
  ctx: RequestContext = {},
): Promise<WritebackResult> {
  if (!hasSalesforceCredentials()) {
    logger.warn({ requestId }, "Salesforce not configured — skipping write-back");
    return { ok: false, skipped: true, reason: "salesforce_not_configured" };
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
    const combined = await mergePdfs([signedBuf, certBuf]);

    const base = baseName(request.documentName);
    const signed = await uploadFileToRecord(
      request.salesforceRecordId,
      `${base} (Signed)`,
      safeFileName(`${base}-signed.pdf`),
      combined,
    );
    const certificate = await uploadFileToRecord(
      request.salesforceRecordId,
      `${base} - Certificate of Completion`,
      safeFileName(`${base}-certificate.pdf`),
      certBuf,
    );

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
      signedDocumentId: signed.contentDocumentId,
      certificateDocumentId: certificate.contentDocumentId,
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
          signedContentVersionId: signed.contentVersionId,
          certificateContentVersionId: certificate.contentVersionId,
          signatureRequestRecordId,
        },
      });
    });

    logger.info({ requestId, signatureRequestRecordId }, "Write-back to Salesforce succeeded");
    return {
      ok: true,
      signatureRequestRecordId,
      signedContentVersionId: signed.contentVersionId,
      certificateContentVersionId: certificate.contentVersionId,
    };
  } catch (err) {
    await recordAudit(prisma, {
      requestId,
      eventType: "WRITEBACK_FAILED",
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { error: (err as Error).message },
    });
    logger.error({ requestId, err }, "Write-back to Salesforce failed");
    throw err;
  }
}
