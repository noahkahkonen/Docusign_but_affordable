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
 * The "please sign" invitation a signer receives. Subject and body name the document and lead with
 * one unmistakable call-to-action button (plus a copy-paste URL fallback for clients that strip
 * the button).
 */
export function signingInvitationEmail(input: SigningInvitationInput): OutgoingEmail {
  const brand = env.BRAND_NAME;
  const color = env.BRAND_PRIMARY_COLOR;
  const days = Math.round(input.expiresInHours / 24);
  const expiry =
    input.expiresInHours % 24 === 0 && days >= 1
      ? `${days} day${days === 1 ? "" : "s"}`
      : `${input.expiresInHours} hour${input.expiresInHours === 1 ? "" : "s"}`;

  const subject = `${input.documentName} — please sign`;

  const text = [
    `Hi ${input.signerName},`,
    ``,
    `You've been asked to review and sign "${input.documentName}".`,
    ``,
    `Open your secure signing link:`,
    input.signingUrl,
    ``,
    `This personal link is valid for ${expiry}. Please don't forward it — it grants access to sign on your behalf.`,
    ``,
    `Sent via ${brand}.`,
  ].join("\n");

  const logo = env.BRAND_LOGO_URL
    ? `<img src="${escapeHtml(env.BRAND_LOGO_URL)}" alt="${escapeHtml(brand)}" height="32" style="display:block;margin-bottom:24px" />`
    : `<div style="font-size:20px;font-weight:700;color:${escapeHtml(color)};margin-bottom:24px">${escapeHtml(brand)}</div>`;

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
              ${logo}
              <p style="margin:0 0 16px;font-size:16px;line-height:1.5">Hi ${escapeHtml(input.signerName)},</p>
              <p style="margin:0 0 24px;font-size:16px;line-height:1.5">
                You've been asked to review and sign
                <strong>${escapeHtml(input.documentName)}</strong>.
              </p>
              <table role="presentation" class="ip-btn" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px">
                <tr><td align="center" bgcolor="${safeColor}" style="border-radius:8px;background:${safeColor}">
                  <a href="${safeUrl}"
                     style="display:inline-block;padding:16px 32px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;mso-padding-alt:0">
                    Review &amp; sign
                  </a>
                </td></tr>
              </table>
              <p style="margin:0 0 8px;font-size:14px;color:#6b7280;line-height:1.5">
                Or paste this link into your browser:
              </p>
              <p style="margin:0 0 24px;font-size:14px;word-break:break-all;line-height:1.5">
                <a href="${safeUrl}" style="color:${safeColor}">${safeUrl}</a>
              </p>
              <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.5">
                This personal link is valid for ${escapeHtml(expiry)}. Please don't forward it — it
                grants access to sign on your behalf.
              </p>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;font-size:12px;color:#9aa5b1">Sent via ${escapeHtml(brand)}</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { to: input.signerEmail, toName: input.signerName, subject, text, html };
}
