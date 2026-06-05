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

describe("consent disclosure", () => {
  it("is versioned and mentions ESIGN/UETA", () => {
    const { version, text } = consentDisclosure();
    expect(version).toBe(CONSENT_VERSION);
    expect(text).toMatch(/ESIGN/);
    expect(text).toMatch(/electronic/i);
  });
});
