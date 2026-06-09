import type { FieldType, Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { sha256, toPrismaBytes } from "../lib/hash.js";
import { downloadFileBytes } from "../salesforce/files.js";
import { recordAudit } from "./audit.js";
import { issueToken, hashToken, expiryFromNow } from "./tokens.js";
import { consentDisclosure } from "./consent.js";
import { flattenFields, getPageLayouts, type FieldPlacement } from "./pdf.js";
import { autoPlaceFields, type AutoFieldRequest } from "./layout.js";
import { generateCertificate, attemptWriteback } from "./writeback.js";
import { sendSigningInvitations } from "./notifications.js";

/**
 * Signature request lifecycle: create (draft) -> send (mint tokens) -> per-signer open/consent/
 * sign -> complete (flatten + hash). Signers are parallel by default; the request completes once
 * every signer has signed.
 */

export interface CreateSignerInput {
  name: string;
  email: string;
  entityLabel?: string;
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
  contentVersionId: string; // the source PDF in Salesforce
  documentName: string;
  signers: CreateSignerInput[];
  /** Explicit field placements. Optional when signers use autoFields. */
  fields?: CreateFieldInput[];
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

  if (fields.length === 0) {
    throw new Error("At least one field is required (explicit placements or signer autoFields)");
  }

  // Validate every field's placement against the real page geometry before we store anything.
  for (const f of fields) {
    const page = layouts[f.pageIndex];
    if (!page) {
      throw new Error(`Field references page ${f.pageIndex} but the document has ${layouts.length} pages`);
    }
    if (f.signerIndex < 0 || f.signerIndex >= input.signers.length) {
      throw new Error(`Field references signer ${f.signerIndex} which does not exist`);
    }
  }

  return prisma.$transaction(async (tx) => {
    const request = await tx.signatureRequest.create({
      data: {
        salesforceRecordId: input.salesforceRecordId,
        salesforceObjectType: input.salesforceObjectType,
        originalContentVersionId: input.contentVersionId,
        documentName: input.documentName,
        status: "DRAFT",
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

    return { requestId: request.id, signerIds, docHashOriginal };
  });
}

export interface SigningLink {
  signerId: string;
  name: string;
  email: string;
  url: string;
}

/** Mint a per-signer access token and move the request to SENT. Returns the signing links. */
export async function sendSignatureRequest(requestId: string): Promise<SigningLink[]> {
  const request = await prisma.signatureRequest.findUnique({
    where: { id: requestId },
    include: { signers: true },
  });
  if (!request) throw new Error(`Signature request ${requestId} not found`);
  if (request.status !== "DRAFT") {
    throw new Error(`Request ${requestId} is ${request.status}, expected DRAFT`);
  }

  const links: SigningLink[] = [];

  await prisma.$transaction(async (tx) => {
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

    await tx.signatureRequest.update({
      where: { id: requestId },
      data: { status: "SENT", sentAt: new Date() },
    });

    await recordAudit(tx, {
      requestId,
      eventType: "REQUEST_SENT",
      metadata: { signers: request.signers.length },
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

  // Record the open exactly once per session-ish; we always log LINK_OPENED on fetch and mark
  // the signer VIEWED if they were merely PENDING.
  await prisma.$transaction(async (tx) => {
    await recordAudit(tx, {
      requestId: signer.requestId,
      signerId: signer.id,
      eventType: "LINK_OPENED",
      authMethod: signer.authMethod,
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
    });
    if (signer.status === "PENDING") {
      await tx.signer.update({ where: { id: signer.id }, data: { status: "VIEWED" } });
    }
  });

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

/** Record the signer's affirmative ESIGN/UETA consent. Must precede signing. */
export async function recordSignerConsent(token: string, ctx: RequestContext) {
  const signer = await resolveSigner(token);
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

  await prisma.$transaction(async (tx) => {
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
  });

  // Are all signers done?
  const remaining = await prisma.signer.count({
    where: { requestId: signer.requestId, status: { not: "SIGNED" } },
  });

  if (remaining > 0) {
    await prisma.signatureRequest.update({
      where: { id: signer.requestId },
      data: { status: "PARTIALLY_SIGNED" },
    });
    return { status: "SIGNED" as const, requestStatus: "PARTIALLY_SIGNED" as const };
  }

  await completeRequest(signer.requestId, ctx);
  return { status: "SIGNED" as const, requestStatus: "COMPLETED" as const };
}

/**
 * Flatten every signer's fields into the source PDF, hash the result, and mark COMPLETED.
 * (Certificate of Completion + Salesforce write-back are M3.)
 */
async function completeRequest(requestId: string, ctx: RequestContext) {
  const request = await prisma.signatureRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { fields: true },
  });
  if (!request.originalPdf) throw new Error("Source document missing; cannot complete");

  const placements: FieldPlacement[] = request.fields
    .filter((f) => f.value != null && f.value !== "")
    .map((f) => ({
      type: f.type as FieldPlacement["type"],
      pageIndex: f.pageIndex,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      value: f.value as string,
    }));

  const signedPdf = await flattenFields(Buffer.from(request.originalPdf), placements);
  const docHashFinal = sha256(signedPdf);

  await prisma.$transaction(async (tx) => {
    await tx.signatureRequest.update({
      where: { id: requestId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        signedPdf: toPrismaBytes(signedPdf),
        docHashFinal,
      },
    });
    await recordAudit(tx, {
      requestId,
      eventType: "COMPLETED",
      ipAddress: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { docHashFinal },
    });
  });

  logger.info({ requestId, docHashFinal }, "Signature request completed");

  // Produce the Certificate of Completion (pure, always) then attempt the Salesforce write-back.
  // The write-back is best-effort here: a failure is recorded as WRITEBACK_FAILED and can be
  // retried via POST /api/requests/:id/writeback — it must not break the signer's response.
  await generateCertificate(requestId);
  try {
    await attemptWriteback(requestId, ctx);
  } catch (err) {
    logger.error({ requestId, err }, "Deferred write-back; will need retry");
  }
}

/** A signer declines. Declining voids the whole request for v1 (single-document semantics). */
export async function declineSignature(
  token: string,
  reason: string | undefined,
  ctx: RequestContext,
) {
  const signer = await resolveSigner(token);
  await prisma.$transaction(async (tx) => {
    await tx.signer.update({ where: { id: signer.id }, data: { status: "DECLINED" } });
    await tx.signatureRequest.update({
      where: { id: signer.requestId },
      data: { status: "DECLINED" },
    });
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
