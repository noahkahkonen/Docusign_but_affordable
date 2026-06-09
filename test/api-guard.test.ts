import { describe, it, expect, afterAll, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * HTTP-level tests for the sender/admin API-key guard — the only thing between the public
 * internet and creating/reading/downloading signature requests. We set BACKEND_API_KEY before
 * importing the app so the guard is active.
 */

process.env.BACKEND_API_KEY = "test-secret-key";

let app: FastifyInstance;

beforeAll(async () => {
  const { buildApp } = await import("../src/app.js");
  app = (await buildApp()) as unknown as FastifyInstance;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  delete process.env.BACKEND_API_KEY; // don't leak into other test files
});

describe("sender API key guard", () => {
  it("rejects requests with no api key (401)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/requests", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
  });

  it("rejects a wrong api key (401)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { "x-api-key": "wrong" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a multi-valued api-key header (401)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/requests/00000000-0000-0000-0000-000000000000",
      headers: { "x-api-key": ["test-secret-key", "test-secret-key"] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("passes the guard with the correct key (no longer 401)", async () => {
    // With a valid key the request proceeds past the guard; the body then fails zod validation
    // (400) — the point is it is NOT 401.
    const res = await app.inject({
      method: "POST",
      url: "/api/requests",
      headers: { "x-api-key": "test-secret-key" },
      payload: {},
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(400);
  });
});
