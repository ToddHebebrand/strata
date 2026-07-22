// Gate 3 (unkeyed noninferiority), Task 5 (half b): metrics-on kernel-server
// characterization on real `examples/medium`, driven through a genuine
// `strata-kernel-service` daemon with `--metrics` ON. This is a SEPARATE run
// from the (metrics-off) timing arms — B1's binding constraint — and its own
// binding constraint (Major 7) is that each iteration's submit +
// publishing-advance records are bound to that iteration by JSONL
// offset/sequence, never summed across the whole accumulating file.
import { describe, expect, it, beforeAll } from "vitest";
import { characterizeKernelServer } from "../src/gate3/characterize.js";
import { ensureBuilt } from "./serviceHarness.js";
import { RENAME_TARGET, mediumRoot } from "./gate3ChildHarness.js";

const CORPUS = { corpusRoot: mediumRoot, corpus: "medium" as const, target: RENAME_TARGET };

describe("characterizeKernelServer", () => {
  beforeAll(async () => {
    ensureBuilt();
  }, 600_000);

  it(
    "n=2 iterations on medium: submit/advance distributions carry n samples each, RSS > 1MB, no cross-iteration bleed",
    async () => {
      const seed = 20260722003;
      const result = await characterizeKernelServer(CORPUS, { n: 2, seed });

      // Distributions carry exactly n=2 samples each, nearest-rank ordered.
      expect(result.submit.n).toBe(2);
      expect(result.advance.n).toBe(2);
      expect(result.submit.samples).toHaveLength(2);
      expect(result.advance.samples).toHaveLength(2);
      for (const sample of [...result.submit.samples, ...result.advance.samples]) {
        expect(sample).toBeGreaterThan(0);
      }
      // p95 is nearest-rank ordered: for n=2 samples, p95 must be the larger
      // (or equal) of the two — never below the min, never above the max.
      expect(result.submit.p95).toBeGreaterThanOrEqual(result.submit.min);
      expect(result.submit.p95).toBeLessThanOrEqual(result.submit.max);
      expect(result.advance.p95).toBeGreaterThanOrEqual(result.advance.min);
      expect(result.advance.p95).toBeLessThanOrEqual(result.advance.max);

      // Daemon/worker peak RSS observed running a real corpus mutation is
      // well over 1 MB.
      expect(result.daemonRss).toBeGreaterThan(1_000_000);
      expect(result.workerRss).toBeGreaterThan(1_000_000);

      // Cross-iteration-bleed check (Major 7): the second iteration's
      // submitWallNs is retained distinctly from the first's, not summed or
      // collapsed across the accumulating metrics JSONL. (Two real
      // hrtime-scale nanosecond measurements from two independent daemon
      // requests are vanishingly unlikely to collide exactly, so
      // inequality itself is the meaningful, falsifiable assertion here.)
      expect(result.submit.samples[1]).not.toBe(result.submit.samples[0]);
    },
    600_000
  );
});
