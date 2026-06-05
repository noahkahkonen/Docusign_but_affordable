import { createHash } from "node:crypto";

/** SHA-256 hex digest of a buffer. Used for tamper-evidence on original + signed PDFs. */
export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
