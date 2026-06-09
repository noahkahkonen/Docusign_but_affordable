import type { Prisma, PrismaClient, AuditEventType, AuthMethod } from "@prisma/client";

/**
 * Append an immutable audit event. Audit rows are never updated or deleted — they are the
 * ESIGN/UETA evidence trail. Accepts either the base client or a transaction client so callers
 * can record within the same transaction as the state change that produced the event.
 */
export interface AuditInput {
  requestId: string;
  signerId?: string | null;
  eventType: AuditEventType;
  authMethod?: AuthMethod | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Prisma.InputJsonValue;
}

type Db = PrismaClient | Prisma.TransactionClient;

export async function recordAudit(db: Db, input: AuditInput): Promise<void> {
  await db.auditEvent.create({
    data: {
      requestId: input.requestId,
      signerId: input.signerId ?? null,
      eventType: input.eventType,
      authMethod: input.authMethod ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      metadata: input.metadata,
    },
  });
}
