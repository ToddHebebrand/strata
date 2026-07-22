// Gate 3 (unkeyed noninferiority), Task 3: balanced paired scheduler
// acceptance on real children. Drives `runBalancedSchedule` over
// `examples/medium` with `runPair` implemented by spawning FRESH sqlite-
// and kernel-child processes per arm per pair (cold-style, matching
// gate3Child.test.ts's spawn/drive pattern via the shared harness) —
// Task 4 builds the real cold/warm drivers reusing this scheduler; here we
// only need to prove the scheduler itself (pairing, seeded AB/BA ordering,
// sample tagging) against real, non-fabricated wall times.
import { beforeAll, describe, expect, it } from "vitest";
import { runBalancedSchedule, type ArmSampleInput, type PairOrder } from "../src/gate3/schedule.js";
import { ensureBuilt } from "./serviceHarness.js";
import {
  RENAME_TARGET,
  kernelChildEntry,
  mediumRoot,
  runChild,
  sqliteChildEntry
} from "./gate3ChildHarness.js";

const COLD_REQUEST = { corpusRoot: mediumRoot, target: RENAME_TARGET, mode: "cold" as const, iterations: 1 };

/** Runs one pair by spawning a fresh sqlite-child and a fresh kernel-child (cold mode, one mutation each), sequenced per `order` ("AB" = kernel first, "BA" = sqlite first — kernel is always "A", sqlite always "B"). */
async function runPairViaFreshChildren(
  order: PairOrder
): Promise<{ kernel: ArmSampleInput; sqlite: ArmSampleInput }> {
  const runKernel = async (): Promise<ArmSampleInput> => {
    const [result] = await runChild(kernelChildEntry, COLD_REQUEST, 180_000);
    return {
      arm: "kernel",
      corpus: "medium",
      mode: "cold",
      callerWallNs: result!.callerWallNs,
      childMaxRssBytes: result!.childMaxRssBytes,
      published: true
    };
  };
  const runSqlite = async (): Promise<ArmSampleInput> => {
    const [result] = await runChild(sqliteChildEntry, COLD_REQUEST, 60_000);
    return {
      arm: "sqlite",
      corpus: "medium",
      mode: "cold",
      callerWallNs: result!.callerWallNs,
      childMaxRssBytes: result!.childMaxRssBytes,
      published: true
    };
  };

  if (order === "AB") {
    const kernel = await runKernel();
    const sqlite = await runSqlite();
    return { kernel, sqlite };
  }
  const sqlite = await runSqlite();
  const kernel = await runKernel();
  return { kernel, sqlite };
}

describe("gate3Schedule", () => {
  beforeAll(async () => {
    ensureBuilt();
  }, 600_000);

  it(
    "runs 4 balanced paired mutations on medium with real, tagged, non-fabricated samples",
    async () => {
      const seed = 20260722;
      const { pairs, samples } = await runBalancedSchedule({
        corpus: "medium",
        mode: "cold",
        n: 4,
        seed,
        runPair: runPairViaFreshChildren
      });

      expect(pairs).toHaveLength(4);
      expect(samples).toHaveLength(8);

      const orders = new Set(pairs.map((pair) => pair.order));
      // This seed is asserted (not merely hoped) to realize both orders —
      // if seededRng's mulberry32 stream or the </ 0.5 cut ever changes,
      // this is the tripwire that catches it.
      expect(orders.has("AB")).toBe(true);
      expect(orders.has("BA")).toBe(true);

      pairs.forEach((pair, index) => {
        expect(pair.pairId).toBe(index);
        expect(pair.kernel.pairId).toBe(index);
        expect(pair.kernel.order).toBe(pair.order);
        expect(pair.kernel.iteration).toBe(index);
        expect(pair.kernel.arm).toBe("kernel");
        expect(pair.kernel.corpus).toBe("medium");
        expect(pair.kernel.mode).toBe("cold");
        expect(pair.kernel.callerWallNs).toBeGreaterThan(0);
        expect(pair.kernel.childMaxRssBytes).toBeGreaterThan(1_000_000);
        expect(pair.kernel.published).toBe(true);

        expect(pair.sqlite.pairId).toBe(index);
        expect(pair.sqlite.order).toBe(pair.order);
        expect(pair.sqlite.iteration).toBe(index);
        expect(pair.sqlite.arm).toBe("sqlite");
        expect(pair.sqlite.corpus).toBe("medium");
        expect(pair.sqlite.mode).toBe("cold");
        expect(pair.sqlite.callerWallNs).toBeGreaterThan(0);
        expect(pair.sqlite.childMaxRssBytes).toBeGreaterThan(1_000_000);
        expect(pair.sqlite.published).toBe(true);
      });

      // Every sample in the flattened list also carries the tags, and the
      // pair-then-arm ordering is exactly kernel,sqlite per pair.
      for (const sample of samples) {
        expect(sample.callerWallNs).toBeGreaterThan(0);
        expect(sample.published).toBe(true);
      }
      expect(samples.map((sample) => sample.arm)).toEqual(["kernel", "sqlite", "kernel", "sqlite", "kernel", "sqlite", "kernel", "sqlite"]);

      // Re-running with the same seed reproduces the identical order sequence.
      const orderSequence = pairs.map((pair) => pair.order);
      const rerun = await runBalancedSchedule({
        corpus: "medium",
        mode: "cold",
        n: 4,
        seed,
        runPair: async (order) => ({
          kernel: { arm: "kernel", corpus: "medium", mode: "cold", callerWallNs: 1, childMaxRssBytes: 1, published: true },
          sqlite: { arm: "sqlite", corpus: "medium", mode: "cold", callerWallNs: 1, childMaxRssBytes: 1, published: true }
        })
      });
      expect(rerun.pairs.map((pair) => pair.order)).toEqual(orderSequence);
    },
    300_000
  );

  it("rejects n < 1", async () => {
    await expect(
      runBalancedSchedule({
        corpus: "medium",
        mode: "cold",
        n: 0,
        seed: 1,
        runPair: async () => {
          throw new Error("should not be called");
        }
      })
    ).rejects.toThrow();
  });

  it("throws if runPair reports arm labels swapped", async () => {
    await expect(
      runBalancedSchedule({
        corpus: "medium",
        mode: "cold",
        n: 1,
        seed: 1,
        runPair: async () => ({
          kernel: { arm: "sqlite", corpus: "medium", mode: "cold", callerWallNs: 1, childMaxRssBytes: 1, published: true },
          sqlite: { arm: "sqlite", corpus: "medium", mode: "cold", callerWallNs: 1, childMaxRssBytes: 1, published: true }
        })
      })
    ).rejects.toThrow(/arm/);
  });
});
