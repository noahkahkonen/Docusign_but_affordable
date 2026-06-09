import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * PDF preparation and flattening (pdf-lib).
 *
 * Coordinate convention (shared with the portal + the `fields` table):
 *   - Origin is the TOP-LEFT of the page, units are PDF points, pageIndex is 0-based.
 *   - This is the natural convention for placing fields in a browser; we convert to pdf-lib's
 *     bottom-left origin only at draw time.
 *
 * Signature/initials values arrive as PNG/JPEG data URLs (the portal rasterises both drawn AND
 * typed signatures to an image), so flattening them is always an image embed. Date/text values
 * are plain strings drawn with a standard font.
 */

export interface PageLayout {
  pageIndex: number;
  width: number; // points
  height: number; // points
}

export type FlattenFieldType = "SIGNATURE" | "INITIALS" | "DATE" | "TEXT";

export interface FieldPlacement {
  type: FlattenFieldType;
  pageIndex: number;
  x: number; // from left
  y: number; // from top
  width: number;
  height: number;
  /** Image data URL for SIGNATURE/INITIALS; literal string for DATE/TEXT. */
  value: string;
}

/** Per-page dimensions, used by the portal to lay fields out over the rendered document. */
export async function getPageLayouts(pdfBytes: Buffer): Promise<PageLayout[]> {
  const doc = await PDFDocument.load(pdfBytes);
  return doc.getPages().map((page, pageIndex) => {
    const { width, height } = page.getSize();
    return { pageIndex, width, height };
  });
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; isPng: boolean } {
  // [\s\S] (not `.`) so a base64 payload split across newlines still matches; Buffer.from(…,
  // "base64") ignores the embedded whitespace when decoding.
  const match = /^data:(image\/(png|jpe?g));base64,([\s\S]+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error("Signature value must be a base64 PNG or JPEG data URL");
  }
  const isPng = /png/i.test(match[1]);
  return { bytes: Buffer.from(match[3], "base64"), isPng };
}

/**
 * Draw every placement onto a copy of the source PDF and return the flattened bytes.
 * The output is a normal PDF with the marks burned into page content (no interactive form
 * fields left to edit), which is what we hash for tamper-evidence.
 */
export async function flattenFields(
  pdfBytes: Buffer,
  placements: FieldPlacement[],
): Promise<Buffer> {
  const doc = await PDFDocument.load(pdfBytes);
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();

  for (const f of placements) {
    const page = pages[f.pageIndex];
    if (!page) {
      throw new Error(`Field references page ${f.pageIndex} but the PDF has ${pages.length} pages`);
    }
    const pageHeight = page.getSize().height;
    // Convert top-left origin to pdf-lib's bottom-left origin.
    const bottomLeftY = pageHeight - f.y - f.height;

    if (f.type === "SIGNATURE" || f.type === "INITIALS") {
      const { bytes, isPng } = dataUrlToBytes(f.value);
      const image = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      // Fit within the box while preserving aspect ratio.
      const scale = Math.min(f.width / image.width, f.height / image.height);
      const drawW = image.width * scale;
      const drawH = image.height * scale;
      page.drawImage(image, {
        x: f.x + (f.width - drawW) / 2,
        y: bottomLeftY + (f.height - drawH) / 2,
        width: drawW,
        height: drawH,
      });
    } else {
      // DATE / TEXT
      const fontSize = Math.min(f.height * 0.7, 12);
      page.drawText(f.value ?? "", {
        x: f.x + 2,
        y: bottomLeftY + (f.height - fontSize) / 2 + 1,
        size: fontSize,
        font: helvetica,
        color: rgb(0.06, 0.06, 0.06),
      });
    }
  }

  // Burn down any pre-existing interactive AcroForm so the signed output can't be edited after the
  // fact (CRE/legal templates frequently ship as fillable forms). Our own marks are drawn directly
  // into page content above, so there's nothing of ours to lose. A flatten failure on a COMPLETED
  // document must NOT be swallowed — surface it so we never store an "editable signed" PDF.
  const form = doc.getForm();
  if (form.getFields().length > 0) {
    try {
      form.flatten();
    } catch (err) {
      throw new Error(
        `Failed to flatten pre-existing AcroForm fields on the signed document: ${(err as Error).message}`,
      );
    }
  }

  const out = await doc.save();
  return Buffer.from(out);
}

/** Create a tiny single-page PDF. Used by tests and as a fallback document. */
export async function createSimplePdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 72, y: 720, size: 14, font });
  const out = await doc.save();
  return Buffer.from(out);
}

/** Concatenate several PDFs into one (e.g. signed document + certificate of completion). */
export async function mergePdfs(parts: Buffer[]): Promise<Buffer> {
  const merged = await PDFDocument.create();
  for (const part of parts) {
    const src = await PDFDocument.load(part);
    const pages = await merged.copyPages(src, src.getPageIndices());
    for (const p of pages) merged.addPage(p);
  }
  const out = await merged.save();
  return Buffer.from(out);
}
