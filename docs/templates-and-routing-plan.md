# Plan: roles, templates & signer routing (recurring vs custom documents)

Master plan for making InkPath handle BOTH one-off custom documents (manual placement) and
frequently-sent documents (rule-based placement + signer routing, with auto-send for trusted
templates). Supersedes the field-placement-only scope in `field-placement-plan.md` (Phase 0, done).

## The model: Roles → Templates → Routing
Stop binding fields to *people* and *pixels*; layer three concepts.

1. **Signer roles** — fields/rules are defined against abstract roles (`BUYER`, `SELLER`,
   `TENANT`, `LANDLORD`, `OTHER`), not named people. A role resolves to a real Contact at send
   time via the Deal's party fields.
2. **Templates** — for a recurring document, place fields once, assign each to a role, save as a
   template keyed to a document type. Reused automatically thereafter. (Generated docs have a
   stable layout, so saved coordinates stay valid.)
3. **Routing rules** — map the Deal **RecordType** → which roles must sign. Encodes the
   representation logic once.

Two modes both fall out of this:
- **Custom one-off** → open the Prepare page, place fields, assign roles, send. (Phase 0 + role
  dropdown.)
- **Recurring** → match template by doc type, resolve roles→people from the Deal, auto-place +
  auto-route. Trusted templates **auto-send**; others open the pre-filled Prepare page for review.

## Real Salesforce data (this org)
Deal object `TTL_Core__Deal__c`. Representation is the **RecordType**:
- `Buyer_Rep`, `Investment_Sales` → buyer-side
- `Tenant_Rep` → tenant-side
- `Seller_Rep`, `Disposition` → seller-side
- `Landlord_Rep` → landlord-side
- (also `Land_Sale`, `Consulting`, `Test`)

Party Contact fields (role → field):
- BUYER → `TTL_Core__Buyer_Contact__c`
- SELLER → `TTL_Core__Seller_Contact__c`
- TENANT → `TTL_Core__Tenant_Contact__c`
- LANDLORD → `TTL_Core__Landlord_Contact__c`
- (client we represent → `TTL_Core__Client_Contact__c`)
Resolve each to Contact Name + Email via SOQL.

## Routing matrix (CONFIRMED — implemented in src/signing/routing.ts)
| RecordType | Always signs (client) | Also signs if Contact present |
|---|---|---|
| Buyer_Rep / Investment_Sales | Buyer | — (client only) |
| Tenant_Rep | Tenant | — (client only) |
| Seller_Rep / Disposition | Seller | **Buyer** (even unrepresented) |
| Landlord_Rep | Landlord | **Tenant** |
Confirmed 2026-06-09: buyer/tenant-rep deals send to the client only.

## Auto-send (chosen) — safety design
Auto-send is opted into PER TEMPLATE, and only after the template is validated:
1. Build a template by placing fields once in the Prepare page (review mode) and saving.
2. Test-send it; confirm fields + routing land correctly.
3. Flip `autoSend = true` on that template.
Guards even when autoSend: only fire if EVERY required role resolves to a Contact with an email;
otherwise fall back to opening the pre-filled Prepare page and flag why. Full audit trail always.

## Doc-generator handoff
Today: a dropdown on the record lets Noah pick a document (in the record's Files) — the generator
(`best-corporate-docgen`, a separate Heroku app) produces the filled PDF. Target integrated flow:
pick doc → docgen generates filled PDF into the Deal's Files → calls InkPath with Deal context
(recordId, recordType, resolved party contacts, documentType) → InkPath applies template + routing
→ auto-sends (trusted) or opens pre-filled Prepare page. Cross-app contract TBD; InkPath exposes the
capability via its API so docgen/the LWC can call it.

## Data-model changes (Prisma)
- `Signer.role` — enum `SignerRole { BUYER SELLER TENANT LANDLORD OTHER }` (nullable; manual flow
  can leave it OTHER).
- `SignatureRequest.salesforceRecordType` — store the Deal RecordType DeveloperName (routing + audit).
- New `Template` — id, name, `documentType` (match key), `autoSend` Boolean, timestamps.
- New `TemplateField` — templateId, role, type, label, required, pageIndex, x, y, width, height.
- Routing rules: start as a config map (recordType → roles), not a table; promote to DB/admin UI
  later if Noah needs to edit them without a deploy.

## Phases
- **Phase 0 — Manual placement.** DONE (`public/prepare.html` + prepare API).
- **Phase 1 — Roles.** Add `Signer.role`; Prepare page gets a per-field role assignment + lets a
  request have multiple typed signers. (small)
- **Phase 2 — Templates.** Save a placement as a template per document type; "load template" when
  preparing; CRUD for templates. (medium)
- **Phase 3 — Routing.** RecordType → roles config; resolve party Contacts from the Deal; auto-pick
  signers + auto-place from template; store recordType on the request. (medium)
- **Phase 4 — Auto-send + docgen integration.** Per-template autoSend with the safety guards; the
  docgen/LWC trigger that passes Deal context and fires the templated flow. (depends on docgen)

## Open questions
- Confirm the routing matrix (other-side-signs cases).
- How documents are identified for template matching (docgen documentType key vs file name).
- Whether routing rules must be user-editable (UI) or can stay in config initially.
- The exact docgen→InkPath contract (who calls whom, auth, payload).
