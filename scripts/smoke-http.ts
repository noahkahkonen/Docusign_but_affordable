/**
 * Live HTTP smoke test — exercises the real Fastify app over the wire (via inject), covering the
 * surfaces the unit/integration suites don't: the API-key guard as an HTTP preHandler, Salesforce
 * graceful-degradation (503), DB-backed readiness, portal HTML + brand injection, and clean
 * token-validation errors. No Salesforce creds needed.
 *
 * Run: BACKEND_API_KEY=... DATABASE_URL=... tsx scripts/smoke-http.ts
 */
import { buildApp } from "../src/app.js";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const VALID_BODY = {
  salesforceRecordId: "006000000000001AAA",
  salesforceObjectType: "Opportunity",
  contentVersionId: "068000000000001AAA",
  documentName: "Purchase Agreement.pdf",
  signers: [{ name: "Robert Chaykin", email: "robert@example.com", autoFields: ["SIGNATURE", "DATE"] }],
};

async function main(): Promise<void> {
  const app = await buildApp();

  // ── Liveness + readiness ──────────────────────────────────────────────
  console.log("\n[health]");
  {
    const r = await app.inject({ method: "GET", url: "/health" });
    check("GET /health is 200", r.statusCode === 200, `got ${r.statusCode}`);
    check("GET /health body status=ok", r.json().status === "ok");
  }
  {
    const r = await app.inject({ method: "GET", url: "/health/ready" });
    const body = r.json();
    check("GET /health/ready is 200", r.statusCode === 200, `got ${r.statusCode}`);
    check("readiness: database.ok=true (real DB reachable)", body.checks?.database?.ok === true, JSON.stringify(body.checks?.database));
    check("readiness: salesforceConfigured reported", typeof body.checks?.salesforceConfigured?.ok === "boolean");
    check("readiness: status is degraded (SF not configured here)", body.status === "degraded", `got ${body.status}`);
  }

  // ── Sender API auth guard (over HTTP) ─────────────────────────────────
  console.log("\n[sender API key guard]");
  {
    const r = await app.inject({ method: "POST", url: "/api/requests", payload: VALID_BODY });
    check("POST /api/requests with NO key => 401", r.statusCode === 401, `got ${r.statusCode}`);
    check("401 body does not leak key existence", r.json().message === "Invalid or missing API key");
  }
  {
    const r = await app.inject({ method: "POST", url: "/api/requests", headers: { "x-api-key": "wrong-key" }, payload: VALID_BODY });
    check("POST /api/requests with WRONG key => 401", r.statusCode === 401, `got ${r.statusCode}`);
  }
  {
    // A multi-valued header must be rejected (array-safe guard), not crash.
    const r = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { "x-api-key": [process.env.BACKEND_API_KEY!, "decoy"] as unknown as string },
      payload: VALID_BODY,
    });
    check("multi-valued x-api-key => 401 (not a crash, not bypass)", r.statusCode === 401, `got ${r.statusCode}`);
  }
  {
    // Correct key must PASS the guard. With no SF creds the download then fails — we assert it got
    // PAST auth (i.e. not 401 and not a body-validation 400), proving the guard let a valid caller through.
    const r = await app.inject({ method: "POST", url: "/api/requests", headers: { "x-api-key": process.env.BACKEND_API_KEY! }, payload: VALID_BODY });
    check("POST /api/requests with CORRECT key passes guard (not 401)", r.statusCode !== 401, `got ${r.statusCode}`);
    check("...and body was accepted (not a 400 validation error)", r.statusCode !== 400, `got ${r.statusCode}: ${r.body.slice(0, 200)}`);
    console.log(`    (post-guard status with no SF creds: ${r.statusCode})`);
  }
  {
    // Bad body with correct key => 400 (validation), proving zod error handler works over HTTP.
    const r = await app.inject({ method: "POST", url: "/api/requests", headers: { "x-api-key": process.env.BACKEND_API_KEY! }, payload: { bogus: true } });
    check("invalid body (correct key) => 400 validation error", r.statusCode === 400, `got ${r.statusCode}`);
    check("400 error shape is invalid_request", r.json().error === "invalid_request");
  }

  // ── Salesforce read routes: guarded AND graceful 503 when unconfigured ─
  console.log("\n[salesforce read-path auth + degradation]");
  {
    // No key: the api-key guard must fire BEFORE the SF-config check, so an unauthenticated caller
    // can't even learn whether SF is configured (no data/PDF-byte leak).
    const r = await app.inject({ method: "GET", url: "/api/salesforce/records/006000000000001AAA/files" });
    check("SF route with NO key => 401 (guarded, not a data leak)", r.statusCode === 401, `got ${r.statusCode}`);
    check("...and 401 fires before SF-config check (not 503)", r.json().error === "unauthorized", JSON.stringify(r.json()));
  }
  {
    const r = await app.inject({ method: "GET", url: "/api/salesforce/files/068000000000001AAA/hash", headers: { "x-api-key": "wrong-key" } });
    check("SF file-bytes route with WRONG key => 401", r.statusCode === 401, `got ${r.statusCode}`);
  }
  {
    // Authenticated but SF not configured => legible 503.
    const r = await app.inject({ method: "GET", url: "/api/salesforce/records/006000000000001AAA/files", headers: { "x-api-key": process.env.BACKEND_API_KEY! } });
    check("SF route authenticated + unconfigured => 503 (legible, not 500)", r.statusCode === 503, `got ${r.statusCode}`);
    check("503 error is salesforce_not_configured", r.json().error === "salesforce_not_configured");
  }
  {
    // /api/salesforce/status exposes integration-user identity — must also be guarded.
    const r = await app.inject({ method: "GET", url: "/api/salesforce/status" });
    check("SF /status with NO key => 401 (identity not exposed)", r.statusCode === 401, `got ${r.statusCode}`);
  }

  // ── Signer token validation (over HTTP) ───────────────────────────────
  console.log("\n[signer token validation]");
  {
    // Well-formed-but-unknown token: must be a clean client error, never a 500.
    const fakeToken = "A".repeat(43); // base64url-ish, within 20..200 length bounds
    const r = await app.inject({ method: "GET", url: `/api/sign/${fakeToken}` });
    check("GET /api/sign/<unknown-token> is not 500", r.statusCode !== 500, `got ${r.statusCode}`);
    check("GET /api/sign/<unknown-token> is a 4xx", r.statusCode >= 400 && r.statusCode < 500, `got ${r.statusCode}`);
    console.log(`    (unknown-token status: ${r.statusCode}, body: ${r.body.slice(0, 160)})`);
  }
  {
    // Too-short token: rejected by param validation (400), not a lookup.
    const r = await app.inject({ method: "GET", url: `/api/sign/short` });
    check("GET /api/sign/<too-short> => 400 param validation", r.statusCode === 400, `got ${r.statusCode}`);
  }

  // ── Portal HTML + brand injection ─────────────────────────────────────
  console.log("\n[signer portal]");
  {
    const r = await app.inject({ method: "GET", url: `/sign/${"A".repeat(43)}` });
    check("GET /sign/<token> is 200 HTML", r.statusCode === 200, `got ${r.statusCode}`);
    check("portal Content-Type is text/html", String(r.headers["content-type"]).includes("text/html"));
    check("portal brand placeholders are replaced (no {{BRAND_NAME}})", !r.body.includes("{{BRAND_NAME}}"));
    check("portal injected BRAND_NAME (InkPath)", r.body.includes("InkPath"));
  }

  await app.close();

  // ── Summary ───────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(56)}`);
  console.log(`SMOKE RESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("All HTTP smoke checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
