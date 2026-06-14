import { createHash } from "node:crypto";

/** SHA-256 hex digest of a buffer. Used for tamper-evidence on original + signed PDFs. */
export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** MD5 hex digest. Only used to round-trip-verify uploads against Google Drive's md5Checksum. */
export function md5(buffer: Buffer): string {
  return createHash("md5").update(buffer).digest("hex");
}

/**
 * Convert a Node Buffer to the `Uint8Array<ArrayBuffer>` shape Prisma's `Bytes` columns expect.
 * (Node's `Buffer` is a `Uint8Array<ArrayBufferLike>`, which the generated types reject.)
 */
export function toPrismaBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  // Allocate a fresh ArrayBuffer-backed view (not SharedArrayBuffer) and copy the bytes in,
  // so the result is exactly Uint8Array<ArrayBuffer> — the shape Prisma's Bytes columns want.
  const ab = new ArrayBuffer(buffer.byteLength);
  const copy = new Uint8Array(ab);
  copy.set(buffer);
  return copy;
}
