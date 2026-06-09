import { describe, it, expect } from "vitest";
import { signingInvitationEmail } from "../src/email/templates.js";
import { sendMail, resetMailerForTests } from "../src/email/mailer.js";

describe("signing invitation template", () => {
  const base = {
    signerName: "Dana <Buyer>",
    signerEmail: "dana@example.com",
    documentName: "Purchase & Sale Agreement",
    signingUrl: "https://sign.example.com/sign/abc123",
    expiresInHours: 168,
  };

  it("names the document, links the button, and hides the raw URL from the text body", () => {
    const email = signingInvitationEmail(base);
    expect(email.subject).toContain("Purchase & Sale Agreement");
    expect(email.to).toBe("dana@example.com");
    expect(email.toName).toBe("Dana <Buyer>");
    // The button carries the link; the raw URL is intentionally not shown anywhere as text.
    expect(email.html).toContain(`href="${base.signingUrl}"`);
    expect(email.text).not.toContain(base.signingUrl);
  });

  it("includes the trust line, wordmark dot, and the Kahkonen Company footer", () => {
    const email = signingInvitationEmail(base);
    expect(email.html).toContain("Noah Kahkonen");
    expect(email.html).toContain("Best Corporate Real Estate");
    expect(email.html).toContain("Sent via InkPath, a Kahkonen Company");
    expect(email.text).toContain("Sent via InkPath, a Kahkonen Company");
    // Wordmark: brand letters then a coloured dot span.
    expect(email.html).toContain("InkPath<span");
  });

  it("renders the TTL in days when it divides evenly, hours otherwise", () => {
    expect(signingInvitationEmail({ ...base, expiresInHours: 168 }).text).toContain("7 days");
    expect(signingInvitationEmail({ ...base, expiresInHours: 24 }).text).toContain("1 day");
    expect(signingInvitationEmail({ ...base, expiresInHours: 5 }).text).toContain("5 hours");
  });

  it("is mobile/cross-client safe: viewport meta, fluid max-width, table layout", () => {
    const html = signingInvitationEmail(base).html;
    expect(html).toContain('name="viewport"');
    expect(html).toContain("max-width:520px");
    // Fluid, not a fixed pixel container that would overflow a phone.
    expect(html).toContain("width:100%");
    // Outlook renders the button cell colour via the bgcolor attribute, not just CSS.
    expect(html).toContain("bgcolor=");
    expect(html).toContain('role="presentation"');
  });

  it("escapes signer/document values so they can't inject markup into the HTML body", () => {
    const email = signingInvitationEmail(base);
    expect(email.html).toContain("Dana &lt;Buyer&gt;");
    expect(email.html).not.toContain("Dana <Buyer>");
  });
});

describe("mailer", () => {
  it("skips (does not throw) when SMTP is not configured", async () => {
    // test/setup.ts intentionally leaves SMTP_* unset.
    resetMailerForTests();
    const result = await sendMail({
      to: "dana@example.com",
      subject: "hi",
      text: "hi",
      html: "<p>hi</p>",
    });
    expect(result).toEqual({ ok: false, skipped: true });
  });
});
