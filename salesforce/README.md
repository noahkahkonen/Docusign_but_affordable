# InkPath ↔ Salesforce integration

A Lightning Web Component that sends Salesforce Files out for e-signature via the InkPath web app, with a webhook back into Salesforce when the document is signed.

## What you get

- **`InkPath_Signature_Request__c`** custom object — one record per signature request, tracking status, signer info, signing URL, signed-at timestamp, IP, and signature method.
- **`InkPath_Setting__mdt`** custom metadata type — holds the API key + webhook secret.
- **Named Credential `InkPath_API`** — the InkPath base URL.
- **`InkPathService`** Apex class — `@AuraEnabled` methods for the LWC (`getRecordFiles`, `getRequestsForRecord`, `sendForSignature`).
- **`InkPathWebhook`** Apex REST class — receives `POST /services/apexrest/inkpath/webhook` from InkPath, verifies the HMAC, and marks the request as signed.
- **`inkPathSendForSignature`** LWC — drop on any record page (Opportunity, Contract, Account, custom object). Lists PDF/PNG/JPEG files attached to the record, takes signer name + email, calls Apex, shows the signing URL, and lists prior requests with live status.
- **`InkPath_User`** permission set.

## Flow

1. Your existing doc generator drops a rendered PDF into Salesforce Files on a record.
2. The user opens the record, scrolls to the **Send for signature (InkPath)** card, picks the file, enters signer name + email, clicks **Send for signature**.
3. Apex base64-encodes the file, calls `POST {InkPath_API}/api/v1/documents` with a `Bearer` token. The request body includes `external_ref = <recordId>` and `webhook_url = <Org URL>/services/apexrest/inkpath/webhook`.
4. InkPath stores the document, generates a tokenized signing URL, and returns it. Apex saves an `InkPath_Signature_Request__c` record.
5. Signer opens the URL, signs (drawn or typed). InkPath records IP + timestamp.
6. InkPath `POST`s the audit payload to your Salesforce webhook URL with an `X-InkPath-Signature: sha256=<hex>` HMAC header (shared secret).
7. Apex verifies the HMAC, finds the request by token, and updates Status → Signed with the IP + timestamp + method.

## Deploy

Prereqs: `sf` CLI (`npm install -g @salesforce/cli`) and a target org authenticated.

```bash
cd salesforce
sf project deploy start --source-dir force-app --target-org <yourOrgAlias>
sf apex run test --test-level RunLocalTests --target-org <yourOrgAlias> --result-format human --code-coverage
```

## Configure

1. **InkPath side** — set env vars before starting the server:
   ```bash
   INKPATH_API_KEY=$(openssl rand -hex 32)
   INKPATH_WEBHOOK_SECRET=$(openssl rand -hex 32)
   PUBLIC_BASE_URL=https://your-inkpath-host.example.com
   ```
   Keep both values handy.

2. **Named Credential** — Setup → Named Credentials → **InkPath API** → set Endpoint to your InkPath base URL (e.g. `https://your-inkpath-host.example.com`).

3. **Custom Metadata** — Setup → Custom Metadata Types → **InkPath Setting** → Manage Records → **Default** → set:
   - `API Key` = the `INKPATH_API_KEY` value
   - `Webhook Secret` = the `INKPATH_WEBHOOK_SECRET` value

4. **Permission set** — assign `InkPath User` to the users who will send for signature.

5. **Drop the LWC** — Lightning App Builder → edit your record page (Opportunity, Contract, etc.) → drag **InkPath: Send for Signature** onto the page → Save & Activate.

## Inbound webhook authentication

`POST /services/apexrest/inkpath/webhook` is a Salesforce REST endpoint. By default it requires a Salesforce session, which InkPath doesn't have. Two options:

**A. Salesforce Site (recommended for MVP).** Create a public Site (Setup → Sites), add `InkPathWebhook` to the guest user's Apex Class Access, and grant the guest user read/edit on `InkPath_Signature_Request__c`. The site URL becomes `https://<site-domain>/services/apexrest/inkpath/webhook`. Update the `webhook_url` we send to InkPath by editing `InkPathService.sendForSignature` (or by setting an Org-Wide Default Site URL in a future Custom Metadata field).

**B. Connected App + OAuth.** InkPath would need to obtain a Salesforce access token via `client_credentials` and include it as a Bearer token. More setup, but reuses standard Salesforce auth. Skip for MVP.

Either way, **the HMAC signature in `X-InkPath-Signature` is the real auth boundary** — only requests signed with `Webhook_Secret__c` are accepted. The Site/Connected App layer is just transport.

## File-size note

Apex callouts are capped at 12 MB request size. For documents larger than ~8 MB (base64 inflates by ~33%), switch the LWC to upload the file directly to InkPath from the browser (signed upload URL pattern) and only pass metadata through Apex. Not in this MVP.

## Future enhancements

- Drag-and-drop signature placement on the PDF (positional fields).
- Multi-signer routing.
- Auto-attach the signed PDF back to the originating record (re-render with signature stamped in).
- Reminders + expiration.
- Replace the Custom Metadata key storage with External Credentials for at-rest encryption.
