import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/**
 * createRequestFromDeal against a real Postgres, with Salesforce mocked at two boundaries: the Deal
 * party lookup and the file download. Verifies routing derives the right signers from the record
 * type and that the draft is created with those roles.
 *
 * Runs only when RUN_DB_TESTS=1 and DATABASE_URL points at a reachable database (CI sets both).
 */

const holder = vi.hoisted(() => ({ pdf: null as Buffer | null, parties: null as unknown }));
vi.mock("../src/salesforce/files.js", () => ({
  downloadFileBytes: vi.fn(async () => holder.pdf),
  isSalesforceId: () => true,
}));
vi.mock("../src/salesforce/deal.js", () => ({
  getDealParties: vi.fn(async () => holder.parties),
}));

const run = process.env.RUN_DB_TESTS === "1";

describe.runIf(run)("createRequestFromDeal (integration)", () => {
  let mod: typeof import("../src/signing/requests.js");
  let prismaMod: typeof import("../src/db/prisma.js");

  const dealInput = {
    salesforceRecordId: "a0LPe00001IBd1ZMAT",
    salesforceObjectType: "TTL_Core__Deal__c",
    contentVersionId: "068Pe0000196OGTIA2",
    documentName: "Agency Disclosure.pdf",
  };

  beforeAll(async () => {
    const { createSimplePdf } = await import("../src/signing/pdf.js");
    holder.pdf = await createSimplePdf("Agency Disclosure — routing fixture");
    mod = await import("../src/signing/requests.js");
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

  it("routes a Seller_Rep deal with both parties to seller + buyer", async () => {
    holder.parties = {
      recordType: "Seller_Rep",
      contactsByRole: {
        SELLER: { name: "Randy Best", email: "randy@example.com" },
        BUYER: { name: "Betty Buyer", email: "betty@example.com" },
      },
    };
    const res = await mod.createRequestFromDeal(dealInput);
    expect(res.recordType).toBe("Seller_Rep");
    expect(res.signers.map((s) => s.role)).toEqual(["SELLER", "BUYER"]);

    const ctx = await mod.getPrepareContext(res.prepareToken);
    expect(ctx.signers.map((s) => s.role)).toEqual(["SELLER", "BUYER"]);

    const row = await prismaMod.prisma.signatureRequest.findUniqueOrThrow({ where: { id: res.requestId } });
    expect(row.salesforceRecordType).toBe("Seller_Rep");
  });

  it("routes a Seller_Rep deal with an unrepresented buyer to the seller only", async () => {
    holder.parties = {
      recordType: "Seller_Rep",
      contactsByRole: { SELLER: { name: "Randy Best", email: "randy@example.com" } },
    };
    const res = await mod.createRequestFromDeal(dealInput);
    expect(res.signers.map((s) => s.role)).toEqual(["SELLER"]);
  });

  it("rejects a deal whose record type has no routing rule", async () => {
    holder.parties = { recordType: "Consulting", contactsByRole: {} };
    await expect(mod.createRequestFromDeal(dealInput)).rejects.toThrow(/no routing rule/i);
  });

  it("auto-sends when a trusted template matches the document type", async () => {
    // Seed a trusted (autoSend) template for the 'agency-disclosure' document type.
    await prismaMod.prisma.template.create({
      data: {
        name: "Agency Disclosure (trusted)",
        documentType: "agency-disclosure",
        autoSend: true,
        // Auto-send requires the template to be bound to the geometry of the document it was
        // built on (createSimplePdf produces one 612×792 page) — a mismatch fails closed.
        sourcePageCount: 1,
        sourcePageSizes: [{ w: 612, h: 792 }],
        fields: {
          create: [
            { role: "SELLER", type: "SIGNATURE", pageIndex: 0, x: 90, y: 600, width: 200, height: 56, required: true },
          ],
        },
      },
    });
    holder.parties = {
      recordType: "Seller_Rep",
      contactsByRole: { SELLER: { name: "Randy Best", email: "randy@example.com" } },
    };

    const res = await mod.createRequestFromDeal({ ...dealInput, documentType: "agency-disclosure" });
    expect(res.sent).toBe(true);

    const row = await prismaMod.prisma.signatureRequest.findUniqueOrThrow({ where: { id: res.requestId } });
    expect(row.status).toBe("SENT");
  });

  it("does NOT auto-send when the matching template is not trusted (review fallback)", async () => {
    await prismaMod.prisma.template.deleteMany();
    await prismaMod.prisma.template.create({
      data: {
        name: "Untrusted",
        documentType: "agency-disclosure",
        autoSend: false,
        fields: {
          create: [
            { role: "SELLER", type: "SIGNATURE", pageIndex: 0, x: 90, y: 600, width: 200, height: 56, required: true },
          ],
        },
      },
    });
    holder.parties = {
      recordType: "Seller_Rep",
      contactsByRole: { SELLER: { name: "Randy Best", email: "randy@example.com" } },
    };
    const res = await mod.createRequestFromDeal({ ...dealInput, documentType: "agency-disclosure" });
    expect(res.sent).toBe(false);
    const row = await prismaMod.prisma.signatureRequest.findUniqueOrThrow({ where: { id: res.requestId } });
    expect(row.status).toBe("DRAFT");
  });
});
