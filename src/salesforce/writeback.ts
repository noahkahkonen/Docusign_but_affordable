import { salesforce } from "./client.js";
import { logger } from "../lib/logger.js";

/**
 * Writing results back to Salesforce: uploading the signed PDF + certificate as Files on the
 * source record, and mirroring request state into the Signature_Request__c custom object.
 *
 * All calls go through the JWT-authenticated jsforce connection.
 */

export interface UploadedFile {
  contentVersionId: string;
  contentDocumentId: string;
}

/**
 * Upload bytes as a new File linked to `recordId`, in two steps:
 *   1. create the ContentVersion (the file itself), then
 *   2. create a ContentDocumentLink joining it to the record.
 *
 * We deliberately avoid the FirstPublishedLocationId auto-link shortcut: that field isn't
 * resolvable in every org's API context (some orgs reject it with INVALID_FIELD), whereas the
 * explicit ContentDocumentLink works universally — it's also the pattern the Apex tests use.
 */
export async function uploadFileToRecord(
  recordId: string,
  title: string,
  fileName: string,
  bytes: Buffer,
): Promise<UploadedFile> {
  const conn = await salesforce.connection();

  // Step 1 — create the file.
  const res = await conn.sobject("ContentVersion").create({
    Title: title,
    PathOnClient: fileName,
    VersionData: bytes.toString("base64"),
  });

  if (!res.success) {
    throw new Error(`Failed to create ContentVersion: ${JSON.stringify(res.errors)}`);
  }

  // ContentDocumentId isn't returned by create; fetch it from the new version.
  const cv = (await conn
    .sobject("ContentVersion")
    .retrieve(res.id)) as unknown as { ContentDocumentId: string };

  // Step 2 — link the file to the record so it appears on the record's Files related list.
  const link = await conn.sobject("ContentDocumentLink").create({
    ContentDocumentId: cv.ContentDocumentId,
    LinkedEntityId: recordId,
    ShareType: "V",
    Visibility: "AllUsers",
  });

  if (!link.success) {
    throw new Error(`Failed to link file to record: ${JSON.stringify(link.errors)}`);
  }

  logger.info({ recordId, contentVersionId: res.id }, "Uploaded file to Salesforce record");
  return { contentVersionId: res.id, contentDocumentId: cv.ContentDocumentId };
}

// Map our internal status enum to the restricted picklist on Signature_Request__c.
const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  PARTIALLY_SIGNED: "Partially Signed",
  COMPLETED: "Completed",
  DECLINED: "Declined",
  VOIDED: "Voided",
};

export interface SignatureRequestRecord {
  backendRequestId: string;
  status: string;
  documentName: string;
  sourceRecordId: string;
  sourceObjectType: string;
  sentAt?: Date | null;
  completedAt?: Date | null;
  docHashOriginal?: string | null;
  docHashFinal?: string | null;
  signerSummary: string;
  signedDocumentId?: string | null;
  certificateDocumentId?: string | null;
}

/**
 * Create or update the Signature_Request__c mirror, keyed by the external id Backend_Request_Id__c.
 * Returns the Salesforce record Id.
 */
export async function upsertSignatureRequestRecord(
  rec: SignatureRequestRecord,
): Promise<string> {
  const conn = await salesforce.connection();

  const payload: Record<string, unknown> = {
    Backend_Request_Id__c: rec.backendRequestId,
    Status__c: STATUS_LABEL[rec.status] ?? rec.status,
    Document_Name__c: rec.documentName,
    Source_Record_Id__c: rec.sourceRecordId,
    Source_Object_Type__c: rec.sourceObjectType,
    Sent_Date__c: rec.sentAt ? new Date(rec.sentAt).toISOString() : null,
    Completed_Date__c: rec.completedAt ? new Date(rec.completedAt).toISOString() : null,
    Original_Document_Hash__c: rec.docHashOriginal ?? null,
    Final_Document_Hash__c: rec.docHashFinal ?? null,
    Signer_Summary__c: rec.signerSummary,
    Signed_Document_Id__c: rec.signedDocumentId ?? null,
    Certificate_Document_Id__c: rec.certificateDocumentId ?? null,
  };

  await conn.sobject("Signature_Request__c").upsert(payload, "Backend_Request_Id__c");

  // upsert by external id doesn't reliably return the Id, so resolve it explicitly.
  const found = await salesforce.query<{ Id: string }>(
    `SELECT Id FROM Signature_Request__c WHERE Backend_Request_Id__c = '${rec.backendRequestId}' LIMIT 1`,
  );
  const id = found[0]?.Id;
  if (!id) throw new Error("Signature_Request__c upsert did not yield a record Id");

  logger.info({ signatureRequestRecordId: id }, "Upserted Signature_Request__c");
  return id;
}
