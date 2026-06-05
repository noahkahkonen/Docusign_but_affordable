# InkPath — Salesforce package

SFDX source for the InkPath Salesforce side:

| Component | Path | Purpose |
| --- | --- | --- |
| `Signature_Request__c` | `objects/Signature_Request__c/` | tracking object the backend mirrors into |
| `InkPathController` (+ test) | `classes/` | reads record files/contacts; calls the backend over a Named Credential |
| `sendForSignature` LWC | `lwc/sendForSignature/` | "Send for Signature" UI (file picker, signers, fields) |
| `InkPath_Backend` Named + External Credential | `namedCredentials/`, `externalCredentials/` | secret-free backend connection |
| `InkPath_User` permission set | `permissionsets/` | grants Apex + callout + object access |
| `Opportunity.Send_for_Signature` quick action | `quickActions/` | example record button |

> **Verify field/object names against your org before relying on them.** This was authored against
> an org where the CRE deal object is `TTL_Core__Deal__c`; the standard objects used
> (`ContentDocumentLink`, `ContentVersion`, `Opportunity`, `Account`, `Contact`,
> `OpportunityContactRole`) are stock.

## Prerequisites

- Salesforce CLI (`sf`) authenticated to your **sandbox** (`sf org login web`).
- The InkPath backend deployed (Heroku) and reachable over HTTPS, with `BACKEND_API_KEY` set.

## Deploy

```bash
cd salesforce
sf project deploy start --source-dir force-app --target-org <your-sandbox-alias>
# run the Apex tests:
sf apex run test --target-org <your-sandbox-alias> --class-names InkPathControllerTest --result-format human
```

## Post-deploy configuration (one time, in Setup)

Secrets and environment-specific URLs can't ship in source — set them once after deploy:

1. **Named Credential URL** — Setup → Named Credentials → *InkPath Backend* → set the URL to your
   Heroku app (e.g. `https://your-inkpath-app.herokuapp.com`). Keep the developer name
   `InkPath_Backend` (the Apex references `callout:InkPath_Backend`).
2. **⚠️ REQUIRED — External Credential `x-api-key` header (callouts return 401 without it).**
   The header that authenticates Salesforce → backend is **not** shippable in source (it carries a
   secret), so it must be added once in Setup. Until you do this, *every* "Send for Signature" click
   fails with 401.
   - Setup → Security → **Named Credentials** → **External Credentials** → *InkPath Backend* →
     **Principals** → `InkPathPrincipal` → **Authentication Parameters** → add one:
     - Name: `ApiKey`  ·  Value: your backend `BACKEND_API_KEY` value
   - On the same External Credential, add a **Custom Header**:
     - Name: `x-api-key`  ·  Value: `{!$Credential.InkPath_Backend.ApiKey}`
   (Salesforce now sends `x-api-key: <your key>` on every callout. The backend requires this header
   in production and will reject calls without it.)
   - Alternatively (simplest): on the principal add the Custom Header `x-api-key` with the literal
     key value directly. Either way the backend just needs to receive `x-api-key`.
3. **Permission set** — assign **InkPath User** to the relevant users:
   `sf org assign permset --name InkPath_User`. This also grants access to the external-credential
   principal (required for the callout).
4. **Surface the UI** — either:
   - add the **Send for Signature** quick action to the Opportunity page layout / Lightning record
     page (an example action is included for Opportunity — duplicate it for Account /
     `TTL_Core__Deal__c`), **or**
   - drag the **Send for Signature** component onto any Lightning record page.

## Backend → Salesforce (separate auth)

The write-back direction (backend writing the signed PDF + certificate back) uses the **OAuth 2.0
JWT bearer flow**, configured on the backend (`SF_CLIENT_ID`, `SF_USERNAME`, `SF_PRIVATE_KEY`). That
needs a **Connected App** with a certificate and the integration user pre-authorized — independent
of the Named Credential above, which is only for the Salesforce → backend direction. See the root
`README.md`.

## How it flows

1. User opens a record, clicks **Send for Signature**.
2. LWC loads the record's files (latest PDF preselected) and suggests signers from related contacts.
3. User confirms signers and which fields each needs (Signature / Date / Title), clicks send.
4. `InkPathController` calls the backend (`POST /api/requests` then `/send`) over the Named
   Credential; the backend auto-places the chosen fields, mints tokenized links, and returns them.
5. Signers sign in the portal; on completion the backend writes the signed PDF + Certificate of
   Completion back onto the record and upserts `Signature_Request__c`.
