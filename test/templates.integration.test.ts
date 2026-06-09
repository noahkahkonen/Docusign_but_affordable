import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/**
 * Template save/list/apply against a real Postgres (Salesforce file download mocked). Verifies a
 * layout saved against roles re-applies to whoever plays that role on a new draft, and that roles
 * with no matching signer are skipped (not silently dropped).
 *
 * Runs only when RUN_DB_TESTS=1 and DATABASE_URL points at a reachable database (CI sets both).
 */

const holder = vi.hoisted(() => ({ pdf: null as Buffer | null }));
vi.mock("../src/salesforce/files.js", () => ({
  downloadFileBytes: vi.fn(async () => holder.pdf),
  isSalesforceId: () => true,
}));

const run = process.env.RUN_DB_TESTS === "1";

describe.runIf(run)("templates (integration)", () => {
  let reqMod: typeof import("../src/signing/requests.js");
  let tplMod: typeof import("../src/signing/templates.js");
  let prismaMod: typeof import("../src/db/prisma.js");
  let templateId: string;

  async function newDraft(signers: { name: string; email: string; role: "BUYER" | "SELLER" }[]) {
    const created = await reqMod.createSignatureRequest({
      salesforceRecordId: "a0LPe00001IBd1ZMAT",
      salesforceObjectType: "TTL_Core__Deal__c",
      contentVersionId: "068Pe0000196OGTIA2",
      documentName: "Agency Disclosure.pdf",
      signers,
      prepare: true,
    });
    return created.prepareToken;
  }

  beforeAll(async () => {
    const { createSimplePdf } = await import("../src/signing/pdf.js");
    holder.pdf = await createSimplePdf("Agency Disclosure — template fixture");
    reqMod = await import("../src/signing/requests.js");
    tplMod = await import("../src/signing/templates.js");
    prismaMod = await import("../src/db/prisma.js");

    await prismaMod.prisma.auditEvent.deleteMany();
    await prismaMod.prisma.field.deleteMany();
    await prismaMod.prisma.templateField.deleteMany();
    await prismaMod.prisma.template.deleteMany();
    await prismaMod.prisma.signer.deleteMany();
    await prismaMod.prisma.signatureRequest.deleteMany();
  });

  afterAll(async () => {
    await prismaMod.prisma.$disconnect();
  });

  it("saves a role-keyed template from a draft", async () => {
    const token = await newDraft([{ name: "Bob Buyer", email: "bob@example.com", role: "BUYER" }]);
    const saved = await tplMod.saveTemplateFromDraft(token, "Agency Disclosure", [
      { role: "BUYER", type: "SIGNATURE", pageIndex: 0, x: 90, y: 600, width: 200, height: 56 },
      { role: "BUYER", type: "DATE", pageIndex: 0, x: 320, y: 612, width: 120, height: 28 },
    ]);
    templateId = saved.id;
    expect(saved.fieldCount).toBe(2);
  });

  it("lists the saved template with its roles", async () => {
    const templates = await tplMod.listTemplates();
    const t = templates.find((x) => x.id === templateId);
    expect(t).toBeTruthy();
    expect(t!.fieldCount).toBe(2);
    expect(t!.roles).toEqual(["BUYER"]);
  });

  it("applies the template to a new draft, mapping BUYER to that draft's buyer signer", async () => {
    const token = await newDraft([
      { name: "Carla Client", email: "carla@example.com", role: "SELLER" },
      { name: "Dan Different", email: "dan@example.com", role: "BUYER" },
    ]);
    const res = await tplMod.applyTemplateToDraft(token, templateId);
    expect(res.applied).toBe(2);
    expect(res.skippedRoles).toHaveLength(0);
    // Both fields land on the BUYER signer (index 1 here).
    expect(res.fields.every((f) => f.signerIndex === 1)).toBe(true);

    const ctx = await reqMod.getPrepareContext(token);
    expect(ctx.fields).toHaveLength(2);
  });

  it("skips template roles that have no matching signer on the draft", async () => {
    const token = await newDraft([{ name: "Solo Seller", email: "seller@example.com", role: "SELLER" }]);
    const res = await tplMod.applyTemplateToDraft(token, templateId);
    expect(res.applied).toBe(0);
    expect(res.skippedRoles).toEqual(["BUYER"]);
  });
});
