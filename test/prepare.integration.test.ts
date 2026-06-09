import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/**
 * Sender field-placement (prepare) flow against a real Postgres, with the Salesforce file download
 * mocked. Exercises: create an empty DRAFT (prepare), read its context, place fields, send, and the
 * guards (no-fields send is blocked; the prepare token dies once sent).
 *
 * Runs only when RUN_DB_TESTS=1 and DATABASE_URL points at a reachable database (CI sets both).
 */

const holder = vi.hoisted(() => ({ pdf: null as Buffer | null }));
vi.mock("../src/salesforce/files.js", () => ({
  downloadFileBytes: vi.fn(async () => holder.pdf),
  isSalesforceId: () => true,
}));

const run = process.env.RUN_DB_TESTS === "1";

describe.runIf(run)("prepare / field placement (integration)", () => {
  let mod: typeof import("../src/signing/requests.js");
  let prismaMod: typeof import("../src/db/prisma.js");
  let prepareToken: string;
  let requestId: string;

  beforeAll(async () => {
    const { createSimplePdf } = await import("../src/signing/pdf.js");
    holder.pdf = await createSimplePdf("Offer to Purchase — 42 Galaxy Way");
    mod = await import("../src/signing/requests.js");
    prismaMod = await import("../src/db/prisma.js");

    await prismaMod.prisma.auditEvent.deleteMany();
    await prismaMod.prisma.field.deleteMany();
    await prismaMod.prisma.signer.deleteMany();
    await prismaMod.prisma.signatureRequest.deleteMany();
  });

  afterAll(async () => {
    await prismaMod.prisma.$disconnect();
  });

  it("creates an empty DRAFT with prepare=true and returns a prepare token", async () => {
    const created = await mod.createSignatureRequest({
      salesforceRecordId: "a0LPe00001IBd1ZMAT",
      salesforceObjectType: "TTL_Core__Deal__c",
      contentVersionId: "068Pe0000196OGTIA2",
      documentName: "Offer.pdf",
      signers: [{ name: "Dana Lee", email: "dana@example.com", entityLabel: "Galaxy LLC — Buyer" }],
      prepare: true, // no fields up front
    });
    requestId = created.requestId;
    prepareToken = created.prepareToken;
    expect(prepareToken.length).toBeGreaterThan(20);
  });

  it("exposes the draft context: signers, pages, and (initially) no fields", async () => {
    const ctx = await mod.getPrepareContext(prepareToken);
    expect(ctx.request.status).toBe("DRAFT");
    expect(ctx.signers).toHaveLength(1);
    expect(ctx.signers[0]).toMatchObject({ index: 0, name: "Dana Lee" });
    expect(ctx.pages[0]).toMatchObject({ pageIndex: 0 });
    expect(ctx.fields).toHaveLength(0);
  });

  it("refuses to send a draft with no fields placed", async () => {
    await expect(mod.sendDraftByPrepareToken(prepareToken)).rejects.toThrow(/at least one field/i);
  });

  it("places fields and persists them with the right signer + geometry", async () => {
    const res = await mod.replaceDraftFields(prepareToken, [
      { signerIndex: 0, type: "SIGNATURE", pageIndex: 0, x: 90, y: 600, width: 200, height: 56 },
      { signerIndex: 0, type: "DATE", label: "Date", pageIndex: 0, x: 320, y: 612, width: 120, height: 28 },
    ]);
    expect(res.fields).toBe(2);

    const ctx = await mod.getPrepareContext(prepareToken);
    expect(ctx.fields).toHaveLength(2);
    expect(ctx.fields.every((f) => f.signerIndex === 0)).toBe(true);
    expect(ctx.fields.map((f) => f.type).sort()).toEqual(["DATE", "SIGNATURE"]);
  });

  it("rejects a field that references a non-existent page or signer", async () => {
    await expect(
      mod.replaceDraftFields(prepareToken, [
        { signerIndex: 0, type: "TEXT", pageIndex: 9, x: 10, y: 10, width: 50, height: 20 },
      ]),
    ).rejects.toThrow(/page 9/i);
    await expect(
      mod.replaceDraftFields(prepareToken, [
        { signerIndex: 5, type: "TEXT", pageIndex: 0, x: 10, y: 10, width: 50, height: 20 },
      ]),
    ).rejects.toThrow(/signer 5/i);
  });

  it("sends the prepared draft, and the prepare token dies once it leaves DRAFT", async () => {
    // Re-place the valid fields (the rejected calls above didn't mutate state).
    await mod.replaceDraftFields(prepareToken, [
      { signerIndex: 0, type: "SIGNATURE", pageIndex: 0, x: 90, y: 600, width: 200, height: 56 },
    ]);
    const links = await mod.sendDraftByPrepareToken(prepareToken);
    expect(links).toHaveLength(1);

    const row = await prismaMod.prisma.signatureRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.status).toBe("SENT");

    // The prepare token no longer resolves (request left DRAFT).
    await expect(mod.getPrepareContext(prepareToken)).rejects.toThrow(/already been sent/i);
  });
});
