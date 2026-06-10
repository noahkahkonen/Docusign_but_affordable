import { describe, it, expect, vi, beforeEach } from "vitest";
import { maskTokensInUrl } from "../src/lib/logger.js";

/**
 * Mailer address handling: signer names are attacker-influenceable, so the To header must be
 * built as a structured { name, address } object. A concatenated `${name} <${email}>` string
 * gets re-parsed by nodemailer's addressparser — a name like "Foo <attacker@evil.com>" would
 * redirect the signing link (a bearer credential) to the attacker.
 */

const sendMailSpy = vi.hoisted(() => vi.fn(async () => ({ messageId: "test-id" })));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: sendMailSpy }) },
}));

vi.mock("../src/config/env.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    hasEmailCredentials: () => true,
    env: {
      ...(actual.env as Record<string, unknown>),
      SMTP_HOST: "smtp.test",
      SMTP_PORT: 587,
      BRAND_SENDER_NAME: "InkPath Signatures",
      BRAND_SENDER_EMAIL: "no-reply@inkpath.test",
    },
  };
});

describe("mailer recipient safety", () => {
  beforeEach(async () => {
    sendMailSpy.mockClear();
    const { resetMailerForTests } = await import("../src/email/mailer.js");
    resetMailerForTests();
  });

  it("passes To as a structured object so a malicious display name cannot change the recipient", async () => {
    const { sendMail } = await import("../src/email/mailer.js");
    await sendMail({
      to: "victim@corp.com",
      toName: "Foo <attacker@evil.com>",
      subject: "please sign",
      text: "t",
      html: "<p>t</p>",
    });

    expect(sendMailSpy).toHaveBeenCalledTimes(1);
    const options = sendMailSpy.mock.calls[0][0] as { to: unknown; from: unknown };
    // Structured object — the hostile name is opaque display text, the address is the victim's.
    expect(options.to).toEqual({ name: "Foo <attacker@evil.com>", address: "victim@corp.com" });
    expect(options.from).toEqual({ name: "InkPath Signatures", address: "no-reply@inkpath.test" });
  });
});

describe("log URL token masking", () => {
  it("masks signer, signer-API, and prepare tokens but leaves other URLs intact", () => {
    const tok = "O5b8LPswiE5BBk0l-GxWEoQEz_Xf_3T0_wCTPnBHHK4";
    expect(maskTokensInUrl(`/sign/${tok}`)).toBe("/sign/[token]");
    expect(maskTokensInUrl(`/api/sign/${tok}/document`)).toBe("/api/sign/[token]/document");
    expect(maskTokensInUrl(`/prepare/${tok}`)).toBe("/prepare/[token]");
    expect(maskTokensInUrl(`/api/prepare/${tok}/templates`)).toBe("/api/prepare/[token]/templates");
    expect(maskTokensInUrl("/health")).toBe("/health");
    expect(maskTokensInUrl("/api/requests/3e2a")).toBe("/api/requests/3e2a");
  });
});
