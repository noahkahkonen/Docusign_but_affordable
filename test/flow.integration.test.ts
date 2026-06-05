import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

/**
 * End-to-end signing flow against a real Postgres. Only the Salesforce file download is mocked —
 * everything else (lifecycle, tokens, consent, flattening, hashing, audit) is exercised for real.
 *
 * Runs only when RUN_DB_TESTS=1 and DATABASE_URL points at a reachable database (CI sets both).
 */

const holder = vi.hoisted(() => ({ pdf: null as Buffer | null }));

vi.mock("../src/salesforce/files.js", () => ({
  downloadFileBytes: vi.fn(async () => holder.pdf),
  isSalesforceId: () => true,
}));

const run = process.env.RUN_DB_TESTS === "1";

describe.runIf(run)("signing flow (integration)", () => {
  let mod: typeof import("../src/signing/requests.js");
  let prismaMod: typeof import("../src/db/prisma.js");
  let token: string;
  let requestId: string;
  let signatureFieldId = "";
  let titleFieldId = "";

  beforeAll(async () => {
    const { createSimplePdf } = await import("../src/signing/pdf.js");
    holder.pdf = await createSimplePdf("Purchase Agreement — 123 Main St");
    mod = await import("../src/signing/requests.js");
    prismaMod = await import("../src/db/prisma.js");

    // Clean slate for repeatable runs.
    await prismaMod.prisma.auditEvent.deleteMany();
    await prismaMod.prisma.field.deleteMany();
    await prismaMod.prisma.signer.deleteMany();
    await prismaMod.prisma.signatureRequest.deleteMany();
  });

  afterAll(async () => {
    await prismaMod.prisma.$disconnect();
  });

  it("creates a draft request with signers and fields", async () => {
    const created = await mod.createSignatureRequest({
      salesforceRecordId: "006Pe000001AbCdEFG",
      salesforceObjectType: "Opportunity",
      contentVersionId: "068Pe000018bqU0IAI",
      documentName: "Purchase Agreement.pdf",
      signers: [{ name: "Robert Chaykin", email: "robert@example.com", entityLabel: "Acme LLC — Buyer" }],
      fields: [
        { signerIndex: 0, type: "SIGNATURE", pageIndex: 0, x: 100, y: 600, width: 180, height: 50 },
        { signerIndex: 0, type: "TEXT", label: "Title", pageIndex: 0, x: 100, y: 660, width: 160, height: 20 },
      ],
    });
    requestId = created.requestId;
    expect(created.docHashOriginal).toMatch(/^[a-f0-9]{64}$/);
    expect(created.signerIds).toHaveLength(1);
  });

  it("sends and issues a single-use signing link", async () => {
    const links = await mod.sendSignatureRequest(requestId);
    expect(links).toHaveLength(1);
    token = links[0].url.split("/sign/")[1];
    expect(token.length).toBeGreaterThan(20);
  });

  it("returns signer context with consent + fields, and records the open", async () => {
    const ctx = await mod.getSignerContext(token, { ip: "203.0.113.7", userAgent: "vitest" });
    expect(ctx.consent.text).toMatch(/ESIGN/);
    expect(ctx.fields).toHaveLength(2);
    expect(ctx.pages[0]).toMatchObject({ pageIndex: 0 });
    signatureFieldId = ctx.fields.find((f) => f.type === "SIGNATURE")!.id;
    titleFieldId = ctx.fields.find((f) => f.type === "TEXT")!.id;
  });

  it("blocks signing before consent", async () => {
    await expect(
      mod.submitSignerFields(token, [{ fieldId: titleFieldId, value: "CEO" }], {}),
    ).rejects.toThrow(/consent/i);
  });

  it("records consent then completes on submit, flattening + hashing the PDF", async () => {
    await mod.recordSignerConsent(token, { ip: "203.0.113.7", userAgent: "vitest" });

    const onePxPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const result = await mod.submitSignerFields(
      token,
      [
        { fieldId: signatureFieldId, value: onePxPng },
        { fieldId: titleFieldId, value: "CEO" },
      ],
      { ip: "203.0.113.7", userAgent: "vitest" },
    );
    expect(result.status).toBe("SIGNED");
    expect(result.requestStatus).toBe("COMPLETED");
  });

  it("produces a verifiable signed PDF + final hash and a full audit trail", async () => {
    const status = await mod.getRequestStatus(requestId);
    expect(status?.status).toBe("COMPLETED");
    expect(status?.docHashFinal).toMatch(/^[a-f0-9]{64}$/);
    expect(status?.signers[0].status).toBe("SIGNED");

    const events = status!.auditTrail.map((e) => e.eventType);
    expect(events).toEqual(
      expect.arrayContaining(["REQUEST_CREATED", "REQUEST_SENT", "LINK_OPENED", "CONSENT_GIVEN", "SIGNED", "COMPLETED"]),
    );
    // IP captured on the signing event.
    expect(status!.auditTrail.some((e) => e.ipAddress === "203.0.113.7")).toBe(true);

    const row = await prismaMod.prisma.signatureRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.signedPdf).toBeTruthy();
    const reloaded = await PDFDocument.load(Buffer.from(row.signedPdf!));
    expect(reloaded.getPageCount()).toBe(1);
  });

  it("rejects a reused/again submit as already signed", async () => {
    const again = await mod.submitSignerFields(token, [], {});
    expect(again.status).toBe("ALREADY_SIGNED");
  });
});
