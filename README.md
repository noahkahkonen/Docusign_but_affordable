# InkPath — affordable e-signatures for Salesforce CRE

InkPath sends a document attached to a Salesforce record out for electronic signature, then
writes the signed PDF and a tamper-evident audit certificate back to that record. It targets
alignment with the U.S. **ESIGN Act** and **UETA** so the audit trail and signer legitimacy are
first-class, not afterthoughts.

> ⚖️ **Not legal advice.** InkPath implements ESIGN/UETA-aligned features (electronic-records
> consent, intent-to-sign, attribution, an immutable audit trail, and document hashing). It does
> **not** guarantee enforceability of any specific instrument. Some CRE documents may have
> state-specific, notarization, or Remote Online Notarization (RON) requirements that are **out of
> scope for v1**. Have counsel review your use.

## Architecture (hybrid)

| Layer | Tech | Role |
| --- | --- | --- |
| **Salesforce** | LWC + Apex (SFDX), `Signature_Request__c` custom object, Named Credential | "Send for Signature" button, status display, write-back target |
| **Backend** | Node + TypeScript, **Fastify**, Prisma + **Postgres**, jsforce | Auth to Salesforce, read the latest file, run the signing engine, capture audit, write back |
| **Signer portal** | React/Next (M2) | Public, tokenized signing page — no Salesforce login for external signers |

Hosting target: **Heroku** (Heroku Postgres). PDFs are stored in Postgres for v1 (swappable to S3).

### Why hybrid (not fully Salesforce-native)
PDF field placement and an external, no-login signing UX are painful in pure Apex/Experience
Cloud. The backend owns PDF manipulation (pdf-lib) and the public portal; Salesforce owns the
trigger and the record of truth. Secrets never live in Salesforce code — the SF↔backend hop goes
through a **Named Credential**, and the backend authenticates to Salesforce via the **OAuth 2.0
JWT bearer flow** (no stored passwords).

## Repository layout

```
.
├── src/                  # Fastify backend (TypeScript)
│   ├── config/env.ts     # validated configuration (single source of truth)
│   ├── salesforce/       # JWT auth, jsforce client, Files read-path
│   ├── signing/          # engine: lifecycle, pdf, tokens, consent, audit, certificate, write-back
│   ├── routes/           # health, read-path, sender API, signer API, portal
│   ├── lib/              # logger, hashing
│   └── server.ts         # bootstrap
├── public/portal.html    # self-contained signer portal (pdf.js + draw/type signature)
├── prisma/               # data model + migrations
├── scripts/              # check-read-path.ts (M1 acceptance script)
├── salesforce/           # SFDX project: Signature_Request__c object + fields
├── test/                 # Vitest (unit + an end-to-end signing-flow integration test)
├── legacy/               # the original v0.1 SQLite sketch, kept for reference only
├── Procfile  app.json    # Heroku deploy
└── .env.example          # config contract
```

## Data model (multi-signer + flexible fields)

Signers are **independent and parallel by default** — there is no enforced buyer→seller→broker
sequence. Multiple signers can represent **one entity** (e.g. two officers of one LLC), grouped by
`entityLabel`. Fields are flexible: `SIGNATURE | INITIALS | DATE | TEXT`, each assigned to a
signer — the `TEXT` type covers free-entry boxes like a **Title** ("CEO"). Every meaningful action
is written to an immutable `audit_events` row.

Backend tables: `signature_requests` (envelope) · `signers` · `fields` · `audit_events`.
Salesforce mirror: `Signature_Request__c` (status, hashes, signed/cert document ids, source record
linkage via `Source_Record_Id__c` + `Source_Object_Type__c`).

## Local development

Prerequisites: Node 22.x, a local Postgres.

```bash
cp .env.example .env          # then fill in DATABASE_URL and (optionally) Salesforce creds
npm install
npm run prisma:migrate:dev    # apply the schema to your DB
npm run dev                   # http://localhost:3000/health
```

### Environment variables
See `.env.example` for the full contract. Key ones:

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection (Heroku sets this automatically) |
| `APP_BASE_URL` | Public URL of this backend; Named Credential target + signer-link base |
| `SF_LOGIN_URL` | `https://login.salesforce.com` (or `…/test…` for sandboxes) |
| `SF_CLIENT_ID` | Connected App consumer key |
| `SF_USERNAME` | Integration user to impersonate (JWT bearer) |
| `SF_PRIVATE_KEY` | PEM key matching the Connected App cert (`\n` escapes ok) |
| `BRAND_*` | Light/emerald branding — name, color (`#10b981`), logo, sender |

Secrets come from the environment only and are never committed.

## Verifying M1 (the Salesforce read path)

With Salesforce credentials set, run the acceptance script against any record Id that has a file:

```bash
npm run check:read-path -- <salesforceRecordId>
```

It authenticates via JWT, lists the record's files (newest first), downloads the latest one, and
prints its **SHA-256** — proving the full read path end-to-end with no write-back.

The same path is exposed over HTTP:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health`, `/health/ready` | liveness / readiness (DB + SF config) |
| `GET` | `/api/salesforce/status` | identity probe (org + user) |
| `GET` | `/api/salesforce/records/:recordId/files` | all files on a record, newest first |
| `GET` | `/api/salesforce/records/:recordId/files/latest` | the default "most recent" file |
| `GET` | `/api/salesforce/files/:contentVersionId/hash` | download + SHA-256 a file |

## The signing engine (M2)

The engine turns a Salesforce file into a signed PDF through a tokenized public portal, capturing
ESIGN/UETA evidence at every step.

**Lifecycle:** `DRAFT` → `SENT` → (`PARTIALLY_SIGNED`) → `COMPLETED` (or `DECLINED`). Signers are
**parallel** — each gets a single-use link and can sign independently; the request completes once
all have signed. The original PDF is pulled and hashed at creation; on completion every signer's
fields are flattened into the PDF and the result is hashed.

**Sender/admin API** (guarded by `BACKEND_API_KEY` via the `x-api-key` header — this is what the
Salesforce Named Credential will present in M4):

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/requests` | create a DRAFT from a Salesforce file + signers + field placements |
| `POST` | `/api/requests/:id/send` | mint single-use signer tokens, return signing links |
| `GET` | `/api/requests/:id` | sender status view incl. the full audit trail |
| `POST` | `/api/requests/:id/writeback` | retry the Salesforce write-back |
| `GET` | `/api/requests/:id/signed` | download the flattened signed PDF |
| `GET` | `/api/requests/:id/certificate` | download the Certificate of Completion |

**Signer-facing API** (authenticated solely by the URL token; captures IP + user-agent):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/sign/:token` | the signer portal (HTML page) |
| `GET` | `/api/sign/:token` | signer context: document, fields, consent disclosure |
| `GET` | `/api/sign/:token/document` | the source PDF bytes (rendered client-side by pdf.js) |
| `POST` | `/api/sign/:token/consent` | record affirmative electronic-records consent |
| `POST` | `/api/sign/:token/submit` | submit field values and sign |
| `POST` | `/api/sign/:token/decline` | decline to sign |

**Fields:** `SIGNATURE`, `INITIALS`, `DATE`, and free-text `TEXT` (e.g. a "Title" box → "CEO"),
each assigned to one signer and placed in PDF points with a **top-left origin** (0-based page
index) — the convention shared by the `fields` table, the flattener, and the portal overlay.

**Tokens** are 256-bit and expiring; only their SHA-256 hash is stored — the raw token lives only
in the signing link. A signer cannot re-sign once SIGNED, but note: the link is not yet invalidated
on completion (it stays valid until expiry) and the document stays viewable through it — see
[Known limitations](#known-limitations--deferred-before-production).

**Portal:** a single self-contained, emerald-branded page served by the backend (`public/portal.html`).
It renders the PDF with pdf.js, overlays the signer's fields, gates on the consent disclosure, and
captures a drawn (finger/mouse) or typed signature.
> **Deviation from the original spec (flagged):** the portal is served by the backend rather than
> a separate Next.js app, so the whole product runs on one Heroku dyno. The signing API is the
> real contract; the page can be promoted to an SPA later with no backend changes.

## Certificate, tamper-evidence & Salesforce write-back (M3)

On completion the engine:

1. **Flattens** every signer's fields into the source PDF and stores the **SHA-256** of that
   signed PDF (`docHashFinal`); the original was hashed at creation (`docHashOriginal`).
2. Generates a **Certificate of Completion** PDF — document identity + both hashes, and per signer:
   name, email, authentication method, consent timestamp + IP, signed timestamp, plus the full
   timestamped event timeline. (`src/signing/certificate.ts`; paginates automatically.)
3. **Writes back to Salesforce** (`attemptWriteback`): uploads the **signed PDF with the
   certificate appended** as a new File on the originating record, uploads the **standalone
   certificate** as a second File, and **upserts `Signature_Request__c`** (status, dates, both
   hashes, signer summary, and the signed/certificate `ContentDocument` ids) keyed by the external
   id `Backend_Request_Id__c`.

Write-back is **best-effort and idempotent**: if Salesforce isn't configured it's skipped; on
failure a `WRITEBACK_FAILED` audit event is recorded and it can be retried via
`POST /api/requests/:id/writeback` (uploads create new versions; the record upserts by external id).

> **Before production:** deploy the `salesforce/` SFDX project so `Signature_Request__c` exists, and
> validate the write-back in a **sandbox** first — the upload primitives are covered by mocked
> integration tests here, not yet exercised against a live org (to avoid writing files into your
> production org during development).

## Deploying to Heroku

```bash
heroku create
heroku addons:create heroku-postgresql:essential-0
heroku config:set APP_BASE_URL=https://<app>.herokuapp.com \
  SF_CLIENT_ID=… SF_USERNAME=… SF_PRIVATE_KEY="$(cat server.key)" \
  SF_LOGIN_URL=https://login.salesforce.com
git push heroku HEAD:main
```

The `release` phase runs `prisma migrate deploy`. (`app.json` supports one-click provisioning.)

## Salesforce setup (summary)

1. **Connected App** with a certificate and the `api` + `refresh_token` scopes; pre-authorize the
   integration user. Use its consumer key as `SF_CLIENT_ID`. *(Backend → Salesforce, JWT bearer.)*
2. Deploy the SFDX project in `salesforce/` — `Signature_Request__c`, the `InkPathController` Apex,
   the **Send for Signature** LWC, the `InkPath_Backend` Named/External Credential, and the
   `InkPath_User` permission set.
3. In Setup, point the **Named Credential** at your backend URL and add the `x-api-key` custom
   header (= `BACKEND_API_KEY`) on the External Credential principal, assign the permission set, and
   surface the LWC (Quick Action or record page). *(Salesforce → backend.)*

Full step-by-step: [`salesforce/README.md`](salesforce/README.md).

Verified against the target org (API **v60.0**): standard Files objects
(`ContentDocumentLink` / `ContentVersion`) and the CRE deal object `TTL_Core__Deal__c`.
> Note: the org already has DocuSign, Adobe Sign, and S-Docs installed — InkPath is the
> cost-saving in-house alternative.

## Known limitations — deferred before production

A multi-agent code review (M1–M4) surfaced issues that are intentionally **deferred** until after
sandbox validation. The current build is suitable for a **sandbox pilot with disposable test
documents**, not for real executed instruments, until these are closed:

- **Signer links are not yet single-use.** A token stays valid (and the document viewable) until
  its 7-day expiry even after signing; `decline` has no terminal-state guard. Hardening planned:
  invalidate the token at terminal state, gate read access, shorten TTL.
- **Parallel-completion race / non-idempotent write-back.** Two signers completing near-simultaneously
  could trigger completion twice, and a write-back retry after a partial failure can create duplicate
  Salesforce Files. Planned: single-winner atomic status transition + idempotent uploads.
- **Documents and signer PII are stored unencrypted** as Postgres `BYTEA`/text ("encrypted at rest"
  is *not* yet implemented). Retention is also not durable: blobs live only in one Heroku Postgres
  instance and `audit_events` cascade-delete with the request. Planned: object storage + envelope
  encryption, durable retention, append-only audit.
- **No real signer identity verification or email delivery.** Auth is *possession of the link*; the
  backend returns links rather than emailing them, and OTP is scaffolded but not wired. "Verified
  email" is aspirational until email-OTP lands.
- **Other hardening:** lock down CORS (currently reflects any origin), de-dupe `LINK_OPENED` audit
  events, handle rotated PDF pages and 6+ signer auto-placement overlap, `trustProxy: 1` for accurate
  audit IPs, and add route-level/decline/expiry integration tests.

> ⚖️ Reinforcing the disclaimer above: until the items above are addressed, do not rely on this for
> legally executed CRE documents. This is not legal advice.

## Roadmap

- [x] **M1 — Foundations:** backend scaffold, validated config, Postgres schema, Salesforce JWT
  auth, latest-file read path proven end-to-end.
- [x] **M2 — Signing engine:** PDF field placement + flattening (pdf-lib), single-use tokenized
  signer portal, ESIGN/UETA consent disclosure, signature/initials/date/text fields, IP +
  user-agent + timestamp capture, parallel multi-signer completion. End-to-end integration test.
- [x] **M3 — Audit & write-back:** Certificate of Completion (paginating), SHA-256 tamper-evidence
  on original + signed, signed-PDF-with-certificate + standalone certificate uploaded to the source
  record, `Signature_Request__c` upserted. Best-effort idempotent write-back with retry endpoint.
- [x] **M4 — Salesforce UX:** "Send for Signature" LWC (file picker defaulting to latest, signer
  pre-fill from contacts, per-signer field selection with backend auto-placement), `InkPathController`
  Apex calling the backend over a **Named Credential** (no secrets in Apex), `InkPath_User` permission
  set, example Opportunity Quick Action. See `salesforce/README.md` for deploy + setup. *(Authored as
  SFDX source; deploy/validate in your sandbox.)*
- [ ] **M5 — Hardening:** multi-signer-per-entity polish, optional OTP auth, retries, tests,
  deployment guide.
