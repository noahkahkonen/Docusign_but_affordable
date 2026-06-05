import { env } from "../config/env.js";

/**
 * Electronic-records consent disclosure (ESIGN Act §101(c) / UETA §5).
 *
 * The signer must affirmatively agree to do business electronically BEFORE signing. We version
 * the disclosure so the audit trail records the exact text a given signer agreed to — if the
 * wording changes later, historical consents still point at what was actually shown.
 *
 * This is a reasonable, plain-language disclosure — NOT legal advice. Have counsel review the
 * wording for your jurisdiction and document types.
 */

export const CONSENT_VERSION = "2026-06-01";

export function consentDisclosure(): { version: string; text: string } {
  const brand = env.BRAND_NAME;
  const text = [
    `Consent to Use Electronic Records and Signatures`,
    ``,
    `By selecting "I agree" you consent to conduct this transaction electronically with ` +
      `${brand} and the sending party, and to the use of electronic records and electronic ` +
      `signatures in place of paper documents and handwritten signatures.`,
    ``,
    `1. Electronic delivery. You agree that the document presented here, the completed signed ` +
      `document, and the certificate of completion may be provided to you electronically.`,
    `2. Hardware/software. To view and sign you need a modern web browser, internet access, and ` +
      `the ability to view and download PDF files. You should be able to retain a copy of the ` +
      `signed document for your records.`,
    `3. Withdrawing consent. You may withdraw your consent and decline to sign electronically at ` +
      `any time before you complete signing by closing this page or selecting "Decline". Doing ` +
      `so means the document will not be signed by you electronically.`,
    `4. Paper copies. You may request a paper copy of any record from the sending party.`,
    `5. Legal effect. Your electronic signature on this document is intended to have the same ` +
      `force and effect as a handwritten signature, consistent with the U.S. ESIGN Act and ` +
      `applicable UETA.`,
    ``,
    `This consent applies only to this transaction.`,
  ].join("\n");

  return { version: CONSENT_VERSION, text };
}
