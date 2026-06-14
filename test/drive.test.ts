import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The Drive client's only auth dependency — stub it so no token endpoint is contacted.
vi.mock("../src/google/auth.js", () => ({
  getDriveAccessToken: vi.fn(async () => "test-access-token"),
}));

import {
  parseDriveFolderId,
  driveFolderUrl,
  findFileInFolder,
  createFolder,
  uploadFile,
} from "../src/google/drive.js";

describe("parseDriveFolderId", () => {
  it("extracts the id from folder URLs and bare ids", () => {
    expect(parseDriveFolderId("https://drive.google.com/drive/folders/1AbC_def-123")).toBe("1AbC_def-123");
    expect(parseDriveFolderId("https://drive.google.com/drive/u/0/folders/1AbC_def-123?usp=sharing")).toBe("1AbC_def-123");
    expect(parseDriveFolderId("https://drive.google.com/drive/folders/1AbC_def-123/")).toBe("1AbC_def-123");
    expect(parseDriveFolderId("1AbC_def-1234567")).toBe("1AbC_def-1234567"); // bare id
  });

  it("returns null for empty/non-folder values", () => {
    expect(parseDriveFolderId(null)).toBeNull();
    expect(parseDriveFolderId("")).toBeNull();
    expect(parseDriveFolderId("https://example.com/not-drive")).toBeNull();
    expect(parseDriveFolderId("short")).toBeNull();
  });

  it("builds a canonical folder URL", () => {
    expect(driveFolderUrl("XYZ")).toBe("https://drive.google.com/drive/folders/XYZ");
  });
});

describe("Drive REST client", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const jsonRes = (body: unknown, ok = true, status = 200) => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  it("findFileInFolder scopes the query to the folder and supports all drives", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ files: [{ id: "f1", name: "Doc.pdf", md5Checksum: "abc" }] }));
    const file = await findFileInFolder("FOLDER", "Doc.pdf");

    expect(file).toEqual({ id: "f1", name: "Doc.pdf", md5Checksum: "abc" });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
    const q = url.searchParams.get("q") ?? "";
    expect(q).toContain("'FOLDER' in parents");
    expect(q).toContain("name = 'Doc.pdf'");
    expect(q).toContain("trashed = false");
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test-access-token",
    });
  });

  it("findFileInFolder escapes single quotes in the name", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ files: [] }));
    await findFileInFolder("FOLDER", "O'Brien Deal.pdf");
    const q = new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("q") ?? "";
    expect(q).toContain("name = 'O\\'Brien Deal.pdf'");
  });

  it("findFileInFolder returns null when nothing matches", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ files: [] }));
    expect(await findFileInFolder("FOLDER", "Missing.pdf")).toBeNull();
  });

  it("createFolder posts folder metadata under the parent", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ id: "newfolder", name: "Acme (Deal Files)" }));
    const folder = await createFolder("Acme (Deal Files)", "SHARED_DRIVE");

    expect(folder.id).toBe("newfolder");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      name: "Acme (Deal Files)",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["SHARED_DRIVE"],
    });
  });

  it("uploadFile sends a multipart body containing the bytes and returns the file", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ id: "uploaded", name: "X.pdf", md5Checksum: "deadbeef" }));
    const bytes = Buffer.from("%PDF-1.7 hello");
    const file = await uploadFile("FOLDER", "X.pdf", bytes);

    expect(file).toMatchObject({ id: "uploaded", md5Checksum: "deadbeef" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/upload/drive/v3/files");
    expect(url).toContain("uploadType=multipart");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Content-Type"]).toMatch(/^multipart\/related; boundary=/);
    const sentBody = init.body as Buffer;
    expect(Buffer.isBuffer(sentBody)).toBe(true);
    expect(sentBody.includes(bytes)).toBe(true); // raw bytes embedded
    expect(sentBody.toString().includes('"parents":["FOLDER"]')).toBe(true);
  });

  it("throws with detail on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "nope" }, false, 403));
    await expect(findFileInFolder("FOLDER", "X.pdf")).rejects.toThrow(/Google Drive list failed: 403/);
  });
});
