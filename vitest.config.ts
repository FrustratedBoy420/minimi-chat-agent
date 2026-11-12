import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Each test file gets its own throwaway database directory and no real API keys.
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30_000,
    // PGlite starts a WASM Postgres per test file; under parallel load that can exceed the 10 s default.
    hookTimeout: 60_000,
    // Each test file runs its own in-process Postgres (PGlite/WASM). Capping parallel workers keeps memory
    // bounded; an uncapped run on a low-memory machine produced spurious timeouts.
    maxWorkers: 4,
  },
});
