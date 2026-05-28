import { defineConfig } from "vitest/config";

// The CLI tests spawn the built CLI as a child process (roundtrip, rename, t03).
// These are <2s in isolation but can exceed vitest's 5s default under the CPU
// contention of a full `pnpm -r test` run. Raise the per-test timeout so a cold
// subprocess start is not mistaken for a hang.
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
