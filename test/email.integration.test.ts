import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

/**
 * Email delivery against a real Postgres, with SMTP mocked at the nodemailer boundary (no network).
 * Asserts that sending a request emails every signer their personal link and records an
 * EMAIL_DELIVERED audit event per delivery, and that /resend re-mints + re-emails unsigned signers.
 *
 * SMTP_* must be set BEFORE config/env.js is first imported (env is parsed once at module load),
 * so we set it at the top of beforeAll, before the lazy imports. process.env is shared across test
 * files in a vitest worker (only modules are isolated), so we delete it in afterAll — otherwise it
 * would leak into flow.integration.test.ts, which doesn't mock SMTP and would dial a dead host.
 *
 * Runs only when RUN_DB_TESTS=1 and DATABASE_URL points at a reachable database (CI sets both).
 */

// Shared spy for the mocked transport's sendMail.
const mail = vi.hoisted(() => ({
  sendMail: vi.fn(async (_msg: unknown) => ({ messageId: "test-message-id" })),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: mail.sendMail }) },
}));

const holder = vi.hoisted(() => ({ pdf: null as Buffer | null }));
vi.mock("../src/salesforce/files.js", () => ({
  downloadFileBytes: vi.fn(async () => holder.pdf),
  isSalesforceId: () => true,
}));

const run = process.env.RUN_DB_TESTS === "1";

describe.runIf(run)("email delivery (integration)", () => {
  let mod: typeof import("../src/signing/requests.js");
  let prismaMod: typeof import("../src/db/prisma.js");
  let requestId: string;

  beforeAll(async () => {
    // Enable email before any config/env import in this file's module registry.
    process.env.SMTP_HOST = "smtp.test.local";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_USER = "user";
    process.env.SMTP_PASS = "pass";

    const { createSimplePdf } = await import("../src/signing/pdf.js");
    holder.pdf = await createSimplePdf("Lease Agreement — 500 Oak Ave");
    mod = await import("../src/signing/requests.js");
    prismaMod = await import("../src/db/prisma.js");

    await prismaMod.prisma.auditEvent.deleteMany();
    await prismaMod.prisma.field.deleteMany();
    await prismaMod.prisma.signer.deleteMany();
    await prismaMod.prisma.signatureRequest.deleteMany();

    const created = await mod.createSignatureRequest({
      salesforceRecordId: "006Pe000001AbCdEFG",
      salesforceObjectType: "Opportunity",
      contentVersionId: "068Pe000018bqU0IAI",
      documentName: "Lease Agreement.pdf",
      signers: [
        { name: "Robert Chaykin", email: "robert@example.com", entityLabel: "Acme LLC — Tenant" },
        { name: "Dana Lee", email: "dana@example.com", entityLabel: "Oak Ave LLC — Landlord" },
      ],
      fields: [
        { signerIndex: 0, type: "SIGNATURE", pageIndex: 0, x: 100, y: 600, width: 180, height: 50 },
        { signerIndex: 1, type: "SIGNATURE", pageIndex: 0, x: 100, y: 500, width: 180, height: 50 },
      ],
    });
    requestId = created.requestId;
  });

  afterAll(async () => {
    await prismaMod.prisma.$disconnect();
    // Don't leak SMTP config into sibling test files that share this worker's process.env.
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
  });

  beforeEach(() => {
    mail.sendMail.mockClear();
  });

  it("emails every signer their personal link when the request is sent", async () => {
    const links = await mod.sendSignatureRequest(requestId);
    expect(links).toHaveLength(2);

    // One email per signer.
    expect(mail.sendMail).toHaveBeenCalledTimes(2);

    // Each email goes to the right signer and carries that signer's exact link.
    const byRecipient = new Map(
      mail.sendMail.mock.calls.map(([msg]) => {
        const m = msg as { to: string; subject: string; html: string; text: string };
        return [m.to, m];
      }),
    );
    for (const link of links) {
      const sent = [...byRecipient.values()].find((m) => m.to.includes(link.email));
      expect(sent, `email to ${link.email}`).toBeTruthy();
      expect(sent!.subject).toContain("Lease Agreement.pdf");
      // The link lives in the button href; the raw URL is intentionally not shown as text.
      expect(sent!.html).toContain(`href="${link.url}"`);
      expect(sent!.text).not.toContain(link.url);
    }
  });

  it("records an EMAIL_DELIVERED audit event per signer with the message id", async () => {
    const events = await prismaMod.prisma.auditEvent.findMany({
      where: { requestId, eventType: "EMAIL_DELIVERED" },
    });
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.signerId).toBeTruthy();
      expect((e.metadata as { messageId?: string }).messageId).toBe("test-message-id");
    }
  });

  it("resend re-mints a fresh link for unsigned signers and re-emails them", async () => {
    const before = await prismaMod.prisma.signer.findMany({
      where: { requestId },
      select: { id: true, accessTokenHash: true },
    });
    const hashBefore = new Map(before.map((s) => [s.id, s.accessTokenHash]));

    const links = await mod.resendSignatureRequest(requestId);
    expect(links).toHaveLength(2); // neither signer has signed yet
    expect(mail.sendMail).toHaveBeenCalledTimes(2);

    // Tokens were rotated — the old links no longer resolve.
    const after = await prismaMod.prisma.signer.findMany({
      where: { requestId },
      select: { id: true, accessTokenHash: true },
    });
    for (const s of after) {
      expect(s.accessTokenHash).not.toBe(hashBefore.get(s.id));
    }
  });
});
