/**
 * M1 acceptance script — proves the Salesforce read path end-to-end.
 *
 *   npm run check:read-path -- <salesforceRecordId>
 *
 * Steps, all against the live org:
 *   1. Authenticate via the JWT bearer flow and confirm identity.
 *   2. List all files on the record (newest first).
 *   3. Pick the latest, download its bytes, and compute the original-document SHA-256.
 *
 * Requires SF_CLIENT_ID, SF_USERNAME, SF_PRIVATE_KEY (+ SF_LOGIN_URL for sandboxes) in the env.
 * No data is written back — this is read-only.
 */
import { salesforce } from "../src/salesforce/client.js";
import { listRecordFiles, downloadFileBytes } from "../src/salesforce/files.js";
import { sha256 } from "../src/lib/hash.js";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const recordId = process.argv[2];
  if (!recordId) {
    console.error("Usage: npm run check:read-path -- <salesforceRecordId>");
    process.exit(1);
  }

  console.log("1) Authenticating to Salesforce…");
  const who = await salesforce.whoami();
  console.log(`   ✓ Connected. user=${who.userId} org=${who.organizationId}`);
  console.log(`   instance=${who.instanceUrl}\n`);

  console.log(`2) Listing files on record ${recordId}…`);
  const files = await listRecordFiles(recordId);
  if (files.length === 0) {
    console.log("   (no files attached to this record)");
    return;
  }
  for (const [i, f] of files.entries()) {
    const marker = i === 0 ? "→ latest" : "        ";
    console.log(
      `   ${marker} ${f.title} [${f.fileExtension ?? "?"}] ` +
        `${fmtBytes(f.contentSize)} modified ${f.modifiedDate}` +
        `${f.isPdf ? "" : "  (not PDF — needs conversion before signing)"}`,
    );
  }

  const latest = files[0];
  console.log(`\n3) Downloading latest file "${latest.title}"…`);
  const bytes = await downloadFileBytes(latest.latestVersionId);
  console.log(`   ✓ Downloaded ${fmtBytes(bytes.length)}`);
  console.log(`   SHA-256 (original): ${sha256(bytes)}`);

  console.log("\n✅ M1 read path verified end-to-end.");
}

main().catch((err) => {
  console.error("\n❌ Read-path check failed:", err.message);
  process.exit(1);
});
