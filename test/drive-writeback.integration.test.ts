import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { sha256, md5, toPrismaBytes } from "../src/lib/hash.js";

/**
 * attemptDriveWriteback against a real Postgres, with Salesforce (deal read/write) and the Google
 * Drive REST calls mocked. Verifies folder resolution/creation, idempotent uploads, integrity
 * warnings, the not-a-deal / not-configured skips, and audit events.
 *
 * Runs only when RUN_DB_TESTS=1.
 */

const driveCfg = vi.hoisted(() => ({ enabled: true, sharedDriveId: "SHARED_DRIVE" as string | undefined }));
const driveState = vi.hoisted(() => ({
  existing: null as { id: string; name: string; md5Checksum?: string } | null,
  createdFolderId: "created-folder-1",
}));
const dealState = vi.hoisted(() => ({
  info: { name: "Acme Tower", driveFolderUrl: null as string | null },
}));

vi.mock("../src/config/env.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  // env.GOOGLE_DRIVE_SHARED_DRIVE_ID must read driveCfg LIVE (a static copy would freeze whatever
  // value existed when this factory ran), so expose it as a getter over the real env object.
  const envMock = Object.create(actual.env as object);
  Object.defineProperty(envMock, "GOOGLE_DRIVE_SHARED_DRIVE_ID", {
    get: () => driveCfg.sharedDriveId,
    enumerable: true,
  });
  return {
    ...actual,
    hasGoogleDriveCredentials: vi.fn(() => driveCfg.enabled),
    env: envMock,
  };
});

vi.mock("../src/salesforce/deal.js", () => ({
  getDealDriveInfo: vi.fn(async () => dealState.info),
  setDealDriveFolder: vi.fn(async () => {}),
}));

vi.mock("../src/google/drive.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual, // keep parseDriveFolderId + driveFolderUrl real
    findFileInFolder: vi.fn(async () => driveState.existing),
    createFolder: vi.fn(async (name: string) => ({ id: driveState.createdFolderId, name })),
    uploadFile: vi.fn(async (_folderId: string, name: string, bytes: Buffer) => ({
      id: `drive-file-${name.includes("Certificate") ? "cert" : "signed"}`,
      name,
      md5Checksum: md5(bytes),
    })),
  };
});

const run = process.env.RUN_DB_TESTS === "1";

describe.runIf(run)("Google Drive write-back (integration)", () => {
  let mod: typeof import("../src/signing/drive-writeback.js");
  let deal: typeof import("../src/salesforce/deal.js");
  let drive: typeof import("../src/google/drive.js");
  let prismaMod: typeof import("../src/db/prisma.js");
  let logger: typeof import("../src/lib/logger.js");

  const signedBytes = Buffer.from("%PDF-1.7 signed-document-bytes");
  const certBytes = Buffer.from("%PDF-1.7 certificate-bytes");

  beforeAll(async () => {
    mod = await import("../src/signing/drive-writeback.js");
    deal = await import("../src/salesforce/deal.js");
    drive = await import("../src/google/drive.js");
    prismaMod = await import("../src/db/prisma.js");
    logger = await import("../src/lib/logger.js");
  });

  afterAll(async () => {
    await prismaMod.prisma.$disconnect();
  });

  async function makeCompletedDeal(overrides: Record<string, unknown> = {}) {
    return prismaMod.prisma.signatureRequest.create({
      data: {
        salesforceRecordId: "a0LPe00001IBd1ZMAT",
        salesforceObjectType: "TTL_Core__Deal__c",
        originalContentVersionId: "068Pe000018bqU0IAI",
        documentName: "Agency Disclosure.pdf",
        status: "COMPLETED",
        completedAt: new Date("2026-06-14T12:00:00.000Z"),
        docHashFinal: sha256(signedBytes),
        signedPdf: toPrismaBytes(signedBytes),
        certificatePdf: toPrismaBytes(certBytes),
        ...overrides,
      },
    });
  }

  beforeEach(async () => {
    driveCfg.enabled = true;
    driveCfg.sharedDriveId = "SHARED_DRIVE";
    driveState.existing = null;
    driveState.createdFolderId = "created-folder-1";
    dealState.info = { name: "Acme Tower", driveFolderUrl: null };
    vi.mocked(deal.getDealDriveInfo).mockClear();
    vi.mocked(deal.setDealDriveFolder).mockClear();
    vi.mocked(drive.createFolder).mockClear();
    vi.mocked(drive.uploadFile).mockClear();
    vi.mocked(drive.findFileInFolder).mockClear();
    await prismaMod.prisma.auditEvent.deleteMany();
    await prismaMod.prisma.signer.deleteMany();
    await prismaMod.prisma.signatureRequest.deleteMany();
  });

  it("uploads signed + certificate into an existing deal folder and verifies the hash", async () => {
    dealState.info = { name: "Acme Tower", driveFolderUrl: "https://drive.google.com/drive/folders/EXISTING123" };
    const req = await makeCompletedDeal();

    const result = await mod.attemptDriveWriteback(req.id);

    expect(result.ok).toBe(true);
    expect(result.folderId).toBe("EXISTING123");
    expect(result.hashVerified).toBe(true);
    expect(vi.mocked(drive.createFolder)).not.toHaveBeenCalled();
    expect(vi.mocked(deal.setDealDriveFolder)).not.toHaveBeenCalled();
    expect(vi.mocked(drive.uploadFile)).toHaveBeenCalledTimes(2);

    // Filename convention.
    const signedName = vi.mocked(drive.uploadFile).mock.calls[0][1];
    expect(signedName).toBe("Acme Tower — Agency Disclosure — SIGNED 2026-06-14.pdf");
    const certName = vi.mocked(drive.uploadFile).mock.calls[1][1];
    expect(certName).toContain("— Certificate.pdf");

    const row = await prismaMod.prisma.signatureRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.driveFolderId).toBe("EXISTING123");
    expect(row.driveSignedFileId).toBe("drive-file-signed");
    expect(row.driveCertificateFileId).toBe("drive-file-cert");

    const audit = await prismaMod.prisma.auditEvent.findFirst({
      where: { requestId: req.id, eventType: "DRIVE_WRITEBACK_SUCCEEDED" },
    });
    expect(audit).toBeTruthy();
  });

  it("creates the folder and writes its URL back to the deal when the field is empty", async () => {
    dealState.info = { name: "Acme Tower", driveFolderUrl: null };
    const req = await makeCompletedDeal();

    const result = await mod.attemptDriveWriteback(req.id);

    expect(result.ok).toBe(true);
    expect(result.folderId).toBe("created-folder-1");
    expect(vi.mocked(drive.createFolder)).toHaveBeenCalledWith("Acme Tower (Deal Files)", "SHARED_DRIVE");
    expect(vi.mocked(deal.setDealDriveFolder)).toHaveBeenCalledWith(
      "a0LPe00001IBd1ZMAT",
      "https://drive.google.com/drive/folders/created-folder-1",
    );
    const row = await prismaMod.prisma.signatureRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.driveFolderId).toBe("created-folder-1");
  });

  it("is idempotent — a second run uploads nothing", async () => {
    dealState.info = { name: "Acme Tower", driveFolderUrl: "https://drive.google.com/drive/folders/EXISTING123" };
    const req = await makeCompletedDeal();

    await mod.attemptDriveWriteback(req.id);
    expect(vi.mocked(drive.uploadFile)).toHaveBeenCalledTimes(2);

    vi.mocked(drive.uploadFile).mockClear();
    const second = await mod.attemptDriveWriteback(req.id);
    expect(second.ok).toBe(true);
    expect(vi.mocked(drive.uploadFile)).not.toHaveBeenCalled(); // persisted ids → skip
  });

  it("recovers from a lost DB id by finding an existing file of the same name (no duplicate)", async () => {
    dealState.info = { name: "Acme Tower", driveFolderUrl: "https://drive.google.com/drive/folders/EXISTING123" };
    driveState.existing = { id: "already-there", name: "x", md5Checksum: md5(signedBytes) };
    const req = await makeCompletedDeal();

    await mod.attemptDriveWriteback(req.id);
    expect(vi.mocked(drive.uploadFile)).not.toHaveBeenCalled(); // found existing → no upload
    const row = await prismaMod.prisma.signatureRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.driveSignedFileId).toBe("already-there");
  });

  it("skips when the source object is not a deal", async () => {
    const req = await makeCompletedDeal({ salesforceObjectType: "Opportunity" });
    const result = await mod.attemptDriveWriteback(req.id);
    expect(result).toMatchObject({ ok: false, skipped: true, reason: "not_a_deal" });
    expect(vi.mocked(drive.uploadFile)).not.toHaveBeenCalled();
  });

  it("skips when Google Drive isn't configured", async () => {
    driveCfg.enabled = false;
    const req = await makeCompletedDeal();
    const result = await mod.attemptDriveWriteback(req.id);
    expect(result).toMatchObject({ ok: false, skipped: true, reason: "google_drive_not_configured" });
  });

  it("warns (but still succeeds) when the signed bytes don't match Final_Document_Hash__c", async () => {
    dealState.info = { name: "Acme Tower", driveFolderUrl: "https://drive.google.com/drive/folders/EXISTING123" };
    const req = await makeCompletedDeal({ docHashFinal: "0".repeat(64) }); // deliberate mismatch
    const warnSpy = vi.spyOn(logger.logger, "warn");

    const result = await mod.attemptDriveWriteback(req.id);

    expect(result.ok).toBe(true);
    expect(result.hashVerified).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: req.id }),
      expect.stringMatching(/does not match Final_Document_Hash__c/),
    );
    warnSpy.mockRestore();
  });

  it("records DRIVE_WRITEBACK_FAILED and throws when a folder must be created but no Shared Drive is set", async () => {
    driveCfg.sharedDriveId = undefined;
    dealState.info = { name: "Acme Tower", driveFolderUrl: null };
    const req = await makeCompletedDeal();

    await expect(mod.attemptDriveWriteback(req.id)).rejects.toThrow(/Shared Drive/i);
    const failed = await prismaMod.prisma.auditEvent.findFirst({
      where: { requestId: req.id, eventType: "DRIVE_WRITEBACK_FAILED" },
    });
    expect(failed).toBeTruthy();
  });
});
