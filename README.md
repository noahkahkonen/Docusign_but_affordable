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
│   ├── routes/           # health + M1 read-path API
│   ├── lib/              # logger, hashing
│   └── server.ts         # bootstrap
├── prisma/               # data model + migrations
├── scripts/              # check-read-path.ts (M1 acceptance script)
├── salesforce/           # SFDX project: Signature_Request__c object + fields
├── test/                 # Vitest
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
- [ ] **M2 — Signing engine:** PDF field placement, tokenized signer portal, ESIGN/UETA consent
  disclosure, capture signature + IP + timestamps, flatten output.
- [ ] **M3 — Audit & write-back:** Certificate of Completion, hashing/tamper-evidence, write signed
  PDF + certificate back to Salesforce, update `Signature_Request__c`.
- [ ] **M4 — Salesforce UX:** "Send for Signature" LWC Quick Action, status display, Named
  Credential wiring.
- [ ] **M5 — Hardening:** multi-signer-per-entity polish, optional OTP auth, retries, tests,
  deployment guide.
