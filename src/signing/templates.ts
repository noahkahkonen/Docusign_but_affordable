import type { FieldType, SignerRole } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { getPageLayouts } from "./pdf.js";
import { resolvePrepareToken } from "./requests.js";

/**
 * Reusable field-placement templates. A template stores placements keyed by ROLE, so it can be
 * applied to any future draft by mapping each role to whichever signer plays it on that deal.
 * Saving and applying happen in the context of a draft (the browser prepare page), authenticated
 * by the draft's prepare token — see routes/prepare.ts.
 */

function httpError(status: number, message: string): Error {
  const err = new Error(message);
  (err as { statusCode?: number }).statusCode = status;
  return err;
}

export interface RoleFieldInput {
  role: SignerRole;
  type: FieldType;
  label?: string;
  required?: boolean;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SaveTemplateOptions {
  documentType?: string; // stable match key; defaults to the request's documentType/name
  autoSend?: boolean; // mark trusted so the docgen flow sends without review
}

/** Tolerance (PDF points) when comparing page sizes / bounds — absorbs float noise, not layout drift. */
const GEOMETRY_EPSILON = 1;

type PageSize = { w: number; h: number };

function pageSizesOf(layouts: { width: number; height: number }[]): PageSize[] {
  return layouts.map((l) => ({ w: l.width, h: l.height }));
}

/** True when a field rectangle lies (within epsilon) inside its page. */
function fieldOnPage(
  f: { x: number; y: number; width: number; height: number },
  page: { width: number; height: number },
): boolean {
  return (
    f.x >= -GEOMETRY_EPSILON &&
    f.y >= -GEOMETRY_EPSILON &&
    f.x + f.width <= page.width + GEOMETRY_EPSILON &&
    f.y + f.height <= page.height + GEOMETRY_EPSILON
  );
}

/** Save the supplied role-keyed placements as a new named template (labelled by the draft's doc). */
export async function saveTemplateFromDraft(
  token: string,
  name: string,
  fields: RoleFieldInput[],
  options: SaveTemplateOptions = {},
) {
  const request = await resolvePrepareToken(token);
  if (fields.length === 0) throw httpError(400, "Place at least one field before saving a template.");

  // Validate placements against the source document's real geometry, and capture that geometry
  // on the template so auto-send can later refuse to apply it to a different document.
  const layouts = request.originalPdf ? await getPageLayouts(Buffer.from(request.originalPdf)) : [];
  for (const f of fields) {
    const page = layouts[f.pageIndex];
    if (!page) {
      throw httpError(422, `Field references page ${f.pageIndex + 1} but the document has ${layouts.length} page(s).`);
    }
    if (!fieldOnPage(f, page)) {
      throw httpError(422, `A ${f.type} field for ${f.role} lies outside page ${f.pageIndex + 1}'s bounds.`);
    }
  }

  const template = await prisma.template.create({
    data: {
      name,
      documentType: options.documentType ?? request.documentType ?? request.documentName,
      autoSend: options.autoSend ?? false,
      sourcePageCount: layouts.length || null,
      sourcePageSizes: layouts.length ? pageSizesOf(layouts) : undefined,
      fields: {
        create: fields.map((f) => ({
          role: f.role,
          type: f.type,
          label: f.label ?? null,
          required: f.required ?? true,
          pageIndex: f.pageIndex,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
        })),
      },
    },
    include: { fields: true },
  });
  return { id: template.id, name: template.name, fieldCount: template.fields.length };
}

/** All templates, newest first, with a summary of the roles they cover. */
export async function listTemplates() {
  const templates = await prisma.template.findMany({
    orderBy: { updatedAt: "desc" },
    include: { fields: { select: { role: true } } },
  });
  return templates.map((t) => ({
    id: t.id,
    name: t.name,
    documentType: t.documentType,
    autoSend: t.autoSend,
    fieldCount: t.fields.length,
    roles: [...new Set(t.fields.map((f) => f.role))],
    updatedAt: t.updatedAt,
  }));
}

export interface ApplyResult {
  applied: number;
  skippedRoles: SignerRole[]; // template roles with no matching signer on this draft
  skippedOffPage: number; // fields whose page doesn't exist or whose rect falls outside the page
  /** Set when geometry matching was required and the target document doesn't match the
   *  template's source (page count or page sizes differ). Nothing was applied. */
  geometryMismatch?: boolean;
  fields: Array<{
    signerIndex: number;
    type: FieldType;
    label: string | null;
    required: boolean;
    pageIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

/**
 * Apply a template to a draft: map each template field's role to the draft's signer with that role
 * and replace the draft's field set. Template fields whose role isn't on the draft, or whose page
 * doesn't exist in this document, are skipped and reported (never silently dropped).
 */
export async function applyTemplateToDraft(token: string, templateId: string): Promise<ApplyResult> {
  const request = await resolvePrepareToken(token);
  const template = await prisma.template.findUnique({
    where: { id: templateId },
    include: { fields: true },
  });
  if (!template) throw httpError(404, "Template not found.");
  return applyTemplateToRequest(request, template);
}

/** The newest trusted (autoSend) template matching a document-type key, or null. */
export async function findAutoSendTemplate(documentType: string) {
  return prisma.template.findFirst({
    where: { documentType, autoSend: true },
    orderBy: { updatedAt: "desc" },
    include: { fields: true },
  });
}

type RequestWithSigners = { id: string; originalPdf: Uint8Array | null; signers: { id: string; role: SignerRole | null }[] };
type TemplateWithFields = {
  fields: { role: SignerRole; type: FieldType; label: string | null; required: boolean; pageIndex: number; x: number; y: number; width: number; height: number }[];
  sourcePageCount?: number | null;
  sourcePageSizes?: unknown;
};

export interface ApplyOptions {
  /** Refuse (apply nothing, set geometryMismatch) unless the target document's page count and
   *  sizes match the geometry the template was built on. REQUIRED for the no-review auto-send
   *  path; the manual prepare page may apply loosely since a human reviews the result. */
  requireGeometryMatch?: boolean;
}

/** Apply a template by request id (used by the auto-send/from-deal path). */
export async function applyTemplateToRequestId(
  requestId: string,
  templateId: string,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const request = await prisma.signatureRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { signers: { orderBy: { createdAt: "asc" } } },
  });
  const template = await prisma.template.findUnique({ where: { id: templateId }, include: { fields: true } });
  if (!template) throw httpError(404, "Template not found.");
  return applyTemplateToRequest(
    { id: request.id, originalPdf: request.originalPdf ? Buffer.from(request.originalPdf) : null, signers: request.signers },
    template,
    options,
  );
}

/** Target document matches the template's recorded source geometry (count + per-page size). */
function geometryMatches(template: TemplateWithFields, layouts: { width: number; height: number }[]): boolean {
  if (template.sourcePageCount == null || !Array.isArray(template.sourcePageSizes)) {
    // Legacy template with no recorded geometry: cannot verify — treat as NOT matching so the
    // no-review path fails closed (re-save the template to record geometry).
    return false;
  }
  if (template.sourcePageCount !== layouts.length) return false;
  const sizes = template.sourcePageSizes as Array<{ w?: number; h?: number }>;
  if (sizes.length !== layouts.length) return false;
  return layouts.every((page, i) => {
    const s = sizes[i];
    return (
      typeof s?.w === "number" &&
      typeof s?.h === "number" &&
      Math.abs(s.w - page.width) <= GEOMETRY_EPSILON &&
      Math.abs(s.h - page.height) <= GEOMETRY_EPSILON
    );
  });
}

async function applyTemplateToRequest(
  request: RequestWithSigners,
  template: TemplateWithFields,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const layouts = request.originalPdf ? await getPageLayouts(Buffer.from(request.originalPdf)) : [];

  if (options.requireGeometryMatch && !geometryMatches(template, layouts)) {
    return { applied: 0, skippedRoles: [], skippedOffPage: 0, geometryMismatch: true, fields: [] };
  }

  // role -> { signerId, index } using the FIRST signer that plays each role.
  const signerByRole = new Map<SignerRole, { id: string; index: number }>();
  request.signers.forEach((s, index) => {
    if (s.role && !signerByRole.has(s.role)) signerByRole.set(s.role, { id: s.id, index });
  });

  const skippedRoles = new Set<SignerRole>();
  let skippedOffPage = 0;
  const toCreate: Array<{ signerId: string; index: number; tf: (typeof template.fields)[number] }> = [];
  for (const tf of template.fields) {
    const signer = signerByRole.get(tf.role);
    if (!signer) { skippedRoles.add(tf.role); continue; }
    const page = layouts[tf.pageIndex];
    if (!page || !fieldOnPage(tf, page)) { skippedOffPage += 1; continue; }
    toCreate.push({ signerId: signer.id, index: signer.index, tf });
  }

  await prisma.$transaction(async (tx) => {
    await tx.field.deleteMany({ where: { requestId: request.id } });
    if (toCreate.length > 0) {
      await tx.field.createMany({
        data: toCreate.map(({ signerId, tf }) => ({
          requestId: request.id,
          signerId,
          type: tf.type,
          label: tf.label,
          required: tf.required,
          pageIndex: tf.pageIndex,
          x: tf.x,
          y: tf.y,
          width: tf.width,
          height: tf.height,
        })),
      });
    }
  });

  return {
    applied: toCreate.length,
    skippedRoles: [...skippedRoles],
    skippedOffPage,
    fields: toCreate.map(({ index, tf }) => ({
      signerIndex: index,
      type: tf.type,
      label: tf.label,
      required: tf.required,
      pageIndex: tf.pageIndex,
      x: tf.x,
      y: tf.y,
      width: tf.width,
      height: tf.height,
    })),
  };
}
