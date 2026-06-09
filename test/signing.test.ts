import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  createSimplePdf,
  getPageLayouts,
  flattenFields,
} from "../src/signing/pdf.js";
import {
  issueToken,
  hashToken,
  tokenMatches,
  expiryFromNow,
} from "../src/signing/tokens.js";
import { consentDisclosure, CONSENT_VERSION } from "../src/signing/consent.js";
import { buildCertificate } from "../src/signing/certificate.js";
import { autoPlaceFields } from "../src/signing/layout.js";

// 1x1 transparent PNG.
const ONE_PX_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("pdf service", () => {
  it("reports page layouts in points", async () => {
    const pdf = await createSimplePdf("Hello CRE");
    const layouts = await getPageLayouts(pdf);
    expect(layouts).toHaveLength(1);
    expect(layouts[0]).toMatchObject({ pageIndex: 0, width: 612, height: 792 });
  });

  it("flattens a text field and keeps a valid single-page PDF", async () => {
    const pdf = await createSimplePdf("Purchase Agreement");
    const out = await flattenFields(pdf, [
      { type: "TEXT", pageIndex: 0, x: 100, y: 100, width: 120, height: 18, value: "CEO" },
      { type: "DATE", pageIndex: 0, x: 100, y: 140, width: 120, height: 18, value: "2026-06-05" },
    ]);
    expect(out.length).toBeGreaterThan(0);
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it("embeds a signature image", async () => {
    const pdf = await createSimplePdf("Lease");
    const out = await flattenFields(pdf, [
      { type: "SIGNATURE", pageIndex: 0, x: 100, y: 200, width: 160, height: 50, value: ONE_PX_PNG },
    ]);
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it("rejects a field that points past the last page", async () => {
    const pdf = await createSimplePdf("One page");
    await expect(
      flattenFields(pdf, [
        { type: "TEXT", pageIndex: 5, x: 0, y: 0, width: 10, height: 10, value: "x" },
      ]),
    ).rejects.toThrow(/page 5/);
  });

  it("burns down a pre-existing interactive AcroForm so the signed output is not editable", async () => {
    // Build a source PDF that already carries a fillable form field (common in CRE/legal templates).
    const src = await PDFDocument.create();
    const page = src.addPage([612, 792]);
    const srcForm = src.getForm();
    const tf = srcForm.createTextField("counterparty.title");
    tf.setText("editable before flatten");
    tf.addToPage(page, { x: 50, y: 600, width: 200, height: 20 });
    const withForm = Buffer.from(await src.save());

    // Sanity: the source really does have an interactive field.
    expect((await PDFDocument.load(withForm)).getForm().getFields()).toHaveLength(1);

    const out = await flattenFields(withForm, [
      { type: "TEXT", pageIndex: 0, x: 100, y: 100, width: 120, height: 18, value: "CEO" },
    ]);

    // After flattening there must be no interactive form fields left to edit.
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getForm().getFields()).toHaveLength(0);
    expect(reloaded.getPageCount()).toBe(1);
  });
});

describe("token service", () => {
  it("issues a token and stores only its hash", () => {
    const { token, tokenHash } = issueToken();
    expect(token).not.toEqual(tokenHash);
    expect(tokenHash).toBe(hashToken(token));
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("matches the correct token and rejects others in constant time", () => {
    const { token, tokenHash } = issueToken();
    expect(tokenMatches(token, tokenHash)).toBe(true);
    expect(tokenMatches("not-the-token", tokenHash)).toBe(false);
  });

  it("computes a future expiry", () => {
    const before = Date.now();
    const exp = expiryFromNow(1);
    expect(exp.getTime()).toBeGreaterThan(before);
    expect(exp.getTime()).toBeLessThanOrEqual(before + 60 * 60 * 1000 + 5);
  });
});

describe("auto field placement", () => {
  const layouts = [
    { pageIndex: 0, width: 612, height: 792 },
    { pageIndex: 1, width: 612, height: 792 },
  ];

  it("places requested fields on the last page within bounds, per signer band", () => {
    const placed = autoPlaceFields(layouts, [
      { signerIndex: 0, type: "SIGNATURE" },
      { signerIndex: 0, type: "DATE" },
      { signerIndex: 1, type: "TEXT" },
    ]);
    expect(placed).toHaveLength(3);
    // All on the last page.
    expect(placed.every((p) => p.pageIndex === 1)).toBe(true);
    // Within page bounds.
    for (const p of placed) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x + p.width).toBeLessThanOrEqual(612);
      expect(p.y + p.height).toBeLessThanOrEqual(792);
    }
    // Different signers land in different vertical bands.
    const sig0 = placed.find((p) => p.signerIndex === 0 && p.type === "SIGNATURE")!;
    const text1 = placed.find((p) => p.signerIndex === 1 && p.type === "TEXT")!;
    expect(text1.y).toBeGreaterThan(sig0.y);
  });

  it("returns nothing when there are no pages or requests", () => {
    expect(autoPlaceFields([], [{ signerIndex: 0, type: "SIGNATURE" }])).toHaveLength(0);
    expect(autoPlaceFields(layouts, [])).toHaveLength(0);
  });
});

describe("consent disclosure", () => {
  it("is versioned and mentions ESIGN/UETA", () => {
    const { version, text } = consentDisclosure();
    expect(version).toBe(CONSENT_VERSION);
    expect(text).toMatch(/ESIGN/);
    expect(text).toMatch(/electronic/i);
  });
});

describe("certificate of completion", () => {
  it("builds a valid PDF including hashes and the event timeline", async () => {
    const now = new Date("2026-06-05T12:00:00.000Z");
    const pdf = await buildCertificate({
      documentName: "Purchase Agreement.pdf",
      requestId: "11111111-1111-1111-1111-111111111111",
      status: "COMPLETED",
      docHashOriginal: "a".repeat(64),
      docHashFinal: "b".repeat(64),
      createdAt: now,
      sentAt: now,
      completedAt: now,
      signers: [
        {
          name: "Robert Chaykin",
          email: "robert@example.com",
          entityLabel: "Acme LLC — Buyer",
          authMethod: "EMAIL_LINK",
          consentedAt: now,
          consentIp: "203.0.113.7",
          signedAt: now,
        },
      ],
      events: [
        { occurredAt: now, eventType: "REQUEST_SENT" },
        { occurredAt: now, eventType: "SIGNED", signerName: "Robert Chaykin", ipAddress: "203.0.113.7" },
        { occurredAt: now, eventType: "COMPLETED" },
      ],
    });
    expect(pdf.length).toBeGreaterThan(0);
    const reloaded = await PDFDocument.load(pdf);
    expect(reloaded.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("paginates when there are many events", async () => {
    const now = new Date();
    const events = Array.from({ length: 120 }, (_, i) => ({
      occurredAt: now,
      eventType: `EVENT_${i}`,
    }));
    const pdf = await buildCertificate({
      documentName: "Big.pdf",
      requestId: "22222222-2222-2222-2222-222222222222",
      status: "COMPLETED",
      createdAt: now,
      signers: [],
      events,
    });
    const reloaded = await PDFDocument.load(pdf);
    expect(reloaded.getPageCount()).toBeGreaterThan(1);
  });
});
