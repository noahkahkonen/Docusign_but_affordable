import { prisma } from "../db/prisma.js";
import { hasGoogleDriveCredentials, env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { sha256, md5 } from "../lib/hash.js";
import { recordAudit } from "./audit.js";
import { getDealDriveInfo, setDealDriveFolder } from "../salesforce/deal.js";
import {
  parseDriveFolderId,
  driveFolderUrl,
  findFileInFolder,
  createFolder,
  uploadFile,
  type DriveFile,
} from "../google/drive.js";
import type { RequestContext } from "./requests.js";

/**
 * Write the completed signed PDF (and certificate) into the matching deal's Google Drive folder.
 *
 * Runs AFTER and INDEPENDENTLY of the Salesforce write-back: a Drive failure is recorded as
 * DRIVE_WRITEBACK_FAILED, never breaks the Salesforce write-back or the signer response, and is
 * retryable via the same /writeback endpoint. Scoped to deals (Source_Object_Type__c =
 * TTL_Core__Deal__c) — other source objects have no deal Drive folder concept and are skipped.
 *
 * Idempotent: the folder id and each uploaded file id are persisted the moment they succeed, and a
 * re-run skips anything already done. As a second guard (e.g. if the DB record was lost) it looks
 * up an existing file of the same name in the folder before uploading, so webhook re-fires and
 * retries never create duplicates.
 */

const DEAL_OBJECT = "TTL_Core__Deal__c";

export interface DriveWritebackResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  folderId?: string;
  signedFileId?: string;
  certificateFileId?: string;
  hashVerified?: boolean;
}

/** Replace characters that are awkward/illegal in a Drive file name; keep it readable. */
function safeDriveName(name: string): string {
  return name.replace(/[/\\\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}

function baseName(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, "");
}

export async function attemptDriveWriteback(
  requestId: string,
  ctx: RequestContext = {},
): Promise<DriveWritebackResult> {
  if (!hasGoogleDriveCredentials()) {
    logger.warn({ requestId }, "Google Drive not configured — skipping Drive write-back");
    return { ok: false, skipped: true, reason: "google_drive_not_configured" };
  }

  const request = await prisma.signatureRequest.findUniqueOrThrow({ where: { id: requestId } });

  if (request.salesforceObjectType !== DEAL_OBJECT) {
    return { ok: false, skipped: true, reason: "not_a_deal" };
  }
  if (request.status !== "COMPLETED" || !request.signedPdf) {
    // Drive write-back runs after the request is finalized; nothing to push yet.
    return { ok: false, skipped: true, reason: "not_finalized" };
  }

  try {
    // 1. Resolve the deal's Drive folder — reuse the persisted id, else parse the deal's URL field,
    //    else create the folder and write its URL back to the deal.
    const deal = await getDealDriveInfo(request.salesforceRecordId);
    let folderId = request.driveFolderId ?? parseDriveFolderId(deal.driveFolderUrl);

    if (!folderId) {
      if (!env.GOOGLE_DRIVE_SHARED_DRIVE_ID) {
        throw new Error(
          "Deal has no Drive folder and GOOGLE_DRIVE_SHARED_DRIVE_ID is not set, so a folder " +
            "can't be created (a service account needs a Shared Drive to own new folders).",
        );
      }
      const created = await createFolder(`${deal.name} (Deal Files)`, env.GOOGLE_DRIVE_SHARED_DRIVE_ID);
      folderId = created.id;
      await setDealDriveFolder(request.salesforceRecordId, driveFolderUrl(folderId));
      logger.info({ requestId, folderId }, "Created deal Drive folder and wrote URL back to the deal");
    }

    if (folderId !== request.driveFolderId) {
      await prisma.signatureRequest.update({ where: { id: requestId }, data: { driveFolderId: folderId } });
    }

    // 2. Build names: "{Deal} — {Document} — SIGNED {date}.pdf" (+ " — Certificate" for the cert).
    const completedDate = (request.completedAt ?? new Date()).toISOString().slice(0, 10);
    const docBase = baseName(request.documentName);
    const signedName = safeDriveName(`${deal.name} — ${docBase} — SIGNED ${completedDate}.pdf`);
    const certName = safeDriveName(`${deal.name} — ${docBase} — SIGNED ${completedDate} — Certificate.pdf`);

    // 3. Upload the signed PDF (idempotent), verifying integrity.
    const signedBuf = Buffer.from(request.signedPdf);
    let hashVerified = true;
    if (sha256(signedBuf) !== request.docHashFinal) {
      hashVerified = false;
      logger.warn(
        { requestId, expected: request.docHashFinal, actual: sha256(signedBuf) },
        "Drive write-back: signed PDF SHA-256 does not match Final_Document_Hash__c",
      );
    }

    const signedFileId = await uploadIdempotent(
      requestId,
      folderId,
      signedName,
      signedBuf,
      request.driveSignedFileId,
      "driveSignedFileId",
    );

    // 4. Upload the certificate too (best-effort companion).
    let certificateFileId: string | undefined;
    if (request.certificatePdf) {
      certificateFileId = await uploadIdempotent(
        requestId,
        folderId,
        certName,
        Buffer.from(request.certificatePdf),
        request.driveCertificateFileId,
        "driveCertificateFileId",
      );
    }

    await recordAudit(prisma, {
      requestId,
      eventType: "DRIVE_WRITEBACK_SUCCEEDED",
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { folderId, signedFileId, certificateFileId: certificateFileId ?? null, hashVerified },
    });
    logger.info({ requestId, folderId, signedFileId }, "Google Drive write-back succeeded");
    return { ok: true, folderId, signedFileId, certificateFileId, hashVerified };
  } catch (err) {
    try {
      await recordAudit(prisma, {
        requestId,
        eventType: "DRIVE_WRITEBACK_FAILED",
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: { error: (err as Error).message },
      });
    } catch (auditErr) {
      logger.error({ requestId, auditErr }, "Failed to record DRIVE_WRITEBACK_FAILED audit event");
    }
    logger.error({ requestId, err }, "Google Drive write-back failed");
    throw err;
  }
}

/**
 * Upload `bytes` as `name` into `folderId`, returning the file id — skipping the upload if it
 * already happened. Resolution order: persisted id on the request → an existing file of the same
 * name in the folder (DB-loss recovery) → fresh upload. Verifies Drive's md5Checksum round-trips.
 */
async function uploadIdempotent(
  requestId: string,
  folderId: string,
  name: string,
  bytes: Buffer,
  persistedId: string | null,
  column: "driveSignedFileId" | "driveCertificateFileId",
): Promise<string> {
  if (persistedId) {
    logger.info({ requestId, fileId: persistedId, name }, "Drive file already uploaded — skipping");
    return persistedId;
  }

  const existing = await findFileInFolder(folderId, name);
  const file: DriveFile = existing ?? (await uploadFile(folderId, name, bytes));

  if (file.md5Checksum && file.md5Checksum !== md5(bytes)) {
    logger.warn(
      { requestId, name, expected: md5(bytes), actual: file.md5Checksum },
      "Drive write-back: uploaded file md5 does not match local bytes",
    );
  }

  await prisma.signatureRequest.update({ where: { id: requestId }, data: { [column]: file.id } });
  return file.id;
}
