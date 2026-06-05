import { createSign } from "node:crypto";
import { env, hasSalesforceCredentials } from "../config/env.js";
import { logger } from "../lib/logger.js";

/**
 * Salesforce OAuth 2.0 JWT Bearer flow.
 *
 * We build and RS256-sign a JWT assertion with the Connected App's private key, then POST it
 * to the token endpoint to receive a short-lived access token + instance URL. No password is
 * ever stored or transmitted. Docs: Salesforce "OAuth 2.0 JWT Bearer Flow".
 *
 * The assertion is signed locally with node:crypto so we don't depend on a JWT library.
 */

export interface SalesforceToken {
  accessToken: string;
  instanceUrl: string;
  issuedAt: number; // epoch ms
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildSignedAssertion(): string {
  // Audience must match the login host the Connected App trusts.
  const audience = env.SF_LOGIN_URL;
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: env.SF_CLIENT_ID, // Connected App consumer key
    sub: env.SF_USERNAME, // integration user to impersonate
    aud: audience,
    exp: now + 3 * 60, // 3 minutes; Salesforce requires <= 5
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(claims),
  )}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(env.SF_PRIVATE_KEY as string);

  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Exchange a signed JWT assertion for an access token. Throws on any failure with the
 * Salesforce error surfaced (these are notoriously terse — e.g. "invalid_grant: user hasn't
 * approved this consumer" usually means the integration user isn't pre-authorized).
 */
export async function requestAccessToken(): Promise<SalesforceToken> {
  if (!hasSalesforceCredentials()) {
    throw new Error(
      "Salesforce credentials are not configured (SF_CLIENT_ID, SF_USERNAME, SF_PRIVATE_KEY). " +
        "Set them in the environment to enable Salesforce access.",
    );
  }

  const assertion = buildSignedAssertion();
  const tokenUrl = `${env.SF_LOGIN_URL}/services/oauth2/token`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Salesforce token endpoint returned non-JSON (${res.status}): ${text}`);
  }

  if (!res.ok) {
    const err = json.error ?? "unknown_error";
    const desc = json.error_description ?? text;
    throw new Error(`Salesforce JWT auth failed: ${err} — ${desc}`);
  }

  logger.debug({ instanceUrl: json.instance_url }, "Obtained Salesforce access token");

  return {
    accessToken: json.access_token as string,
    instanceUrl: json.instance_url as string,
    issuedAt: Date.now(),
  };
}
