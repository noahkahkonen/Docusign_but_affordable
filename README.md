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
│   ├── signing/          # signing engine: requests lifecycle, pdf, tokens, consent, audit
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

**Tokens** are 256-bit, single-use, and expiring; only their SHA-256 hash is stored — the raw
token lives only in the signing link.

**Portal:** a single self-contained, emerald-branded page served by the backend (`public/portal.html`).
It renders the PDF with pdf.js, overlays the signer's fields, gates on the consent disclosure, and
captures a drawn (finger/mouse) or typed signature.
> **Deviation from the original spec (flagged):** the portal is served by the backend rather than
> a separate Next.js app, so the whole product runs on one Heroku dyno. The signing API is the
> real contract; the page can be promoted to an SPA later with no backend changes.

## Deploying to Heroku

```bash
heroku create
heroku addons:create heroku-postgresql:essential-0
heroku config:set APP_BASE_URL=https://<app>.herokuapp.com \
  SF_CLIENT_ID=… SF_USERNAME=… SF_PRIVATE_KEY="$(cat server.key)" \
  SF_LOGIN_URL=https://login.salesforce.com
git push heroku claude/cre-esignature-salesforce-F2ShM:main
```

The `release` phase runs `prisma migrate deploy`. (`app.json` supports one-click provisioning.)

## Salesforce setup (summary)

1. **Connected App** with a certificate and the `api` + `refresh_token` scopes; pre-authorize the
   integration user. Use its consumer key as `SF_CLIENT_ID`.
2. Deploy the SFDX project in `salesforce/` (adds `Signature_Request__c`).
3. (M4) Create a **Named Credential** pointing at `APP_BASE_URL`, and add the "Send for Signature"
   LWC Quick Action to the record page.

Verified against the target org (API **v60.0**): standard Files objects
(`ContentDocumentLink` / `ContentVersion`) and the CRE deal object `TTL_Core__Deal__c`.
> Note: the org already has DocuSign, Adobe Sign, and S-Docs installed — InkPath is the
> cost-saving in-house alternative.

## Roadmap

- [x] **M1 — Foundations:** backend scaffold, validated config, Postgres schema, Salesforce JWT
  auth, latest-file read path proven end-to-end.
- [x] **M2 — Signing engine:** PDF field placement + flattening (pdf-lib), single-use tokenized
  signer portal, ESIGN/UETA consent disclosure, signature/initials/date/text fields, IP +
  user-agent + timestamp capture, parallel multi-signer completion. End-to-end integration test.
- [ ] **M3 — Audit & write-back:** Certificate of Completion, hashing/tamper-evidence, write signed
  PDF + certificate back to Salesforce, update `Signature_Request__c`.
- [ ] **M4 — Salesforce UX:** "Send for Signature" LWC Quick Action, status display, Named
  Credential wiring.
- [ ] **M5 — Hardening:** multi-signer-per-entity polish, optional OTP auth, retries, tests,
  deployment guide.
