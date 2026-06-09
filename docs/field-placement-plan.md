# Plan: visual field placement for senders (item 3)

Status: **not started** — agreed approach + design captured here so it can be picked up directly.
Branch: `claude/cre-esignature-salesforce-F2ShM`.

## Goal
Let a sender visually place signing objects (Signature, Initials, Date, Text) on the PDF per
signer before sending — instead of today's automatic placement (`autoFields` → `autoPlaceFields`).

## Chosen approach
A sender-facing **"Prepare" web page in InkPath** (NOT a drag-drop editor inside the Salesforce
LWC, which would be far harder). It reuses the crisp pdf.js rendering we just built for the portal.

Flow:
1. Create a DRAFT request (signers known, **fields optional/empty**).
2. Open `APP_BASE_URL/prepare/<prepareToken>` in the browser.
3. Sender picks a signer + field type, clicks/drags boxes onto the page, repositions/deletes.
4. Save → Send (reuses the existing `sendSignatureRequest` → email flow).

## Coordinate convention (verified — do not change)
Top-left origin, PDF points, 0-based `pageIndex` (documented in `src/signing/pdf.ts`). The portal
overlays fields at `left:x*scale, top:y*scale`; `flattenFields` converts to pdf-lib bottom-left via
`bottomLeftY = pageHeight - y - height`. So in the prepare page:
`pdfX = screenX / scale`, `pdfY = screenY / scale`, `width/height` likewise divided by `scale`.

## Backend work
1. **Migration** (Prisma): add to `SignatureRequest`:
   - `prepareTokenHash String? @map("prepare_token_hash")`
   - `prepareTokenExpiresAt DateTime? @map("prepare_token_expires_at")`
   Generate with `prisma migrate dev`, commit the SQL under `prisma/migrations/`.
2. `createSignatureRequest` (`src/signing/requests.ts`): make `fields` optional (allow a draft with
   zero fields); mint a `prepareToken` (reuse `issueToken`/`hashToken`/`expiryFromNow` from
   `src/signing/tokens.ts`), store the hash, and return the raw token to the caller.
3. New functions in `requests.ts`:
   - `resolvePrepareToken(token)` — mirror `resolveSigner`, enforce DRAFT + expiry.
   - `getPrepareContext(token)` — documentName, signers (id, name, entityLabel), `pages` layout,
     current fields.
   - `replaceDraftFields(token, fields)` — validate against page geometry (reuse the checks in
     `createSignatureRequest`) and replace the field set.
   - Reuse `sendSignatureRequest`, but require ≥1 field before allowing send.
4. Routes (new `src/routes/prepare.ts`, token-authed like `signing.ts` — NOT API-key, since a
   browser can't hold `BACKEND_API_KEY`):
   - `GET  /api/prepare/:token`          → context
   - `GET  /api/prepare/:token/document` → source PDF bytes
   - `PUT  /api/prepare/:token/fields`   → replace fields
   - `POST /api/prepare/:token/send`     → send
   - `GET  /prepare/:token`              → serve `public/prepare.html` (mirror `routes/portal.ts`)

## Frontend: `public/prepare.html`
- Reuse the portal's pdf.js render **with the devicePixelRatio fix** (see `public/portal.html`
  `renderDocument`) so pages are crisp.
- A signer selector (dropdown) + field-type palette (Signature / Initials / Date / Text).
- Click on a page to drop a field at a default size; then drag to move, handle to resize, ✕ to
  delete. Color-code by signer.
- Default sizes (from `src/signing/layout.ts` SLOTS): SIGNATURE 210×48, INITIALS 70×48,
  DATE 110×18, TEXT 150×18 (points).
- Field model sent to `PUT /fields`: `{ signerIndex, type, label?, required, pageIndex, x, y,
  width, height }` (same shape as `CreateFieldInput`).
- "Send for signature" button → `POST /send`.

## Salesforce LWC integration (follow-up, separate deploy via sfdx)
Change `salesforce/.../lwc/sendForSignature` + its Apex to create the draft and **open the prepare
URL** (returned `prepareToken`) instead of auto-placing and sending immediately. This is a separate
deploy pipeline from Heroku.

## Open question to confirm with Noah
He picked "Field placement (sender)" **and "Other"** but the "Other" note didn't come through — ask
what else he meant (e.g. per-signer field differences, signing order, document editing, saved
templates) before finalizing.

## Reference files
- `public/portal.html` — pdf.js render + DPR pattern to copy
- `src/signing/pdf.ts` — coordinate convention + flatten
- `src/signing/layout.ts` — auto-place + default field dimensions
- `src/signing/tokens.ts` — issueToken/hashToken/expiryFromNow
- `src/signing/requests.ts` — createSignatureRequest, sendSignatureRequest, resolveSigner
- `src/routes/signing.ts` / `src/routes/portal.ts` — token-authed route + static-page patterns
- `prisma/schema.prisma` — SignatureRequest + Field models
