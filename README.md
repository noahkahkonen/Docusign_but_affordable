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

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/documents` | Multipart upload + signer info → returns `signing_url` |
| `GET` | `/api/documents` | List all documents + status |
| `GET` | `/api/requests/:token` | Fetch a signing request (used by signer page) |
| `POST` | `/api/requests/:token/sign` | Submit a signature (drawn or typed) |

## Roadmap ideas

- Email delivery of signing links (SES / SMTP)
- Multiple signers per document with ordering
- Signature placement (drag/drop fields on the PDF)
- Account login + organizations
- Tamper-evident PDF re-rendering with signature stamped into the file
- 2FA / SMS verification before signing
