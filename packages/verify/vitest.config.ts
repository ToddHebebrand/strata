import { defineConfig } from "vitest/config";

// Several verify tests spawn real `tsc`/`vitest` subprocesses (behavioralGate,
// corpusRun) or build full TypeChecker programs over the example corpus
// (materializeReingestEquivalence). Each is comfortably <3s in isolation but
// exceeds vitest's 5s default when the suite runs them concurrently and they
// contend for CPU. Raise the per-test timeout so genuine work is not flagged as
// a hang under load.
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
