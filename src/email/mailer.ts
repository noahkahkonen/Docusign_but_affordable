import nodemailer, { type Transporter } from "nodemailer";
import { env, hasEmailCredentials } from "../config/env.js";
import { logger } from "../lib/logger.js";

/**
 * Thin SMTP delivery layer. Provider-agnostic (SES, SendGrid, Mailgun, Postmark, plain SMTP) via
 * nodemailer. The transport is created lazily and reused — building it per-message would re-open a
 * connection pool every time. When SMTP isn't configured, sendMail is a no-op that reports skipped,
 * so callers never have to special-case unconfigured environments.
 */

let transporter: Transporter | null = null;

function getTransport(): Transporter | null {
  if (!hasEmailCredentials()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      // When not using implicit TLS (e.g. Gmail on 587), require a STARTTLS upgrade so we never
      // send AUTH credentials over a plaintext connection.
      requireTLS: !env.SMTP_SECURE,
      // Auth is optional: some internal relays accept mail without credentials.
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

/** The branded From header, e.g. `InkPath Signatures <no-reply@inkpath.app>`. */
function fromAddress(): string {
  return `${env.BRAND_SENDER_NAME} <${env.BRAND_SENDER_EMAIL}>`;
}

export interface OutgoingEmail {
  to: string;
  toName?: string;
  subject: string;
  text: string;
  html: string;
}

export interface SendResult {
  ok: boolean;
  skipped?: boolean;
  messageId?: string;
}

/**
 * Deliver one email. Returns { skipped: true } when SMTP isn't configured rather than throwing, so
 * the signing flow degrades gracefully. Genuine SMTP failures DO throw — the caller decides whether
 * that's fatal (it isn't, for invitations: see notifications.ts).
 */
export async function sendMail(message: OutgoingEmail): Promise<SendResult> {
  const transport = getTransport();
  if (!transport) {
    logger.warn({ to: message.to }, "SMTP not configured — skipping email");
    return { ok: false, skipped: true };
  }

  const info = await transport.sendMail({
    from: fromAddress(),
    to: message.toName ? `${message.toName} <${message.to}>` : message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });

  return { ok: true, messageId: info.messageId };
}

/** Test seam: drop the cached transport so a reconfigured env is picked up. */
export function resetMailerForTests(): void {
  transporter = null;
}
