import { describe, it, expect, afterAll, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { sha256 } from "../src/lib/hash.js";
import { isSalesforceId } from "../src/salesforce/files.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = (await buildApp()) as unknown as FastifyInstance;
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("health", () => {
  it("liveness returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("salesforce routes without credentials", () => {
  it("returns 503 when Salesforce is not configured", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/salesforce/status",
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("salesforce_not_configured");
  });

});

describe("salesforce id validation", () => {
  it("accepts 15 and 18 char ids and rejects junk", () => {
    expect(isSalesforceId("003Pe000019Y0MW")).toBe(true); // 15
    expect(isSalesforceId("003Pe000019Y0MWIA0")).toBe(true); // 18
    expect(isSalesforceId("abc")).toBe(false);
    expect(isSalesforceId("'; DROP TABLE--")).toBe(false);
  });
});

describe("hashing", () => {
  it("produces a stable SHA-256 hex digest", () => {
    expect(sha256(Buffer.from("inkpath"))).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256(Buffer.from("a"))).toBe(
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    );
  });
});
