import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * Signer access tokens.
 *
 * A token is high-entropy (256 bits). We never store the token itself — only its SHA-256 hash (in
 * signers.access_token_hash), the same way a password hash is stored. The raw token lives only in
 * the signing link sent to the signer. Lookups hash the presented token and match the stored hash
 * via an indexed DB lookup (see signing/requests.ts).
 *
 * NOT yet single-use: a token stays valid until expiry and isn't burned on use — see the README's
 * "Known limitations" section (256-bit entropy makes guessing infeasible in the meantime).
 * `tokenMatches` below is a constant-time compare helper (used in tests); the production lookup is
 * the DB index match described above.
 */

const TOKEN_BYTES = 32; // 256 bits of entropy

export interface IssuedToken {
  token: string; // give this to the signer (in the URL) — never persisted
  tokenHash: string; // persist this
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function issueToken(): IssuedToken {
  const token = base64url(randomBytes(TOKEN_BYTES));
  return { token, tokenHash: hashToken(token) };
}

/** Constant-time comparison of a presented token against a stored hash. */
export function tokenMatches(presentedToken: string, storedHash: string): boolean {
  const presentedHash = hashToken(presentedToken);
  const a = Buffer.from(presentedHash, "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function expiryFromNow(ttlHours: number): Date {
  return new Date(Date.now() + ttlHours * 60 * 60 * 1000);
}
