import type { FieldType, Prisma, SignerRole } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { sha256, toPrismaBytes } from "../lib/hash.js";
import { downloadFileBytes } from "../salesforce/files.js";
import { recordAudit } from "./audit.js";
import { issueToken, hashToken, expiryFromNow } from "./tokens.js";
import { consentDisclosure } from "./consent.js";
import { getPageLayouts } from "./pdf.js";
import { autoPlaceFields, type AutoFieldRequest } from "./layout.js";
import { generateCertificate, attemptWriteback, finalizeCompletion } from "./writeback.js";
import { sendSigningInvitations } from "./notifications.js";
import { getDealParties } from "../salesforce/deal.js";
import { computeRouting } from "./routing.js";
import { findAutoSendTemplate, applyTemplateToRequestId } from "./templates.js";

/**
 * Signature request lifecycle: create (draft) -> send (mint tokens) -> per-signer open/consent/
 * sign -> complete (flatten + hash). Signers are parallel by default; the request completes once
 * every signer has signed.
 */

export interface CreateSignerInput {
  name: string;
  email: string;
  entityLabel?: string;
  /** CRE party this signer represents (BUYER/SELLER/TENANT/LANDLORD); omit for ad-hoc signers. */
  role?: SignerRole;
  /** Field types to auto-place for this signer (used by the Salesforce LWC instead of x/y boxes). */
  autoFields?: FieldType[];
}

export interface CreateFieldInput {
  signerIndex: number; // index into the signers array
  type: FieldType;
  label?: string;
  required?: boolean;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CreateRequestInput {
  salesforceRecordId: string;
  salesforceObjectType: string;
  salesforceRecordType?: string; // Deal RecordType DeveloperName (routing/audit)
  contentVersionId: string; // the source PDF in Salesforce
  documentName: string;
  documentType?: string; // stable key for template matching (e.g. "agency-disclosure")
  signers: CreateSignerInput[];
  /** Explicit field placements. Optional when signers use autoFields. */
  fields?: CreateFieldInput[];
  /**
   * When true, allow creating a DRAFT with no fields yet — the sender will place them in the
   * browser-based prepare page before sending. (Normally at least one field is required.)
   */
  prepare?: boolean;
}

function httpError(status: number, message: string): Error {
  const err = new Error(message);
  (err as { statusCode?: number }).statusCode = status;
  return err;
}

/**
 * Reject placements outside the page's media box. pdf-lib does not clip — an out-of-bounds field
 * silently draws nothing (or garbage) in the flattened output, which for a signature box on a
 * legal document means a signed PDF missing its signature mark.
 */
function assertFieldWithinPage(
  f: { x: number; y: number; width: number; height: number },
  page: { width: number; height: number },
  pageIndex: number,
): void {
  const EPS = 1; // PDF points; absorbs float noise only
  if (f.x < -EPS || f.y < -EPS || f.x + f.width > page.width + EPS || f.y + f.height > page.height + EPS) {
    throw httpError(422, `A field lies outside page ${pageIndex + 1}'s bounds (${Math.round(page.width)}×${Math.round(page.height)}pt).`);
  }
}

/** Create a DRAFT request: pull the source PDF from Salesforce, hash it, persist signers+fields. */
export async function createSignatureRequest(input: CreateRequestInput) {
  if (input.signers.length === 0) throw new Error("At least one signer is required");

  // Pull the source document now so the request is self-contained and the original hash is fixed.
  const originalPdf = await downloadFileBytes(input.contentVersionId);
  const docHashOriginal = sha256(originalPdf);
  const layouts = await getPageLayouts(originalPdf);

  // Expand any per-signer auto-field requests into concrete placements, then combine with any
  // explicit fields the caller supplied.
  const autoRequests: AutoFieldRequest[] = [];
  input.signers.forEach((s, signerIndex) => {
    for (const type of s.autoFields ?? []) autoRequests.push({ signerIndex, type });
  });
  const autoPlaced = autoPlaceFields(layouts, autoRequests).map((p) => ({
    signerIndex: p.signerIndex,
    type: p.type,
    label: p.label,
    required: p.required,
    pageIndex: p.pageIndex,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
  }));
  const fields: CreateFieldInput[] = [...(input.fields ?? []), ...autoPlaced];

  if (fields.length === 0 && !input.prepare) {
    throw new Error("At least one field is required (explicit placements or signer autoFields)");
  }

  // Mint a sender "prepare" token so the draft can be opened in the field-placement page without
  // the backend API key. Only its hash is stored.
  const { token: prepareToken, tokenHash: prepareTokenHash } = issueToken();
  const prepareTokenExpiresAt = expiryFromNow(env.SIGNING_LINK_TTL_HOURS);

  // Validate every field's placement against the real page geometry before we store anything.
  for (const f of fields) {
    const page = layouts[f.pageIndex];
    if (!page) {
      throw new Error(`Field references page ${f.pageIndex} but the document has ${layouts.length} pages`);
    }
    if (f.signerIndex < 0 || f.signerIndex >= input.signers.length) {
      throw new Error(`Field references signer ${f.signerIndex} which does not exist`);
    }
    assertFieldWithinPage(f, page, f.pageIndex);
  }

  return prisma.$transaction(async (tx) => {
    const request = await tx.signatureRequest.create({
      data: {
        salesforceRecordId: input.salesforceRecordId,
        salesforceObjectType: input.salesforceObjectType,
        salesforceRecordType: input.salesforceRecordType ?? null,
        originalContentVersionId: input.contentVersionId,
        documentName: input.documentName,
        documentType: input.documentType ?? null,
        status: "DRAFT",
        prepareTokenHash,
        prepareTokenExpiresAt,
        docHashOriginal,
        originalPdf: toPrismaBytes(originalPdf),
      },
    });

    // Create signers, preserving order so field.signerIndex maps deterministically.
    const signerIds: string[] = [];
    for (const s of input.signers) {
      const signer = await tx.signer.create({
        data: {
          requestId: request.id,
          name: s.name,
          email: s.email,
          entityLabel: s.entityLabel ?? null,
          role: s.role ?? null,
        },
      });
      signerIds.push(signer.id);
    }

    if (fields.length > 0) {
      await tx.field.createMany({
        data: fields.map((f) => ({
          requestId: request.id,
          signerId: signerIds[f.signerIndex],
          type: f.type,
          label: f.label ?? null,
          required: f.required ?? true,
          pageIndex: f.pageIndex,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
        })),
      });
    }

    await recordAudit(tx, {
      requestId: request.id,
      eventType: "REQUEST_CREATED",
      metadata: { signers: input.signers.length, fields: fields.length },
    });

    return { requestId: request.id, signerIds, docHashOriginal, prepareToken };
  });
}

export interface FromDealInput {
  salesforceRecordId: string;
  salesforceObjectType: string;
  contentVersionId: string;
  documentName: string;
  documentType?: string; // stable key (e.g. "agency-disclosure") used to match a trusted template
}

/**
 * Create a DRAFT by routing: read the Deal's record type + party Contacts, apply the routing matrix
 * to decide who signs (resolving each role to a real person), and open it for field placement. The
 * caller (Salesforce/docgen) supplies only the deal + document; signers are derived.
 */
export async function createRequestFromDeal(input: FromDealInput) {
  const deal = await getDealParties(input.salesforceRecordId);
  const routing = computeRouting(deal);

  if (routing.signers.length === 0) {
    const reason = !routing.ruleApplied
      ? `no routing rule for record type "${deal.recordType ?? "unknown"}"`
      : `no party contacts found to sign${routing.missingRequired.length ? ` (missing: ${routing.missingRequired.join(", ")})` : ""}`;
    throw httpError(422, `Could not determine signers from the deal — ${reason}.`);
  }

  const created = await createSignatureRequest({
    salesforceRecordId: input.salesforceRecordId,
    salesforceObjectType: input.salesforceObjectType,
    salesforceRecordType: deal.recordType ?? undefined,
    contentVersionId: input.contentVersionId,
    documentName: input.documentName,
    documentType: input.documentType,
    signers: routing.signers.map((s) => ({ name: s.name, email: s.email, role: s.role })),
    prepare: true,
  });

  // Auto-send: only when a TRUSTED template matches this document type, every required signer
  // resolved, the target document's geometry MATCHES the document the template was built on,
  // and EVERY template field applied cleanly. Auto-send is a no-review path for legally binding
  // documents, so anything partial — mismatched geometry, off-page/dropped fields, unmatched
  // roles — fails closed to the human prepare page instead of sending a half-prepared document.
  let sent = false;
  let autoSendNote: string | undefined;
  const template = input.documentType ? await findAutoSendTemplate(input.documentType) : null;
  if (template && routing.missingRequired.length === 0) {
    const applied = await applyTemplateToRequestId(created.requestId, template.id, {
      requireGeometryMatch: true,
    });
    const fullyApplied =
      applied.applied > 0 &&
      !applied.geometryMismatch &&
      applied.skippedOffPage === 0 &&
      applied.skippedRoles.length === 0;

    if (fullyApplied) {
      await sendSignatureRequest(created.requestId, {
        origin: "AUTO_TEMPLATE",
        templateId: template.id,
        templateName: template.name,
        documentType: input.documentType ?? null,
        recordType: deal.recordType ?? null,
        fieldsApplied: applied.applied,
      });
      sent = true;
      autoSendNote = `Auto-sent using template "${template.name}".`;
    } else if (applied.geometryMismatch) {
      autoSendNote = `Template "${template.name}" was built on a different document layout (page count/size mismatch); review needed.`;
    } else {
      const dropped = applied.skippedOffPage + applied.skippedRoles.length;
      autoSendNote = `Template "${template.name}" applied partially (${dropped} field/role(s) could not be placed); review needed.`;
    }
  } else if (template) {
    autoSendNote = `Missing required signer(s): ${routing.missingRequired.join(", ")}; review needed.`;
  }

  return {
    requestId: created.requestId,
    prepareToken: created.prepareToken,
    recordType: deal.recordType,
    signers: routing.signers.map((s) => ({ role: s.role, name: s.name, email: s.email })),
    missingRequired: routing.missingRequired,
    sent,
    autoSendNote,
  };
}

export interface SigningLink {
  signerId: string;
  name: string;
  email: string;
  url: string;
}

/**
 * Mint a per-signer access token and move the request to SENT. Returns the signing links.
 * `sentMeta` is merged into the REQUEST_SENT audit metadata so the evidentiary trail records
 * HOW the send happened (e.g. AUTO_TEMPLATE with the template id/rule vs. a manual send).
 */
export async function sendSignatureRequest(
  requestId: string,
  sentMeta?: Record<string, string | number | boolean | null>,
): Promise<SigningLink[]> {
  const request = await prisma.signatureRequest.findUnique({
    where: { id: requestId },
    include: { signers: true },
  });
  if (!request) throw new Error(`Signature request ${requestId} not found`);
  if (request.status !== "DRAFT") {
    // Fast-path pre-check; the authoritative (race-proof) guard is the conditional
    // DRAFT→SENT update inside the transaction below.
    throw httpError(409, `Request ${requestId} was already sent (status ${request.status})`);
  }

  // A request with no fields can't be signed — block sending (a draft prepared in the placement
  // page must have at least one field placed first).
  const fieldCount = await prisma.field.count({ where: { requestId } });
  if (fieldCount === 0) {
    throw httpError(422, "Add at least one field before sending for signature.");
  }

  const links: SigningLink[] = [];

  await prisma.$transaction(async (tx) => {
    // Atomic DRAFT→SENT election. Two concurrent /send calls would otherwise both pass the
    // status pre-check and mint tokens twice — the second set silently invalidating links the
    // first call already emailed. Only the caller that wins this conditional update proceeds.
    const won = await tx.signatureRequest.updateMany({
      where: { id: requestId, status: "DRAFT" },
      data: { status: "SENT", sentAt: new Date() },
    });
    if (won.count === 0) {
      throw httpError(409, `Request ${requestId} was already sent`);
    }

    for (const signer of request.signers) {
      const { token, tokenHash } = issueToken();
      await tx.signer.update({
        where: { id: signer.id },
        data: {
          accessTokenHash: tokenHash,
          tokenExpiresAt: expiryFromNow(env.SIGNING_LINK_TTL_HOURS),
          status: "PENDING",
        },
      });
      links.push({
        signerId: signer.id,
        name: signer.name,
        email: signer.email,
        url: `${env.APP_BASE_URL}/sign/${token}`,
      });
    }

    await recordAudit(tx, {
      requestId,
      eventType: "REQUEST_SENT",
      metadata: { signers: request.signers.length, origin: "MANUAL", ...(sentMeta ?? {}) },
    });
  });

  logger.info({ requestId, signers: links.length }, "Signature request sent");

  // Email each signer their link. Best-effort: a delivery failure must not undo the SENT state or
  // fail this call — the links are returned below for manual delivery / a later /resend.
  try {
    await sendSigningInvitations(requestId, links);
  } catch (err) {
    logger.error({ requestId, err }, "Signing invitations could not be sent");
  }

  return links;
}

/**
 * Re-mint each unsigned signer's token and email a fresh signing link. Used when an invitation was
 * missed or the original link expired. Only signers who haven't SIGNED/DECLINED are refreshed; the
 * raw token is never recoverable (only its hash is stored), so a "resend" is necessarily a new link
 * — any previously sent link for that signer stops working.
 */
export async function resendSignatureRequest(requestId: string): Promise<SigningLink[]> {
  const request = await prisma.signatureRequest.findUnique({
    where: { id: requestId },
    include: { signers: true },
  });
  if (!request) throw new Error(`Signature request ${requestId} not found`);
  if (request.status !== "SENT" && request.status !== "PARTIALLY_SIGNED") {
    const err = new Error(`Request ${requestId} is ${request.status}; only SENT/PARTIALLY_SIGNED can be resent`);
    (err as { statusCode?: number }).statusCode = 409;
    throw err;
  }

  const pending = request.signers.filter((s) => s.status !== "SIGNED" && s.status !== "DECLINED");
  if (pending.length === 0) return [];

  const links: SigningLink[] = [];
  await prisma.$transaction(async (tx) => {
    for (const signer of pending) {
      const { token, tokenHash } = issueToken();
      await tx.signer.update({
        where: { id: signer.id },
        data: {
          accessTokenHash: tokenHash,
          tokenExpiresAt: expiryFromNow(env.SIGNING_LINK_TTL_HOURS),
        },
      });
      links.push({
        signerId: signer.id,
        name: signer.name,
        email: signer.email,
        url: `${env.APP_BASE_URL}/sign/${token}`,
      });
    }
  });

  try {
    await sendSigningInvitations(requestId, links);
  } catch (err) {
    logger.error({ requestId, err }, "Resent signing invitations could not be sent");
  }

  logger.info({ requestId, signers: links.length }, "Signature request resent");
  return links;
}

/* ---------- Sender "prepare" (field placement) ---------- */

/** Resolve a prepare token to its DRAFT request, enforcing existence, DRAFT status, and expiry. */
export async function resolvePrepareToken(token: string) {
  const tokenHash = hashToken(token);
  const request = await prisma.signatureRequest.findFirst({
    where: { prepareTokenHash: tokenHash },
    include: { signers: { orderBy: { createdAt: "asc" } } },
  });
  if (!request) throw httpError(404, "Invalid or unknown preparation link");
  if (request.status !== "DRAFT") {
    throw httpError(409, "This request has already been sent and can no longer be edited.");
  }
  if (request.prepareTokenExpiresAt && request.prepareTokenExpiresAt.getTime() < Date.now()) {
    throw httpError(410, "This preparation link has expired.");
  }
  return request;
}

/** Everything the prepare page needs: document name, signers, page geometry, current fields. */
export async function getPrepareContext(token: string) {
  const request = await resolvePrepareToken(token);
  const layouts = request.originalPdf
    ? await getPageLayouts(Buffer.from(request.originalPdf))
    : [];
  const fields = await prisma.field.findMany({
    where: { requestId: request.id },
    orderBy: [{ pageIndex: "asc" }, { y: "asc" }],
  });
  // The prepare page works in signer *indexes* (matching CreateFieldInput); map id -> index.
  const indexById = new Map(request.signers.map((s, i) => [s.id, i]));
  return {
    request: {
      id: request.id,
      documentName: request.documentName,
      documentType: request.documentType,
      status: request.status,
    },
    signers: request.signers.map((s, i) => ({
      index: i,
      id: s.id,
      name: s.name,
      entityLabel: s.entityLabel,
      role: s.role,
    })),
    pages: layouts,
    fields: fields.map((f) => ({
      signerIndex: indexById.get(f.signerId) ?? 0,
      type: f.type,
      label: f.label,
      required: f.required,
      pageIndex: f.pageIndex,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
    })),
  };
}

/** The source PDF bytes for a prepare token (the placement page renders them with pdf.js). */
export async function getPrepareDocument(token: string): Promise<Buffer> {
  const request = await resolvePrepareToken(token);
  if (!request.originalPdf) throw new Error("Source document is missing");
  return Buffer.from(request.originalPdf);
}

export interface PlaceFieldInput {
  signerIndex: number;
  type: FieldType;
  label?: string;
  required?: boolean;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Replace the entire field set on a DRAFT (the placement page saves the whole layout at once). */
export async function replaceDraftFields(token: string, fields: PlaceFieldInput[]) {
  const request = await resolvePrepareToken(token);
  const layouts = request.originalPdf
    ? await getPageLayouts(Buffer.from(request.originalPdf))
    : [];

  for (const f of fields) {
    const page = layouts[f.pageIndex];
    if (!page) {
      throw httpError(400, `Field references page ${f.pageIndex} but the document has ${layouts.length} pages`);
    }
    if (f.signerIndex < 0 || f.signerIndex >= request.signers.length) {
      throw httpError(400, `Field references signer ${f.signerIndex} which does not exist`);
    }
    if (f.width <= 0 || f.height <= 0) throw httpError(400, "Field width and height must be positive");
    assertFieldWithinPage(f, page, f.pageIndex);
  }

  const signerIds = request.signers.map((s) => s.id);
  await prisma.$transaction(async (tx) => {
    await tx.field.deleteMany({ where: { requestId: request.id } });
    if (fields.length > 0) {
      await tx.field.createMany({
        data: fields.map((f) => ({
          requestId: request.id,
          signerId: signerIds[f.signerIndex],
          type: f.type,
          label: f.label ?? null,
          required: f.required ?? true,
          pageIndex: f.pageIndex,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
        })),
      });
    }
  });
  return { fields: fields.length };
}

/** Send a DRAFT identified by its prepare token (mints signer links + emails them). */
export async function sendDraftByPrepareToken(token: string): Promise<SigningLink[]> {
  const request = await resolvePrepareToken(token);
  return sendSignatureRequest(request.id);
}

/** Resolve a presented token to its signer, enforcing existence + expiry. */
async function resolveSigner(token: string) {
  const tokenHash = hashToken(token);
  const signer = await prisma.signer.findFirst({
    where: { accessTokenHash: tokenHash },
    include: { request: true },
  });
  if (!signer) {
    const err = new Error("Invalid or unknown signing link");
    (err as { statusCode?: number }).statusCode = 404;
    throw err;
  }
  if (signer.tokenExpiresAt && signer.tokenExpiresAt.getTime() < Date.now()) {
    const err = new Error("This signing link has expired");
    (err as { statusCode?: number }).statusCode = 410;
    throw err;
  }
  return signer;
}

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

/** Data the portal needs to render the signing experience for one signer. */
export async function getSignerContext(token: string, ctx: RequestContext) {
  const signer = await resolveSigner(token);

  // Record LINK_OPENED only on the FIRST open (the PENDING→VIEWED transition). The portal
  // refetches this context on refresh/poll; logging every fetch would flood the audit trail —
  // and the certificate timeline — with duplicate events and dilute the evidentiary record.
  if (signer.status === "PENDING") {
    await prisma.$transaction(async (tx) => {
      await recordAudit(tx, {
        requestId: signer.requestId,
        signerId: signer.id,
        eventType: "LINK_OPENED",
        authMethod: signer.authMethod,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
      });
      await tx.signer.update({ where: { id: signer.id }, data: { status: "VIEWED" } });
    });
  }

  const fields = await prisma.field.findMany({
    where: { requestId: signer.requestId, signerId: signer.id },
    orderBy: [{ pageIndex: "asc" }, { y: "asc" }],
  });
  const layouts = signer.request.originalPdf
    ? await getPageLayouts(Buffer.from(signer.request.originalPdf))
    : [];

  return {
    signer: {
      id: signer.id,
      name: signer.name,
      email: signer.email,
      entityLabel: signer.entityLabel,
      status: signer.status === "PENDING" ? "VIEWED" : signer.status,
      consented: signer.consentedAt != null,
    },
    request: {
      id: signer.requestId,
      documentName: signer.request.documentName,
      status: signer.request.status,
    },
    consent: consentDisclosure(),
    pages: layouts,
    fields: fields.map((f) => ({
      id: f.id,
      type: f.type,
      label: f.label,
      required: f.required,
      pageIndex: f.pageIndex,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      value: f.value,
    })),
  };
}

/** The original document bytes for a signer's token (for the portal to render). */
export async function getSignerDocument(token: string): Promise<Buffer> {
  const signer = await resolveSigner(token);
  if (!signer.request.originalPdf) throw new Error("Source document is missing");
  return Buffer.from(signer.request.originalPdf);
}

/**
 * The flattened signed PDF for a signer's token, once the whole request is COMPLETED. Lets a
 * signer download their own copy for their records without exposing the sender API key. Returns
 * a 409 until completion (the signed/flattened PDF only exists once every signer has signed).
 */
export async function getSignedDocumentForToken(
  token: string,
): Promise<{ name: string; bytes: Buffer }> {
  const signer = await resolveSigner(token);
  if (signer.request.status !== "COMPLETED" || !signer.request.signedPdf) {
    const err = new Error("The signed document isn't ready yet.");
    (err as { statusCode?: number }).statusCode = 409;
    throw err;
  }
  return { name: signer.request.documentName, bytes: Buffer.from(signer.request.signedPdf) };
}

/** Record the signer's affirmative ESIGN/UETA consent. Must precede signing. */
export async function recordSignerConsent(token: string, ctx: RequestContext) {
  const signer = await resolveSigner(token);
  const rs = signer.request.status;
  if (rs === "COMPLETED" || rs === "DECLINED" || rs === "VOIDED") {
    throw httpError(409, `This document is no longer open for consent (request is ${rs.toLowerCase()}).`);
  }
  const disclosure = consentDisclosure();

  await prisma.$transaction(async (tx) => {
    await tx.signer.update({
      where: { id: signer.id },
      data: {
        status: signer.status === "SIGNED" ? signer.status : "CONSENTED",
        consentText: disclosure.text,
        consentVersion: disclosure.version,
        consentedAt: new Date(),
        consentIp: ctx.ip ?? null,
        consentUserAgent: ctx.userAgent ?? null,
      },
    });
    await recordAudit(tx, {
      requestId: signer.requestId,
      signerId: signer.id,
      eventType: "CONSENT_GIVEN",
      authMethod: signer.authMethod,
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { consentVersion: disclosure.version },
    });
  });

  return { consented: true, version: disclosure.version };
}

export interface SubmittedFieldValue {
  fieldId: string;
  value: string; // image data URL for signature/initials; string for date/text
}

/**
 * Apply a signer's field values and mark them SIGNED. If this was the last outstanding signer,
 * flatten all fields into the PDF, hash it, and complete the request.
 */
export async function submitSignerFields(
  token: string,
  values: SubmittedFieldValue[],
  ctx: RequestContext,
) {
  const signer = await resolveSigner(token);

  if (!signer.consentedAt) {
    const err = new Error("Consent to electronic records is required before signing");
    (err as { statusCode?: number }).statusCode = 412;
    throw err;
  }
  if (signer.status === "SIGNED") {
    return { status: "ALREADY_SIGNED" as const, requestStatus: signer.request.status };
  }

  const myFields = await prisma.field.findMany({
    where: { requestId: signer.requestId, signerId: signer.id },
  });
  const valueByField = new Map(values.map((v) => [v.fieldId, v.value]));

  // Every required field assigned to this signer must have a non-empty value.
  for (const f of myFields) {
    const v = valueByField.get(f.id);
    if (f.required && (!v || v.trim() === "")) {
      const err = new Error(`Required field "${f.label ?? f.type}" was not completed`);
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
    // Reject values for fields that aren't this signer's.
  }
  for (const v of values) {
    if (!myFields.some((f) => f.id === v.fieldId)) {
      const err = new Error("A submitted field does not belong to this signer");
      (err as { statusCode?: number }).statusCode = 400;
      throw err;
    }
  }

  // Apply the values, mark this signer SIGNED, and decide the request transition — all while
  // holding a row lock on the request. Without the lock, two final signers submitting at the
  // same moment is a classic check-then-act race: both could see "someone still unsigned" (each
  // missing the other's uncommitted update) and the request never completes, or in the inverse
  // interleaving both could elect completion and write back twice. The lock serializes the
  // count+transition per request; the guarded updateMany makes exactly one caller the winner.
  const transition = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM signature_requests WHERE id = ${signer.requestId}::uuid FOR UPDATE`;

    // Re-read status under the lock: a decline/void/completion may have landed since resolve.
    const fresh = await tx.signatureRequest.findUniqueOrThrow({
      where: { id: signer.requestId },
      select: { status: true },
    });
    if (fresh.status === "COMPLETED" || fresh.status === "DECLINED" || fresh.status === "VOIDED") {
      throw httpError(409, `This document can no longer be signed (request is ${fresh.status.toLowerCase()}).`);
    }

    for (const f of myFields) {
      const v = valueByField.get(f.id);
      if (v !== undefined) {
        await tx.field.update({ where: { id: f.id }, data: { value: v } });
        await recordAudit(tx, {
          requestId: signer.requestId,
          signerId: signer.id,
          eventType: "FIELD_FILLED",
          metadata: { fieldId: f.id, fieldType: f.type },
        });
      }
    }
    await tx.signer.update({
      where: { id: signer.id },
      data: { status: "SIGNED", signedAt: new Date() },
    });
    await recordAudit(tx, {
      requestId: signer.requestId,
      signerId: signer.id,
      eventType: "SIGNED",
      authMethod: signer.authMethod,
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });

    // In-transaction count (sees this signer's update; the lock guarantees no concurrent writer).
    const remaining = await tx.signer.count({
      where: { requestId: signer.requestId, status: { not: "SIGNED" } },
    });

    if (remaining > 0) {
      // Guarded so a stale submit can never stomp a terminal status.
      await tx.signatureRequest.updateMany({
        where: { id: signer.requestId, status: { in: ["SENT", "PARTIALLY_SIGNED"] } },
        data: { status: "PARTIALLY_SIGNED" },
      });
      return "PARTIALLY_SIGNED" as const;
    }

    // Single-winner completion election: only the caller whose update matches proceeds to the
    // (heavyweight) finalize + write-back outside the lock.
    const won = await tx.signatureRequest.updateMany({
      where: { id: signer.requestId, status: { in: ["SENT", "PARTIALLY_SIGNED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    return won.count === 1 ? ("WON_COMPLETION" as const) : ("COMPLETED" as const);
  });

  if (transition === "PARTIALLY_SIGNED") {
    return { status: "SIGNED" as const, requestStatus: "PARTIALLY_SIGNED" as const };
  }
  if (transition === "WON_COMPLETION") {
    await completeRequest(signer.requestId, ctx);
  }
  return { status: "SIGNED" as const, requestStatus: "COMPLETED" as const };
}

/**
 * Completion pipeline, run only by the single submit that won the COMPLETED election:
 * flatten + hash + persist the signed PDF (finalizeCompletion, idempotent), generate the
 * Certificate of Completion, then attempt the Salesforce write-back. If the process dies
 * anywhere in here, the write-back retry endpoint re-runs the same idempotent steps.
 */
async function completeRequest(requestId: string, ctx: RequestContext) {
  await finalizeCompletion(requestId, ctx);
  await generateCertificate(requestId);

  // Best-effort: a write-back failure is recorded as WRITEBACK_FAILED and is retryable via
  // POST /api/requests/:id/writeback — it must not break the signer's response.
  try {
    await attemptWriteback(requestId, ctx);
  } catch (err) {
    logger.error({ requestId, err }, "Deferred write-back; will need retry");
  }
}

/**
 * A signer declines. Declining voids the whole request for v1 (single-document semantics) —
 * but only while the request is still in flight. A COMPLETED request is an executed document
 * and can never be flipped to DECLINED by a late/replayed link; that would make the status
 * contradict the immutable audit trail.
 */
export async function declineSignature(
  token: string,
  reason: string | undefined,
  ctx: RequestContext,
) {
  const signer = await resolveSigner(token);
  if (signer.status === "DECLINED") {
    return { status: "DECLINED" as const }; // idempotent re-click
  }

  await prisma.$transaction(async (tx) => {
    // Same lock as submit so a decline racing the final signature serializes cleanly.
    await tx.$queryRaw`SELECT id FROM signature_requests WHERE id = ${signer.requestId}::uuid FOR UPDATE`;

    const voided = await tx.signatureRequest.updateMany({
      where: { id: signer.requestId, status: { in: ["SENT", "PARTIALLY_SIGNED"] } },
      data: { status: "DECLINED" },
    });
    if (voided.count === 0) {
      const fresh = await tx.signatureRequest.findUniqueOrThrow({
        where: { id: signer.requestId },
        select: { status: true },
      });
      throw httpError(409, `This document can no longer be declined (request is ${fresh.status.toLowerCase()}).`);
    }

    await tx.signer.update({ where: { id: signer.id }, data: { status: "DECLINED" } });
    await recordAudit(tx, {
      requestId: signer.requestId,
      signerId: signer.id,
      eventType: "DECLINED",
      authMethod: signer.authMethod,
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: reason ? { reason } : undefined,
    });
  });
  return { status: "DECLINED" as const };
}

/** The flattened signed PDF for a completed request (sender download). */
export async function getSignedPdf(requestId: string): Promise<{ name: string; bytes: Buffer } | null> {
  const request = await prisma.signatureRequest.findUnique({ where: { id: requestId } });
  if (!request?.signedPdf) return null;
  return { name: request.documentName, bytes: Buffer.from(request.signedPdf) };
}

/** The Certificate of Completion PDF for a request (sender download). */
export async function getCertificatePdf(requestId: string): Promise<{ name: string; bytes: Buffer } | null> {
  const request = await prisma.signatureRequest.findUnique({ where: { id: requestId } });
  if (!request?.certificatePdf) return null;
  return { name: request.documentName, bytes: Buffer.from(request.certificatePdf) };
}

/** Sender-facing status view of a request (no PDF bytes). */
export async function getRequestStatus(requestId: string) {
  const request = await prisma.signatureRequest.findUnique({
    where: { id: requestId },
    include: {
      signers: { orderBy: { createdAt: "asc" } },
      auditEvents: { orderBy: { occurredAt: "asc" } },
    },
  });
  if (!request) return null;

  return {
    id: request.id,
    documentName: request.documentName,
    status: request.status,
    salesforceRecordId: request.salesforceRecordId,
    salesforceObjectType: request.salesforceObjectType,
    docHashOriginal: request.docHashOriginal,
    docHashFinal: request.docHashFinal,
    createdAt: request.createdAt,
    sentAt: request.sentAt,
    completedAt: request.completedAt,
    signers: request.signers.map((s) => ({
      id: s.id,
      name: s.name,
      email: s.email,
      entityLabel: s.entityLabel,
      role: s.role,
      status: s.status,
      consentedAt: s.consentedAt,
      signedAt: s.signedAt,
    })),
    auditTrail: request.auditEvents.map((e) => ({
      eventType: e.eventType,
      signerId: e.signerId,
      ipAddress: e.ipAddress,
      userAgent: e.userAgent,
      occurredAt: e.occurredAt,
      metadata: e.metadata as Prisma.JsonValue,
    })),
  };
}
