import { createSign } from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

/**
 * Google service-account OAuth 2.0 (JWT bearer) — the same shape as the Salesforce JWT flow in
 * salesforce/auth.ts, hand-rolled with node:crypto so we don't pull in the heavyweight googleapis
 * SDK for what is two REST endpoints.
 *
 * We sign a JWT assertion with the service account's private key, scoped to Drive, and exchange it
 * at the token endpoint for a short-lived access token. The raw key never leaves this module.
 */

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

let cachedAccount: ServiceAccount | null = null;
let cachedToken: { accessToken: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Parse GOOGLE_SERVICE_ACCOUNT_KEY, which may be the raw service-account JSON or its base64
 * encoding (base64 is friendlier for a single-line Heroku config var). PEM newlines escaped as
 * "\n" (common when the key is embedded in JSON inside an env var) are restored.
 */
function loadServiceAccount(): ServiceAccount {
  if (cachedAccount) return cachedAccount;
  const raw = env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not configured");

  const text = raw.trim().startsWith("{")
    ? raw
    : Buffer.from(raw, "base64").toString("utf8");

  let json: { client_email?: string; private_key?: string; token_uri?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is neither valid JSON nor base64-encoded JSON");
  }
  if (!json.client_email || !json.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is missing client_email or private_key");
  }

  cachedAccount = {
    clientEmail: json.client_email,
    privateKey: json.private_key.includes("\\n")
      ? json.private_key.replace(/\\n/g, "\n")
      : json.private_key,
    tokenUri: json.token_uri || DEFAULT_TOKEN_URI,
  };
  return cachedAccount;
}

function buildSignedAssertion(account: ServiceAccount): string {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, string | number> = {
    iss: account.clientEmail,
    scope: DRIVE_SCOPE,
    aud: account.tokenUri,
    iat: now,
    exp: now + 3600,
  };
  // Domain-wide delegation: impersonate a Workspace user (e.g. when folders live in My Drive).
  if (env.GOOGLE_DRIVE_SUBJECT) claims.sub = env.GOOGLE_DRIVE_SUBJECT;

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(account.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

async function requestAccessToken(): Promise<string> {
  const account = loadServiceAccount();
  const assertion = buildSignedAssertion(account);

  const res = await fetch(account.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const text = await res.text();
  let json: { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Google token endpoint returned non-JSON (${res.status}): ${text}`);
  }
  if (!res.ok || !json.access_token) {
    throw new Error(`Google JWT auth failed: ${json.error ?? "unknown"} — ${json.error_description ?? text}`);
  }

  const expiresInMs = (json.expires_in ?? 3600) * 1000;
  cachedToken = { accessToken: json.access_token, expiresAt: Date.now() + expiresInMs };
  logger.debug("Obtained Google Drive access token");
  return json.access_token;
}

/** A valid Drive access token, refreshed ~1 min before expiry. Collapses concurrent callers. */
export async function getDriveAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.accessToken;
  }
  if (!inflight) {
    inflight = requestAccessToken().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** Test seam: clear cached account + token so reconfigured env / mocks take effect. */
export function resetGoogleAuthForTests(): void {
  cachedAccount = null;
  cachedToken = null;
  inflight = null;
}
