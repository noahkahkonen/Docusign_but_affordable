import jsforce from "jsforce";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { requestAccessToken, type SalesforceToken } from "./auth.js";

/**
 * Thin wrapper around a jsforce Connection that:
 *  - lazily authenticates via the JWT bearer flow,
 *  - caches the token and refreshes it shortly before the engine assumes it could expire,
 *  - exposes typed query + binary-download helpers used by the rest of the app.
 *
 * Access tokens from the JWT flow have no refresh token; we simply re-mint when needed.
 */

// Re-mint a token if it's older than this. Salesforce session timeouts vary by org; 30 min
// is comfortably inside the default and cheap to refresh.
const TOKEN_MAX_AGE_MS = 30 * 60 * 1000;

class SalesforceClient {
  private token: SalesforceToken | null = null;
  private inflight: Promise<SalesforceToken> | null = null;

  private async getToken(): Promise<SalesforceToken> {
    const fresh =
      this.token && Date.now() - this.token.issuedAt < TOKEN_MAX_AGE_MS;
    if (fresh) return this.token as SalesforceToken;

    // Collapse concurrent callers onto a single auth request.
    if (!this.inflight) {
      this.inflight = requestAccessToken()
        .then((t) => {
          this.token = t;
          return t;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  /** A jsforce Connection bound to the current access token + instance URL. */
  async connection(): Promise<jsforce.Connection> {
    const token = await this.getToken();
    return new jsforce.Connection({
      instanceUrl: token.instanceUrl,
      accessToken: token.accessToken,
      version: env.SF_API_VERSION,
    });
  }

  /** Run a SOQL query and return typed records. */
  async query<T = Record<string, unknown>>(soql: string): Promise<T[]> {
    const conn = await this.connection();
    logger.debug({ soql }, "Running SOQL query");
    // jsforce's query generic carries its own Record constraint; we keep our caller-facing
    // generic unconstrained and assert the shape we expect from the SOQL.
    const result = await conn.query(soql);
    return result.records as T[];
  }

  /**
   * Download the binary contents of a ContentVersion (the actual file bytes).
   * jsforce's typed helpers don't cleanly return a Buffer for blob fields, so we hit the
   * REST blob endpoint directly with the bearer token — the most reliable path for binaries.
   */
  async downloadContentVersion(contentVersionId: string): Promise<Buffer> {
    const token = await this.getToken();
    const url = `${token.instanceUrl}/services/data/v${env.SF_API_VERSION}/sobjects/ContentVersion/${contentVersionId}/VersionData`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Failed to download ContentVersion ${contentVersionId}: ${res.status} ${detail}`,
      );
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /** Cheap connectivity/identity probe. Returns the org/user identity. */
  async whoami(): Promise<{ userId: string; organizationId: string; instanceUrl: string }> {
    const conn = await this.connection();
    const id = await conn.identity();
    return {
      userId: id.user_id,
      organizationId: id.organization_id,
      instanceUrl: conn.instanceUrl,
    };
  }
}

// One shared client for the process.
export const salesforce = new SalesforceClient();
