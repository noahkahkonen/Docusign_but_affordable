# InkPath — affordable e-signatures

A simple, self-hostable DocuSign alternative. Upload a PDF (or image), send a signing link to someone, and they can sign by drawing with their finger or by typing their name. We record their IP, user agent, and timestamp for an audit trail.

## Features (v0.1)

- Upload a PDF, PNG, or JPEG document
- Create a unique signing link for a named/email signer
- Signer page with two signature modes:
  - **Draw**: touch (finger) or mouse on an HTML canvas
  - **Type**: handwriting-style preview of typed name
- Audit trail: IP address, user agent, ISO timestamp
- Dashboard listing all sent documents and their status
- Signed view that re-renders the captured signature alongside the audit data
- Local SQLite storage, no external services

## Running it

```bash
npm install
npm start
```

Then open http://localhost:3000

Files are stored under `./uploads/` and the SQLite DB under `./data/app.db`. Both directories are git-ignored.

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/documents` | none | Multipart upload + signer info → returns `signing_url` (used by the web UI) |
| `POST` | `/api/v1/documents` | `Authorization: Bearer $INKPATH_API_KEY` | JSON upload (base64) — used by external integrations like Salesforce. Accepts `external_ref` + `webhook_url`. |
| `GET` | `/api/documents` | none | List all documents + status |
| `GET` | `/api/requests/:token` | none | Fetch a signing request (used by signer page) |
| `POST` | `/api/requests/:token/sign` | signing token in URL | Submit a signature (drawn or typed). Fires HMAC-signed webhook to `webhook_url` if set. |

### Environment variables

| Var | Purpose |
| --- | --- |
| `PORT` | Listen port (default `3000`) |
| `PUBLIC_BASE_URL` | Public URL used when building `signing_url` and webhook payload `signature_url`. Useful behind a tunnel/proxy. |
| `INKPATH_API_KEY` | Required for `/api/v1/documents`. Bearer-checked with constant-time compare. |
| `INKPATH_WEBHOOK_SECRET` | If set, every outbound webhook gets `X-InkPath-Signature: sha256=<hmac(body)>`. |

## Salesforce integration

A drop-in Lightning Web Component lives under [`salesforce/`](./salesforce). Deploy it to send Salesforce Files for signature directly from any record page, with status auto-updating via HMAC-signed webhooks. See [`salesforce/README.md`](./salesforce/README.md) for the setup walkthrough.

## Roadmap ideas

- Email delivery of signing links (SES / SMTP)
- Multiple signers per document with ordering
- Signature placement (drag/drop fields on the PDF)
- Account login + organizations
- Tamper-evident PDF re-rendering with signature stamped into the file
- 2FA / SMS verification before signing
