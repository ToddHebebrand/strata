// Gate 3 (unkeyed noninferiority), Task 8: the CI-bounded MEDIUM acceptance
// suite. Runs the real cold + warm balanced schedules on `examples/medium` at
// the pre-registered `N_MEDIUM`/seeds (src/gate3/config.ts — fixed from the
// Task-8 pilot, never tuned to force a verdict), builds a medium-only
// `Gate3Report`, and PINS THE RECORDED VERDICT:
//
//   medium.cold.state === "FAIL" AND medium.warm.state === "FAIL"
//   AND lifecycle 4/4 (both children's real traces are the canonical order)
//   AND both arms' peak RSS captured > 0.
//
// ---------------------------------------------------------------------------
// THIS IS NOT A WEAKENED GATE. Read decisions.md, entry "2026-07-22 — Gate 3
// medium acceptance: confident noninferiority FAIL" (committed 7b6975b), and
// the plan addendum (docs/superpowers/plans/2026-07-20-iteration6-slice-a-
// gate3.md, "Addendum (2026-07-22)").
//
// The medium corpus produced a *confident* noninferiority FAIL: the kernel arm
// pays a fixed ~2 s per-mutation cross-process bridge-worker spawn/IPC cost
// that a 22-module tsc (~0.3 s) cannot amortize (cold ratio 3.99 / lcb95 3.917;
// warm ratio 4.78 / lcb95 4.78 — reproduced 3×, mechanism corroborated against
// the gate-2 observability artifact). The 1.25x threshold, the timed windows,
// N, the seeds, and the paired bootstrap are ALL UNCHANGED from the pilot.
// What changed, by operator decision, is that this suite now PINS the recorded
// finding rather than asserting not-FAIL: it exists so a silent machinery
// regression that flips the medium verdict to PASS/INCONCLUSIVE (e.g. a broken
// window, a mis-seeded schedule, a bootstrap bug) is CAUGHT as a regression,
// not celebrated as a win. A verdict flip here means the harness changed under
// us — investigate the machinery, do not "fix" the assertion. No retries, no
// tolerance widening.
//
// The memory field of the medium-only report is a documented non-dispositive
// placeholder: the baseline-adjusted growth predicate needs big1k, which only
// the operator run produces. This suite asserts only that raw peak RSS was
// captured (> 0) for both arms; the real memory verdict lives in run-big.ts.
// ---------------------------------------------------------------------------
import { describe, expect, it, beforeAll } from "vitest";
import {
  N_MEDIUM,
  WARM_HORIZON,
  GROWTH_FACTOR,
  GATE3_MEDIUM_COLD_SEED,
  GATE3_MEDIUM_WARM_SEED,
  GATE3_BOOTSTRAP_SEED,
  KERNEL_1K_RSS_CAP,
  SQLITE_1K_RSS_CAP,
  COLD_KERNEL_TIMEOUT_MS,
  COLD_SQLITE_TIMEOUT_MS,
  WARM_STEP_TIMEOUT_MS
} from "../src/gate3/config.js";
import { runCold, runWarm, type RunnerCorpus } from "../src/gate3/runners.js";
import { ratioVerdict, lifecycleParity, memoryVerdict, type MemoryCaps } from "../src/gate3/stats.js";
import { buildGate3CorpusReport, buildGate3Report } from "../src/gate3/report.js";
import type { Provenance } from "../src/gate3/provenance.js";
import type { SchedulePair } from "../src/gate3/schedule.js";
import { ensureBuilt } from "./serviceHarness.js";
import { RENAME_TARGET, mediumRoot, kernelChildEntry, sqliteChildEntry, runChild } from "./gate3ChildHarness.js";

const CORPUS: RunnerCorpus = { corpusRoot: mediumRoot, corpus: "medium", target: RENAME_TARGET };
const CAPS: MemoryCaps = { kernel: KERNEL_1K_RSS_CAP, sqlite: SQLITE_1K_RSS_CAP };

const pairWalls = (pairs: SchedulePair[]) => pairs.map((p) => ({ kernel: p.kernel.callerWallNs, sqlite: p.sqlite.callerWallNs }));
const maxRss = (pairs: SchedulePair[], arm: "kernel" | "sqlite") => Math.max(...pairs.map((p) => p[arm].childMaxRssBytes));

describe("gate3 noninferiority — medium acceptance", () => {
  beforeAll(async () => {
    ensureBuilt();
  }, 600_000);

  it(
    "medium cold+warm at pre-registered N/seed: pins recorded FAIL (cold FAIL, warm FAIL), lifecycle 4/4, RSS captured",
    async () => {
      // --- Real cold + warm balanced schedules on medium ---------------------
      const cold = await runCold(CORPUS, {
        n: N_MEDIUM,
        seed: GATE3_MEDIUM_COLD_SEED,
        timeoutMs: { kernel: COLD_KERNEL_TIMEOUT_MS, sqlite: COLD_SQLITE_TIMEOUT_MS }
      });
      const warm = await runWarm(CORPUS, {
        n: N_MEDIUM,
        seed: GATE3_MEDIUM_WARM_SEED,
        warmHorizon: WARM_HORIZON,
        timeoutMs: WARM_STEP_TIMEOUT_MS
      });

      const coldVerdict = ratioVerdict(pairWalls(cold.pairs), GATE3_BOOTSTRAP_SEED);
      const warmVerdict = ratioVerdict(pairWalls(warm.pairs), GATE3_BOOTSTRAP_SEED);

      // --- Real lifecycle traces from one cold child per arm -----------------
      const [sqliteResult] = await runChild(
        sqliteChildEntry,
        { corpusRoot: mediumRoot, target: RENAME_TARGET, mode: "cold", iterations: 1 },
        COLD_SQLITE_TIMEOUT_MS
      );
      const [kernelResult] = await runChild(
        kernelChildEntry,
        { corpusRoot: mediumRoot, target: RENAME_TARGET, mode: "cold", iterations: 1 },
        COLD_KERNEL_TIMEOUT_MS
      );
      const lifecycle = lifecycleParity(kernelResult!.lifecycle, sqliteResult!.lifecycle);

      // --- Peak RSS per arm (raw high-water from the real samples) -----------
      const kernelRss = maxRss(cold.pairs, "kernel");
      const sqliteRss = maxRss(cold.pairs, "sqlite");

      // Medium-only memory verdict: NON-DISPOSITIVE placeholder. The real
      // baseline-adjusted growth predicate needs big1k (operator run) — here
      // big1k is unavailable, so it is set equal to the real medium peak RSS
      // and baseline to half of it purely to satisfy the report shape without
      // fabricating a growth signal (growthAdjusted resolves to 1 <= factor).
      const kernelMem = memoryVerdict(
        "kernel",
        { baseline: Math.floor(kernelRss / 2), medium: kernelRss, big1k: kernelRss },
        CAPS,
        GROWTH_FACTOR
      );
      const sqliteMem = memoryVerdict(
        "sqlite",
        { baseline: Math.floor(sqliteRss / 2), medium: sqliteRss, big1k: sqliteRss },
        CAPS,
        GROWTH_FACTOR
      );

      // --- Build the medium-only Gate3Report --------------------------------
      const provenance: Provenance = {
        headSha: "acceptance-suite",
        dirty: true,
        harnessDigest: "acceptance-suite",
        daemonBinarySha: "acceptance-suite",
        os: process.platform,
        cpu: "acceptance-suite",
        nodeVersion: process.version,
        rustVersion: "acceptance-suite",
        scheduleSeed: GATE3_MEDIUM_COLD_SEED
      };
      const mediumReport = buildGate3CorpusReport({
        cold: coldVerdict,
        warm: warmVerdict,
        warmTrend: warm.trend,
        memory: { kernel: kernelMem, sqlite: sqliteMem },
        lifecycle: { kernel: lifecycle.kernel, sqlite: lifecycle.sqlite },
        coldPairs: cold.pairs,
        warmPairs: warm.pairs
      });
      const report = buildGate3Report(provenance, { medium: mediumReport });

      // --- Pin the RECORDED verdict (decisions.md 2026-07-22; never weakened) --
      // The medium corpus is a confident noninferiority FAIL. We assert the
      // machinery still REPRODUCES that recorded FAIL: a flip to PASS/
      // INCONCLUSIVE means the harness changed under us and must be
      // investigated, not that the kernel got faster on a 22-module corpus.
      expect(report.medium.cold.state, `cold verdict flipped off the recorded FAIL: ${JSON.stringify(coldVerdict)}`).toBe("FAIL");
      expect(report.medium.warm.state, `warm verdict flipped off the recorded FAIL: ${JSON.stringify(warmVerdict)}`).toBe("FAIL");

      // Lifecycle 4/4: both children's real traces are the canonical sequences.
      expect(lifecycle.equal).toBe(true);
      expect(report.medium.lifecycle).toEqual({ kernel: 4, sqlite: 4 });

      // Both arms' peak RSS actually captured (> 0).
      expect(kernelRss).toBeGreaterThan(0);
      expect(sqliteRss).toBeGreaterThan(0);
      expect(maxRss(warm.pairs, "kernel")).toBeGreaterThan(0);
      expect(maxRss(warm.pairs, "sqlite")).toBeGreaterThan(0);
    },
    600_000
  );
});
