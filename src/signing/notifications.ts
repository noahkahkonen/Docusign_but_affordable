import { prisma } from "../db/prisma.js";
import { env, hasEmailCredentials } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { recordAudit } from "./audit.js";
import { sendMail } from "../email/mailer.js";
import { signingInvitationEmail } from "../email/templates.js";
import type { SigningLink } from "./requests.js";

export interface InvitationDeliveryResult {
  attempted: number;
  delivered: number;
  skipped: boolean; // true when SMTP isn't configured (nothing was attempted)
}

/**
 * Email each signer their personal signing link and record an EMAIL_DELIVERED audit event per
 * successful send.
 *
 * Best-effort by design (mirrors the Salesforce write-back): a per-signer SMTP failure is logged
 * but does NOT abort the others or fail the enclosing /send call — the request is already SENT and
 * the links are returned in the API response, so a sender can always fall back to manual delivery
 * or hit /resend. When SMTP isn't configured at all we short-circuit and report skipped.
 */
export async function sendSigningInvitations(
  requestId: string,
  links: SigningLink[],
): Promise<InvitationDeliveryResult> {
  if (!hasEmailCredentials()) {
    logger.warn({ requestId }, "SMTP not configured — signing links not emailed");
    return { attempted: 0, delivered: 0, skipped: true };
  }

  const request = await prisma.signatureRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: { documentName: true },
  });

  let delivered = 0;
  for (const link of links) {
    const email = signingInvitationEmail({
      signerName: link.name,
      signerEmail: link.email,
      documentName: request.documentName,
      signingUrl: link.url,
      expiresInHours: env.SIGNING_LINK_TTL_HOURS,
    });

    try {
      const result = await sendMail(email);
      if (!result.ok) continue; // skipped (shouldn't happen — gated above — but stay safe)
      delivered += 1;
      await recordAudit(prisma, {
        requestId,
        signerId: link.signerId,
        eventType: "EMAIL_DELIVERED",
        metadata: { email: link.email, messageId: result.messageId ?? null },
      });
    } catch (err) {
      logger.error({ requestId, signerId: link.signerId, err }, "Failed to email signing link");
      // The legal trail must record non-delivery: "was the signer ever notified?" is exactly
      // what gets asked in a dispute. Never let this audit write mask the delivery error.
      try {
        await recordAudit(prisma, {
          requestId,
          signerId: link.signerId,
          eventType: "EMAIL_FAILED",
          metadata: { email: link.email, error: (err as Error).message },
        });
      } catch (auditErr) {
        logger.error({ requestId, signerId: link.signerId, auditErr }, "Failed to record EMAIL_FAILED audit");
      }
    }
  }

  logger.info({ requestId, attempted: links.length, delivered }, "Signing invitations processed");
  return { attempted: links.length, delivered, skipped: false };
}
