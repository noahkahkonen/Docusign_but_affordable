import { env } from "../config/env.js";
import type { OutgoingEmail } from "./mailer.js";

/**
 * Email templates. Kept as pure functions (env-driven branding, no I/O) so they're trivially
 * unit-testable and the mailer stays a dumb transport. HTML uses inline styles only — email
 * clients strip <style> blocks and have no external CSS.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface SigningInvitationInput {
  signerName: string;
  signerEmail: string;
  documentName: string;
  signingUrl: string;
  /** Whole hours the link stays valid; surfaced so the signer knows the deadline. */
  expiresInHours: number;
}

/**
 * The "please sign" invitation a signer receives. Leads with the InkPath wordmark (black letters,
 * green dot), names the document, says who it's from (trust), and offers one call-to-action button.
 * No raw URL is shown (cleaner + better for spam filters); the button carries the link. Fine print:
 * "Valid for N days" and the "a Kahkonen Company" footer.
 */
export function signingInvitationEmail(input: SigningInvitationInput): OutgoingEmail {
  const brand = env.BRAND_NAME;
  const color = env.BRAND_PRIMARY_COLOR;
  const sentBy = env.BRAND_SENT_BY_NAME;
  const company = env.BRAND_SENT_BY_COMPANY;
  const footer = env.BRAND_EMAIL_FOOTER;
  const days = Math.round(input.expiresInHours / 24);
  const expiry =
    input.expiresInHours % 24 === 0 && days >= 1
      ? `${days} day${days === 1 ? "" : "s"}`
      : `${input.expiresInHours} hour${input.expiresInHours === 1 ? "" : "s"}`;

  const subject = `${input.documentName} — please sign`;
  const ink = "#0f172a"; // near-black for the wordmark letters

  const text = [
    `Hi ${input.signerName},`,
    ``,
    `You've been asked to review and sign "${input.documentName}".`,
    ``,
    `This was sent to you by ${sentBy} at ${company}.`,
    ``,
    `Use the "Review & sign" button in this email to open your secure signing page.`,
    ``,
    `Valid for ${expiry}.`,
    ``,
    footer,
  ].join("\n");

  const safeUrl = escapeHtml(input.signingUrl);
  const safeColor = escapeHtml(color);

  // Email HTML is its own dialect: clients strip <head>/<style> unevenly, Outlook renders via Word,
  // and mobile clients need an explicit viewport. So: table-based layout, every visual rule inlined
  // (the <style> block is progressive enhancement only), a fluid container that caps at 520px but
  // shrinks on phones, and ≥16px body text so iOS Mail doesn't auto-zoom. The button is a padded
  // table cell (not a styled <a> alone) so it stays tappable and coloured even where CSS is dropped.
  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="color-scheme" content="light dark" />
    <title>${escapeHtml(subject)}</title>
    <style>
      /* Progressive enhancement only — inline styles below are the real baseline. */
      @media only screen and (max-width:600px) {
        .ip-card { width:100% !important; padding:24px !important; border-radius:0 !important; }
        .ip-btn a { display:block !important; text-align:center !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;width:100%;background:#f6f6f4;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2933">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f6f4">
      <tr>
        <td align="center" style="padding:32px 16px">
          <table role="presentation" class="ip-card" width="520" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;background:#ffffff;border-radius:12px;padding:32px">
            <tr><td>
              <div style="font-size:24px;font-weight:700;letter-spacing:-0.01em;color:${ink};margin-bottom:26px">${escapeHtml(brand)}<span style="color:${safeColor}">.</span></div>
              <p style="margin:0 0 16px;font-size:16px;line-height:1.5">Hi ${escapeHtml(input.signerName)},</p>
              <p style="margin:0 0 16px;font-size:16px;line-height:1.5">
                You've been asked to review and sign
                <strong>${escapeHtml(input.documentName)}</strong>.
              </p>
              <p style="margin:0 0 24px;font-size:15px;line-height:1.5;color:#334155">
                This was sent to you by <strong>${escapeHtml(sentBy)}</strong> at
                <strong>${escapeHtml(company)}</strong>.
              </p>
              <table role="presentation" class="ip-btn" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px">
                <tr><td align="center" bgcolor="${safeColor}" style="border-radius:8px;background:${safeColor}">
                  <a href="${safeUrl}"
                     style="display:inline-block;padding:16px 32px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;mso-padding-alt:0">
                    Review &amp; sign
                  </a>
                </td></tr>
              </table>
              <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.5">
                Valid for ${escapeHtml(expiry)}.
              </p>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;font-size:12px;color:#9aa5b1">${escapeHtml(footer)}</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { to: input.signerEmail, toName: input.signerName, subject, text, html };
}
