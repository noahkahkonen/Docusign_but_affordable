import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Load .env in non-production. On Heroku, config vars are injected directly.
if (process.env.NODE_ENV !== "production") {
  loadDotenv();
}

/**
 * Centralised, validated configuration. Nothing else in the app reads process.env
 * directly — this is the single choke point so missing/!malformed config fails fast
 * at boot rather than deep inside a request.
 *
 * NOTE: secrets (Salesforce private key, DB url) come from the environment only.
 * They must never be committed. See .env.example for the contract.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Public base URL of this backend (used to build signer links + the SF Named Credential target).
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // --- Salesforce OAuth 2.0 JWT bearer flow ---
  // A Connected App with a certificate; we sign a JWT with the private key and exchange
  // it for an access token. No username/password is ever stored.
  SF_LOGIN_URL: z
    .string()
    .url()
    .default("https://login.salesforce.com"), // use https://test.salesforce.com for sandboxes
  SF_CLIENT_ID: z.string().optional(), // Connected App consumer key
  SF_USERNAME: z.string().optional(), // the integration user to impersonate
  SF_PRIVATE_KEY: z.string().optional(), // PEM contents (literal \n allowed); see normalisePrivateKey
  SF_API_VERSION: z.string().default("60.0"),

  // Signer access tokens: how long a signing link stays valid.
  SIGNING_LINK_TTL_HOURS: z.coerce.number().int().positive().default(168), // 7 days

  // --- Email delivery (SMTP) ---
  // Provider-agnostic SMTP relay used to email signing links. Works with Amazon SES, SendGrid,
  // Mailgun, Postmark, or a plain SMTP server. If SMTP_HOST is unset, email is disabled and the
  // /send call still succeeds (links are returned in the response for manual delivery).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.coerce.boolean().default(false), // true for port 465 (implicit TLS); false uses STARTTLS
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  // Shared secret guarding the sender/admin API (create/send requests). The Salesforce side
  // presents this via the Named Credential. If unset (dev only), the guard is disabled and a
  // warning is logged at boot.
  BACKEND_API_KEY: z.string().optional(),

  // Branding (light, simple, inviting — emerald). Overridable per-deployment.
  BRAND_NAME: z.string().default("InkPath"),
  BRAND_PRIMARY_COLOR: z.string().default("#10b981"), // emerald-500
  BRAND_LOGO_URL: z.string().optional(),
  BRAND_SENDER_NAME: z.string().default("InkPath Signatures"),
  BRAND_SENDER_EMAIL: z.string().email().default("no-reply@example.com"),
  })
  .superRefine((val, ctx) => {
    // The sender/admin API hands out signed contracts and audit trails. Refuse to boot in
    // production without a key rather than silently serving it unguarded.
    if (val.NODE_ENV === "production" && !val.BACKEND_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["BACKEND_API_KEY"],
        message: "BACKEND_API_KEY is required when NODE_ENV=production (the sender API must be guarded).",
      });
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  // Fail loudly and early.
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const raw = parsed.data;

/**
 * PEM keys carry literal newlines. When stored in a single-line env var (Heroku config var,
 * .env), those are commonly escaped as "\n". Restore them so the crypto layer gets valid PEM.
 */
function normalisePrivateKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

export const env = {
  ...raw,
  SF_PRIVATE_KEY: normalisePrivateKey(raw.SF_PRIVATE_KEY),
  isProduction: raw.NODE_ENV === "production",
} as const;

/**
 * True only when every Salesforce credential needed for the JWT bearer flow is present.
 * Routes that touch Salesforce check this so the app still boots (and serves health) in
 * environments where SF isn't wired up yet.
 */
export function hasSalesforceCredentials(): boolean {
  return Boolean(env.SF_CLIENT_ID && env.SF_USERNAME && env.SF_PRIVATE_KEY);
}

/**
 * True only when an SMTP relay is configured. Routes/services that email signers check this so
 * the app still sends requests (returning links for manual delivery) when email isn't wired up.
 */
export function hasEmailCredentials(): boolean {
  return Boolean(env.SMTP_HOST);
}
