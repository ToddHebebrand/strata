// Gate 3 (unkeyed noninferiority), Task 4: cold + warm run driver
// acceptance on real, compiled children over `examples/medium`.
//
// Cold: proves each pair spawns a genuinely FRESH child per arm (distinct
// PIDs). Warm: proves exactly ONE persistent child per arm is reused across
// all iterations (one PID each), that per-iteration childMaxRssBytes is a
// non-decreasing high-water mark within each persistent process, and that
// `trend` (first-half vs last-half p95 kernel/sqlite ratio) is computed.
import { describe, expect, it, beforeAll } from "vitest";
import { runCold, runWarm } from "../src/gate3/runners.js";
import { ensureBuilt } from "./serviceHarness.js";
import { RENAME_TARGET, mediumRoot } from "./gate3ChildHarness.js";

const CORPUS = { corpusRoot: mediumRoot, corpus: "medium" as const, target: RENAME_TARGET };

describe("gate3Runners", () => {
  beforeAll(async () => {
    ensureBuilt();
  }, 600_000);

  it(
    "runCold: n=3 pairs, each arm a fresh child process (3 distinct kernel PIDs, 3 distinct sqlite PIDs)",
    async () => {
      const seed = 20260722001;
      const { pairs, samples } = await runCold(CORPUS, { n: 3, seed });

      expect(pairs).toHaveLength(3);
      expect(samples).toHaveLength(6);

      for (const pair of pairs) {
        expect(pair.kernel.mode).toBe("cold");
        expect(pair.sqlite.mode).toBe("cold");
        expect(pair.kernel.callerWallNs).toBeGreaterThan(0);
        expect(pair.sqlite.callerWallNs).toBeGreaterThan(0);
        expect(pair.kernel.childMaxRssBytes).toBeGreaterThan(1_000_000);
        expect(pair.sqlite.childMaxRssBytes).toBeGreaterThan(1_000_000);
        expect(typeof pair.kernel.childPid).toBe("number");
        expect(typeof pair.sqlite.childPid).toBe("number");
      }

      const kernelPids = new Set(pairs.map((pair) => pair.kernel.childPid));
      const sqlitePids = new Set(pairs.map((pair) => pair.sqlite.childPid));
      expect(kernelPids.size).toBe(3);
      expect(sqlitePids.size).toBe(3);
    },
    600_000
  );

  it(
    "runWarm: n=4 iterations, ONE persistent kernel child + ONE persistent sqlite child, trend present, RSS non-decreasing",
    async () => {
      const seed = 20260722002;
      const { pairs, samples, trend } = await runWarm(CORPUS, { n: 4, seed, warmHorizon: 8 });

      expect(pairs).toHaveLength(4);
      expect(samples).toHaveLength(8);

      for (const pair of pairs) {
        expect(pair.kernel.mode).toBe("warm");
        expect(pair.sqlite.mode).toBe("warm");
        expect(pair.kernel.callerWallNs).toBeGreaterThan(0);
        expect(pair.sqlite.callerWallNs).toBeGreaterThan(0);
      }

      // Persistent: one child per arm reused across all 4 iterations.
      const kernelPids = new Set(pairs.map((pair) => pair.kernel.childPid));
      const sqlitePids = new Set(pairs.map((pair) => pair.sqlite.childPid));
      expect(kernelPids.size).toBe(1);
      expect(sqlitePids.size).toBe(1);

      // Trend present, both halves computed as finite ratios.
      expect(trend).toBeDefined();
      expect(Number.isFinite(trend.firstHalfP95Ratio)).toBe(true);
      expect(Number.isFinite(trend.lastHalfP95Ratio)).toBe(true);
      expect(trend.firstHalfP95Ratio).toBeGreaterThan(0);
      expect(trend.lastHalfP95Ratio).toBeGreaterThan(0);

      // Per-iteration RSS high-water is non-decreasing within each
      // persistent process (maxRSS is a high-water mark by definition).
      const kernelRss = pairs.map((pair) => pair.kernel.childMaxRssBytes);
      const sqliteRss = pairs.map((pair) => pair.sqlite.childMaxRssBytes);
      for (let i = 1; i < kernelRss.length; i += 1) {
        expect(kernelRss[i]).toBeGreaterThanOrEqual(kernelRss[i - 1]!);
      }
      for (let i = 1; i < sqliteRss.length; i += 1) {
        expect(sqliteRss[i]).toBeGreaterThanOrEqual(sqliteRss[i - 1]!);
      }

      // The flattened samples list also carries iteration order kernel,sqlite per pair.
      expect(samples.map((sample) => sample.arm)).toEqual([
        "kernel",
        "sqlite",
        "kernel",
        "sqlite",
        "kernel",
        "sqlite",
        "kernel",
        "sqlite"
      ]);
    },
    600_000
  );

  it("runWarm rejects n > warmHorizon", async () => {
    await expect(runWarm(CORPUS, { n: 3, seed: 1, warmHorizon: 2 })).rejects.toThrow(/warmHorizon/);
  });

  it("runWarm rejects n < 2", async () => {
    await expect(runWarm(CORPUS, { n: 1, seed: 1, warmHorizon: 8 })).rejects.toThrow();
  });
});
