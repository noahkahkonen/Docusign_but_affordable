import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    // DB-backed integration tests share one Postgres and reset tables in beforeAll; run files
    // sequentially so they don't race each other.
    fileParallelism: false,
  },
});
