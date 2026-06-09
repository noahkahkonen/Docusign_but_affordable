import type { FieldType } from "@prisma/client";
import type { PageLayout } from "./pdf.js";

/**
 * Automatic field placement.
 *
 * The Salesforce LWC lets a sender pick which fields each signer needs (signature, date, title,
 * …) without dragging boxes onto a PDF. The backend — which knows the real page geometry — lays
 * them out on the LAST page in a per-signer horizontal band. This keeps the LWC simple while
 * still supporting free-text fields like "Title".
 *
 * Coordinates are top-left origin in PDF points, matching the `fields` table and the flattener.
 */

export interface AutoFieldRequest {
  signerIndex: number;
  type: FieldType;
}

export interface PlacedField {
  signerIndex: number;
  type: FieldType;
  label: string;
  required: boolean;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

const MARGIN = 54;
const BAND_HEIGHT = 110; // vertical space reserved per signer
const BAND_TOP = 110; // distance from the top of the page to the first band

// Fixed slot geometry within a signer's band (offsets are from the band's top-left).
const SLOTS: Record<FieldType, { dx: number; dy: number; w: number; h: number; label: string }> = {
  SIGNATURE: { dx: 0, dy: 24, w: 210, h: 48, label: "Signature" },
  INITIALS: { dx: 230, dy: 24, w: 70, h: 48, label: "Initials" },
  DATE: { dx: 320, dy: 40, w: 110, h: 18, label: "Date" },
  TEXT: { dx: 450, dy: 40, w: 150, h: 18, label: "Title" },
};

/**
 * Expand per-signer field-type requests into concrete placements on the last page. Bands stack
 * downward per signer; if they'd run off the page we clamp to keep everything on-page.
 */
export function autoPlaceFields(layouts: PageLayout[], requests: AutoFieldRequest[]): PlacedField[] {
  if (layouts.length === 0) return [];
  const page = layouts[layouts.length - 1];

  // Group requested types by signer, preserving first-seen order of signers.
  const bySigner = new Map<number, FieldType[]>();
  for (const r of requests) {
    const list = bySigner.get(r.signerIndex) ?? [];
    if (!list.includes(r.type)) list.push(r.type);
    bySigner.set(r.signerIndex, list);
  }

  const placed: PlacedField[] = [];
  let band = 0;
  for (const [signerIndex, types] of bySigner) {
    // Top of this band, measured from the top of the page.
    let bandTop = BAND_TOP + band * BAND_HEIGHT;
    const maxTop = page.height - BAND_HEIGHT;
    if (bandTop > maxTop) bandTop = maxTop; // clamp onto the page

    for (const type of types) {
      const slot = SLOTS[type];
      const width = Math.min(slot.w, page.width - 2 * MARGIN - slot.dx);
      placed.push({
        signerIndex,
        type,
        label: slot.label,
        required: true,
        pageIndex: page.pageIndex,
        x: MARGIN + slot.dx,
        y: bandTop + slot.dy,
        width: Math.max(40, width),
        height: slot.h,
      });
    }
    band += 1;
  }
  return placed;
}
