import { salesforce } from "./client.js";

/**
 * Reading the files attached to a Salesforce record.
 *
 * Salesforce "Files" are modelled as: ContentDocument (the logical file) <- ContentDocumentLink
 * (the many-to-many tie to records/users) ; the actual bytes live on ContentVersion. A record's
 * files are found by querying ContentDocumentLink WHERE LinkedEntityId = <recordId>.
 *
 * Verified against the target org (API v60.0). Note: a single ContentDocument is often linked to
 * several entities (e.g. the record AND the uploading User); filtering by LinkedEntityId keeps us
 * to the files that actually belong to the record in question.
 */

export interface RecordFile {
  contentDocumentId: string;
  latestVersionId: string; // ContentVersion.Id to pull bytes from
  title: string;
  fileExtension: string | null;
  fileType: string | null;
  contentSize: number;
  modifiedDate: string; // ISO 8601
  isPdf: boolean; // signing engine currently requires PDF input
}

// Salesforce Ids are 15 or 18 char alphanumeric. Validate before string-interpolating into SOQL.
const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

/** True if `id` is a syntactically valid Salesforce record Id (15 or 18 char alphanumeric). */
export function isSalesforceId(id: string): boolean {
  return SF_ID_RE.test(id);
}

function assertSalesforceId(id: string): void {
  if (!isSalesforceId(id)) {
    throw new Error(`"${id}" is not a valid Salesforce record Id`);
  }
}

interface ContentDocumentLinkRow {
  ContentDocumentId: string;
  ContentDocument: {
    Title: string;
    LatestPublishedVersionId: string;
    FileExtension: string | null;
    FileType: string | null;
    ContentSize: number;
    ContentModifiedDate: string;
  } | null;
}

/**
 * List every file linked to a record, newest first. The first element is the "most recent"
 * file the UI defaults to; the rest let the user pick a different one.
 */
export async function listRecordFiles(recordId: string): Promise<RecordFile[]> {
  assertSalesforceId(recordId);

  const soql = `
    SELECT ContentDocumentId,
           ContentDocument.Title,
           ContentDocument.LatestPublishedVersionId,
           ContentDocument.FileExtension,
           ContentDocument.FileType,
           ContentDocument.ContentSize,
           ContentDocument.ContentModifiedDate
    FROM ContentDocumentLink
    WHERE LinkedEntityId = '${recordId}'
    ORDER BY ContentDocument.ContentModifiedDate DESC
  `;

  const rows = await salesforce.query<ContentDocumentLinkRow>(soql);

  return rows
    .filter((r): r is ContentDocumentLinkRow & { ContentDocument: NonNullable<ContentDocumentLinkRow["ContentDocument"]> } => r.ContentDocument != null)
    .map((r) => {
      const cd = r.ContentDocument;
      const ext = cd.FileExtension?.toLowerCase() ?? null;
      return {
        contentDocumentId: r.ContentDocumentId,
        latestVersionId: cd.LatestPublishedVersionId,
        title: cd.Title,
        fileExtension: ext,
        fileType: cd.FileType,
        contentSize: cd.ContentSize,
        modifiedDate: cd.ContentModifiedDate,
        isPdf: ext === "pdf",
      };
    });
}

/** The single most-recently-modified file on a record, or null if it has none. */
export async function getLatestRecordFile(recordId: string): Promise<RecordFile | null> {
  const files = await listRecordFiles(recordId);
  return files[0] ?? null;
}

/** Download the raw bytes of a specific ContentVersion. */
export async function downloadFileBytes(contentVersionId: string): Promise<Buffer> {
  assertSalesforceId(contentVersionId);
  return salesforce.downloadContentVersion(contentVersionId);
}
