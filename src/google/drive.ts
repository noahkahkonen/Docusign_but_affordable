import { getDriveAccessToken } from "./auth.js";
import { logger } from "../lib/logger.js";

/**
 * Minimal Google Drive v3 client over fetch. Covers exactly what the deal write-back needs:
 * parse a folder link, find an existing file by name, create a folder, and upload a file —
 * all Shared-Drive aware (supportsAllDrives / includeItemsFromAllDrives).
 */

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

export interface DriveFile {
  id: string;
  name: string;
  md5Checksum?: string | null;
  size?: string | null;
}

/**
 * Extract the folder id from a Google Drive folder URL such as
 * https://drive.google.com/drive/folders/{id} (with or without /u/N/, query string, or trailing
 * slash). Accepts a bare id too. Returns null if nothing folder-like is present.
 */
export function parseDriveFolderId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const m = /\/folders\/([A-Za-z0-9_-]+)/.exec(trimmed);
  if (m) return m[1];
  // Bare id (Drive ids are URL-safe base64-ish, comfortably 10+ chars and contain no slashes).
  if (/^[A-Za-z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  return null;
}

/** Canonical browser URL for a Drive folder id. */
export function driveFolderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getDriveAccessToken();
  return { Authorization: `Bearer ${token}` };
}

async function failure(res: Response, action: string): Promise<never> {
  const detail = await res.text().catch(() => "");
  throw new Error(`Google Drive ${action} failed: ${res.status} ${detail}`);
}

/** Find a non-trashed file with an exact name inside a folder, or null. */
export async function findFileInFolder(folderId: string, name: string): Promise<DriveFile | null> {
  const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q = `name = '${escaped}' and '${folderId}' in parents and trashed = false`;
  const params = new URLSearchParams({
    q,
    fields: "files(id,name,md5Checksum,size)",
    pageSize: "10",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const res = await fetch(`${API}/files?${params}`, { headers: await authHeaders() });
  if (!res.ok) await failure(res, "list");
  const json = (await res.json()) as { files?: DriveFile[] };
  return json.files?.[0] ?? null;
}

/** Create a folder under `parentId` (a Shared Drive id or a folder id) and return its id. */
export async function createFolder(name: string, parentId: string): Promise<DriveFile> {
  const params = new URLSearchParams({ fields: "id,name", supportsAllDrives: "true" });
  const res = await fetch(`${API}/files?${params}`, {
    method: "POST",
    headers: { ...(await authHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  if (!res.ok) await failure(res, "create folder");
  return (await res.json()) as DriveFile;
}

/**
 * Upload bytes as a new file in `folderId` via a multipart/related request, returning the file's
 * id + md5Checksum (used to verify the bytes landed intact).
 */
export async function uploadFile(
  folderId: string,
  name: string,
  bytes: Buffer,
  mimeType = "application/pdf",
): Promise<DriveFile> {
  const boundary = `inkpath-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({ name, parents: [folderId] });

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const params = new URLSearchParams({
    uploadType: "multipart",
    supportsAllDrives: "true",
    fields: "id,name,md5Checksum,size",
  });
  const res = await fetch(`${UPLOAD_API}/files?${params}`, {
    method: "POST",
    headers: {
      ...(await authHeaders()),
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) await failure(res, "upload");
  const file = (await res.json()) as DriveFile;
  logger.info({ folderId, fileId: file.id, name }, "Uploaded file to Google Drive");
  return file;
}
