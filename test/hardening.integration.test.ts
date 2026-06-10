import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

/**
 * Hardening verification against a real Postgres (RUN_DB_TESTS=1):
 *  - parallel-completion race: exactly one completion no matter how submits interleave
 *  - write-back idempotency: a retry after a partial failure resumes, never re-uploads
 *  - atomic DRAFT→SENT (no double send)
 *  - terminal-state guards (decline-after-complete, sign-after-decline)
 *  - LINK_OPENED audit dedupe
 *  - auto-send gates: geometry mismatch / partial application refuse to send; clean match sends
 *    with an AUTO_TEMPLATE origin in the audit trail
 *
 * Salesforce is mocked at the same boundaries as the other integration suites; credentials are
 * forced "configured" so the write-back path runs.
 */

const holder = vi.hoisted(() => ({
  pdf: null as Buffer | null,
  parties: null as unknown,
  uploads: [] as Array<{ title: string }>,
  failUploadTitles: new Set<string>(),
}));

vi.mock("../src/salesforce/files.js", () => ({
  downloadFileBytes: vi.fn(async () => holder.pdf),
  isSalesforceId: () => true,
}));

vi.mock("../src/salesforce/deal.js", () => ({
  getDealParties: vi.fn(async () => holder.parties),
}));

vi.mock("../src/salesforce/writeback.js", () => ({
  uploadFileToRecord: vi.fn(async (_recordId: string, title: string) => {
    if (holder.failUploadTitles.has(title)) {
      throw new Error(`simulated upload failure for "${title}"`);
    }
    holder.uploads.push({ title });
    const n = holder.uploads.length;
    return {
      contentVersionId: `068TEST${String(n).padStart(8, "0")}AAA`,
      contentDocumentId: `069TEST${String(n).padStart(8, "0")}AAA`,
    };
  }),
  upsertSignatureRequestRecord: vi.fn(async () => "a0ZTEST0000000001AAA"),
}));

vi.mock("../src/config/env.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, hasSalesforceCredentials: () => true };
});

const run = process.env.RUN_DB_TESTS === "1";

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

describe.runIf(run)("hardening (integration)", () => {
  let req: typeof import("../src/signing/requests.js");
  let wb: typeof import("../src/signing/writeback.js");
  let sfwb: typeof import("../src/salesforce/writeback.js");
  let prismaMod: typeof import("../src/db/prisma.js");

  const ONE_PX_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  beforeAll(async () => {
    holder.pdf = await makePdf(1);
    req = await import("../src/signing/requests.js");
    wb = await import("../src/signing/writeback.js");
    sfwb = await import("../src/salesforce/writeback.js");
    prismaMod = await import("../src/db/prisma.js");
  });

  beforeEach(async () => {
    holder.uploads = [];
    holder.failUploadTitles = new Set();
    vi.mocked(sfwb.uploadFileToRecord).mockClear();
    vi.mocked(sfwb.upsertSignatureRequestRecord).mockClear();
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

  /** Create + send a request, run both signers through consent, return their tokens. */
  async function setupTwoSignerRequest() {
    const created = await req.createSignatureRequest({
      salesforceRecordId: "006Pe000001AbCdEFG",
      salesforceObjectType: "Opportunity",
      contentVersionId: "068Pe000018bqU0IAI",
      documentName: "Race Test.pdf",
      signers: [
        { name: "Officer One", email: "one@example.com", entityLabel: "Acme LLC" },
        { name: "Officer Two", email: "two@example.com", entityLabel: "Acme LLC" },
      ],
      fields: [
        { signerIndex: 0, type: "SIGNATURE", pageIndex: 0, x: 72, y: 600, width: 180, height: 48 },
        { signerIndex: 1, type: "SIGNATURE", pageIndex: 0, x: 320, y: 600, width: 180, height: 48 },
      ],
    });
    const links = await req.sendSignatureRequest(created.requestId);
    const tokens = links.map((l) => l.url.split("/sign/")[1]);
    for (const t of tokens) await req.recordSignerConsent(t, { ip: "203.0.113.9" });

    const fields = await prismaMod.prisma.field.findMany({
      where: { requestId: created.requestId },
      include: { signer: true },
      orderBy: { x: "asc" },
    });
    const fieldFor = (email: string) => fields.find((f) => f.signer.email === email)!.id;
    return { requestId: created.requestId, tokens, fieldFor };
  }

  it("parallel final submits complete the request exactly once (no duplicate write-back)", async () => {
    const { requestId, tokens, fieldFor } = await setupTwoSignerRequest();

    const results = await Promise.all([
      req.submitSignerFields(tokens[0], [{ fieldId: fieldFor("one@example.com"), value: ONE_PX_PNG }], {}),
      req.submitSignerFields(tokens[1], [{ fieldId: fieldFor("two@example.com"), value: ONE_PX_PNG }], {}),
    ]);
    expect(results.every((r) => r.status === "SIGNED")).toBe(true);

    const request = await prismaMod.prisma.signatureRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(request.status).toBe("COMPLETED");
    expect(request.signedPdf).toBeTruthy();

    // Exactly ONE completion: one COMPLETED audit event, one signed + one certificate upload.
    const completedEvents = await prismaMod.prisma.auditEvent.count({
      where: { requestId, eventType: "COMPLETED" },
    });
    expect(completedEvents).toBe(1);
    expect(vi.mocked(sfwb.uploadFileToRecord)).toHaveBeenCalledTimes(2);
    const successEvents = await prismaMod.prisma.auditEvent.count({
      where: { requestId, eventType: "WRITEBACK_SUCCEEDED" },
    });
    expect(successEvents).toBe(1);
  });

  it("write-back retry resumes after a partial failure instead of duplicating files", async () => {
    // Fail the CERTIFICATE upload on the first pass.
    holder.failUploadTitles = new Set(["Retry Test - Certificate of Completion"]);

    const created = await req.createSignatureRequest({
      salesforceRecordId: "006Pe000001AbCdEFG",
      salesforceObjectType: "Opportunity",
      contentVersionId: "068Pe000018bqU0IAI",
      documentName: "Retry Test.pdf",
      signers: [{ name: "Solo Signer", email: "solo@example.com" }],
      fields: [{ signerIndex: 0, type: "SIGNATURE", pageIndex: 0, x: 72, y: 600, width: 180, height: 48 }],
    });
    const [link] = await req.sendSignatureRequest(created.requestId);
    const token = link.url.split("/sign/")[1];
    await req.recordSignerConsent(token, {});
    const field = await prismaMod.prisma.field.findFirstOrThrow({ where: { requestId: created.requestId } });

    // Completion succeeds for the signer even though write-back partially fails inside.
    const result = await req.submitSignerFields(token, [{ fieldId: field.id, value: ONE_PX_PNG }], {});
    expect(result.requestStatus).toBe("COMPLETED");

    let row = await prismaMod.prisma.signatureRequest.findUniqueOrThrow({ where: { id: created.requestId } });
    expect(row.signedContentDocumentId).toBeTruthy(); // signed upload landed + was persisted
    expect(row.certificateContentDocumentId).toBeNull(); // cert upload failed
    const failed = await prismaMod.prisma.auditEvent.count({
      where: { requestId: created.requestId, eventType: "WRITEBACK_FAILED" },
    });
    expect(failed).toBe(1);
    const callsAfterFirst = vi.mocked(sfwb.uploadFileToRecord).mock.calls.length;

    // Retry with the failure cleared: only the certificate is uploaded — the signed PDF is NOT re-sent.
    holder.failUploadTitles = new Set();
    const retry = await wb.attemptWriteback(created.requestId);
    expect(retry.ok).toBe(true);

    expect(vi.mocked(sfwb.uploadFileToRecord).mock.calls.length).toBe(callsAfterFirst + 1);
    const retriedTitles = vi
      .mocked(sfwb.uploadFileToRecord)
      .mock.calls.slice(callsAfterFirst)
      .map((c) => c[1]);
    expect(retriedTitles).toEqual(["Retry Test - Certificate of Completion"]);

    row = await prismaMod.prisma.signatureRequest.findUniqueOrThrow({ where: { id: created.requestId } });
    expect(row.certificateContentDocumentId).toBeTruthy();
  });

  it("a request cannot be sent twice (atomic DRAFT→SENT)", async () => {
    const created = await req.createSignatureRequest({
      salesforceRecordId: "006Pe000001AbCdEFG",
      salesforceObjectType: "Opportunity",
      contentVersionId: "068Pe000018bqU0IAI",
      documentName: "Send Twice.pdf",
      signers: [{ name: "A", email: "a@example.com" }],
      fields: [{ signerIndex: 0, type: "SIGNATURE", pageIndex: 0, x: 72, y: 600, width: 180, height: 48 }],
    });
    await req.sendSignatureRequest(created.requestId);
    await expect(req.sendSignatureRequest(created.requestId)).rejects.toThrow(/already sent/);
  });

  it("decline cannot void a COMPLETED request; signing is blocked after a decline", async () => {
    // Complete a request with signer A, then have signer B's stale link try to decline.
    const { requestId, tokens, fieldFor } = await setupTwoSignerRequest();
    await req.submitSignerFields(tokens[0], [{ fieldId: fieldFor("one@example.com"), value: ONE_PX_PNG }], {});
    await req.submitSignerFields(tokens[1], [{ fieldId: fieldFor("two@example.com"), value: ONE_PX_PNG }], {});

    await expect(req.declineSignature(tokens[1], "changed my mind", {})).rejects.toThrow(/no longer be declined/);
    const row = await prismaMod.prisma.signatureRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.status).toBe("COMPLETED");

    // Inverse: decline first, then signing/consent are refused.
    const second = await setupTwoSignerRequest();
    await req.declineSignature(second.tokens[0], undefined, {});
    await expect(
      req.submitSignerFields(second.tokens[1], [{ fieldId: second.fieldFor("two@example.com"), value: ONE_PX_PNG }], {}),
    ).rejects.toThrow(/no longer be signed/);
    const declinedRow = await prismaMod.prisma.signatureRequest.findUniqueOrThrow({
      where: { id: second.requestId },
    });
    expect(declinedRow.status).toBe("DECLINED");
  });

  it("LINK_OPENED is recorded once, not on every portal fetch", async () => {
    // Fresh request with NO prior consent — the first context fetch is the genuine first open.
    const created = await req.createSignatureRequest({
      salesforceRecordId: "006Pe000001AbCdEFG",
      salesforceObjectType: "Opportunity",
      contentVersionId: "068Pe000018bqU0IAI",
      documentName: "Open Once.pdf",
      signers: [{ name: "A", email: "a@example.com" }],
      fields: [{ signerIndex: 0, type: "SIGNATURE", pageIndex: 0, x: 72, y: 600, width: 180, height: 48 }],
    });
    const [link] = await req.sendSignatureRequest(created.requestId);
    const token = link.url.split("/sign/")[1];

    await req.getSignerContext(token, { ip: "203.0.113.9" });
    await req.getSignerContext(token, { ip: "203.0.113.9" });
    await req.getSignerContext(token, { ip: "203.0.113.9" });
    const opened = await prismaMod.prisma.auditEvent.count({
      where: { requestId: created.requestId, eventType: "LINK_OPENED" },
    });
    expect(opened).toBe(1);
  });

  describe("auto-send gates", () => {
    const dealInput = {
      salesforceRecordId: "a0LPe00001IBd1ZMAT",
      salesforceObjectType: "TTL_Core__Deal__c",
      contentVersionId: "068Pe0000196OGTIA2",
      documentName: "Agency Disclosure.pdf",
      documentType: "agency-disclosure",
    };

    beforeEach(() => {
      holder.parties = {
        recordType: "Seller_Rep",
        contactsByRole: {
          SELLER: { name: "Randy Best", email: "randy@example.com" },
          BUYER: { name: "Betty Buyer", email: "betty@example.com" },
        },
      };
    });

    async function makeTrustedTemplate(opts: { pageCount: number | null; sizes?: Array<{ w: number; h: number }> }) {
      return prismaMod.prisma.template.create({
        data: {
          name: "Trusted Disclosure",
          documentType: "agency-disclosure",
          autoSend: true,
          sourcePageCount: opts.pageCount,
          sourcePageSizes: opts.sizes,
          fields: {
            create: [
              { role: "SELLER", type: "SIGNATURE", pageIndex: 0, x: 72, y: 600, width: 180, height: 48 },
              { role: "BUYER", type: "SIGNATURE", pageIndex: 0, x: 320, y: 600, width: 180, height: 48 },
            ],
          },
        },
      });
    }

    it("sends when the document matches the template's source geometry, with AUTO_TEMPLATE audit", async () => {
      holder.pdf = await makePdf(1); // 1 page, 612x792 — matches
      await makeTrustedTemplate({ pageCount: 1, sizes: [{ w: 612, h: 792 }] });

      const res = await req.createRequestFromDeal(dealInput);
      expect(res.sent).toBe(true);

      const sentEvent = await prismaMod.prisma.auditEvent.findFirstOrThrow({
        where: { requestId: res.requestId, eventType: "REQUEST_SENT" },
      });
      const meta = sentEvent.metadata as { origin?: string; templateName?: string };
      expect(meta.origin).toBe("AUTO_TEMPLATE");
      expect(meta.templateName).toBe("Trusted Disclosure");
    });

    it("refuses to auto-send when the target document's geometry differs from the template's source", async () => {
      holder.pdf = await makePdf(2); // 2 pages — template was built on 1
      await makeTrustedTemplate({ pageCount: 1, sizes: [{ w: 612, h: 792 }] });

      const res = await req.createRequestFromDeal(dealInput);
      expect(res.sent).toBe(false);
      expect(res.autoSendNote).toMatch(/different document layout/i);

      const row = await prismaMod.prisma.signatureRequest.findUniqueOrThrow({ where: { id: res.requestId } });
      expect(row.status).toBe("DRAFT"); // fell back to human review
    });

    it("refuses to auto-send with a legacy template that has no recorded geometry (fails closed)", async () => {
      holder.pdf = await makePdf(1);
      await makeTrustedTemplate({ pageCount: null });

      const res = await req.createRequestFromDeal(dealInput);
      expect(res.sent).toBe(false);

      const row = await prismaMod.prisma.signatureRequest.findUniqueOrThrow({ where: { id: res.requestId } });
      expect(row.status).toBe("DRAFT");
    });
  });

  it("rejects out-of-bounds field placements at create time", async () => {
    holder.pdf = await makePdf(1);
    await expect(
      req.createSignatureRequest({
        salesforceRecordId: "006Pe000001AbCdEFG",
        salesforceObjectType: "Opportunity",
        contentVersionId: "068Pe000018bqU0IAI",
        documentName: "Bounds.pdf",
        signers: [{ name: "A", email: "a@example.com" }],
        // x + width = 700 > 612pt page width
        fields: [{ signerIndex: 0, type: "SIGNATURE", pageIndex: 0, x: 520, y: 600, width: 180, height: 48 }],
      }),
    ).rejects.toThrow(/outside page 1/);
  });
});
