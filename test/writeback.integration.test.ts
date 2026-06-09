import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/**
 * Exercises the Salesforce write-back orchestration end-to-end against a real Postgres, with the
 * Salesforce primitives (file upload + Signature_Request__c upsert) mocked and credentials forced
 * on. Completing the signature triggers certificate generation + write-back automatically.
 *
 * Runs only when RUN_DB_TESTS=1.
 */

const holder = vi.hoisted(() => ({ pdf: null as Buffer | null }));

vi.mock("../src/salesforce/files.js", () => ({
  downloadFileBytes: vi.fn(async () => holder.pdf),
  isSalesforceId: () => true,
}));

vi.mock("../src/salesforce/writeback.js", () => ({
  uploadFileToRecord: vi.fn(async (_recordId: string, title: string) => ({
    contentVersionId: title.includes("Certificate") ? "068000000000002AAA" : "068000000000001AAA",
    contentDocumentId: title.includes("Certificate") ? "069000000000002AAA" : "069000000000001AAA",
  })),
  upsertSignatureRequestRecord: vi.fn(async () => "a0Z000000000001AAA"),
}));

// Force the credential check on so completeRequest performs the write-back.
vi.mock("../src/config/env.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, hasSalesforceCredentials: () => true };
});

const run = process.env.RUN_DB_TESTS === "1";

describe.runIf(run)("salesforce write-back (integration)", () => {
  let mod: typeof import("../src/signing/requests.js");
  let prismaMod: typeof import("../src/db/prisma.js");
  let sfwb: typeof import("../src/salesforce/writeback.js");
  let requestId: string;

  beforeAll(async () => {
    const { createSimplePdf } = await import("../src/signing/pdf.js");
    holder.pdf = await createSimplePdf("Lease Agreement");
    mod = await import("../src/signing/requests.js");
    prismaMod = await import("../src/db/prisma.js");
    sfwb = await import("../src/salesforce/writeback.js");

    await prismaMod.prisma.auditEvent.deleteMany();
    await prismaMod.prisma.field.deleteMany();
    await prismaMod.prisma.signer.deleteMany();
    await prismaMod.prisma.signatureRequest.deleteMany();
  });

  afterAll(async () => {
    await prismaMod.prisma.$disconnect();
  });

  it("uploads signed + certificate and upserts the tracking record on completion", async () => {
    const created = await mod.createSignatureRequest({
      salesforceRecordId: "006Pe000001AbCdEFG",
      salesforceObjectType: "TTL_Core__Deal__c",
      contentVersionId: "068Pe000018bqU0IAI",
      documentName: "Lease.pdf",
      signers: [{ name: "Dana Broker", email: "dana@example.com", entityLabel: "Broker" }],
      fields: [{ signerIndex: 0, type: "TEXT", label: "Title", pageIndex: 0, x: 80, y: 700, width: 160, height: 20 }],
    });
    requestId = created.requestId;

    const links = await mod.sendSignatureRequest(requestId);
    const token = links[0].url.split("/sign/")[1];

    const ctx = mod.getSignerContext ? await mod.getSignerContext(token, { ip: "198.51.100.4" }) : null;
    const fieldId = ctx!.fields[0].id;

    await mod.recordSignerConsent(token, { ip: "198.51.100.4", userAgent: "vitest" });
    const result = await mod.submitSignerFields(
      token,
      [{ fieldId, value: "Managing Broker" }],
      { ip: "198.51.100.4", userAgent: "vitest" },
    );
    expect(result.requestStatus).toBe("COMPLETED");

    // Both files uploaded; tracking record upserted.
    expect(vi.mocked(sfwb.uploadFileToRecord)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sfwb.upsertSignatureRequestRecord)).toHaveBeenCalledTimes(1);

    const row = await prismaMod.prisma.signatureRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.salesforceRequestRecordId).toBe("a0Z000000000001AAA");
    expect(row.certificatePdf).toBeTruthy();

    const status = await mod.getRequestStatus(requestId);
    expect(status!.auditTrail.map((e) => e.eventType)).toContain("WRITEBACK_SUCCEEDED");
  });
});
