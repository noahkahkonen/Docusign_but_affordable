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

/** Save the supplied role-keyed placements as a new named template (labelled by the draft's doc). */
export async function saveTemplateFromDraft(
  token: string,
  name: string,
  fields: RoleFieldInput[],
  options: SaveTemplateOptions = {},
) {
  const request = await resolvePrepareToken(token);
  if (fields.length === 0) throw httpError(400, "Place at least one field before saving a template.");

  const template = await prisma.template.create({
    data: {
      name,
      documentType: options.documentType ?? request.documentType ?? request.documentName,
      autoSend: options.autoSend ?? false,
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
  skippedOffPage: number; // fields whose page doesn't exist in this document
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
type TemplateWithFields = { fields: { role: SignerRole; type: FieldType; label: string | null; required: boolean; pageIndex: number; x: number; y: number; width: number; height: number }[] };

/** Apply a template by request id (used by the auto-send/from-deal path). */
export async function applyTemplateToRequestId(requestId: string, templateId: string): Promise<ApplyResult> {
  const request = await prisma.signatureRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { signers: { orderBy: { createdAt: "asc" } } },
  });
  const template = await prisma.template.findUnique({ where: { id: templateId }, include: { fields: true } });
  if (!template) throw httpError(404, "Template not found.");
  return applyTemplateToRequest(
    { id: request.id, originalPdf: request.originalPdf ? Buffer.from(request.originalPdf) : null, signers: request.signers },
    template,
  );
}

async function applyTemplateToRequest(
  request: RequestWithSigners,
  template: TemplateWithFields,
): Promise<ApplyResult> {
  const layouts = request.originalPdf ? await getPageLayouts(Buffer.from(request.originalPdf)) : [];

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
    if (!layouts[tf.pageIndex]) { skippedOffPage += 1; continue; }
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
