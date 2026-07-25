// Bridge-persistence slice, Task 11: the exit-gate committed-artifact CI
// check — the exit-gate parallel of gate3Artifact.ci.test.ts, pointed at
// `docs/spikes/bridge-persistence-exit-gate.{json,head}` (the recorded
// gate-3 artifact and its test stay untouched).
//
// Validates: (1) the full gate-3 report schema PLUS the nested `exitGate`
// provenance block (release binary profile, persistentBridge, the
// pre-registered A3 constants matching the memory-guard exports); (2) the
// headSha marker binding; (3) verdict integrity — recomputing `ratioVerdict`
// from the artifact's own raw pairs (GATE3_BOOTSTRAP_SEED) must reproduce
// the recorded cold/warm states and bounds on both corpora.
//
// GRACEFUL SKIP: while the artifact does not yet exist (Task 11 Step 3's
// operator exit-gate run produces it), this suite SKIPS with a clear message
// rather than failing — the chain stays green until then.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ratioVerdict } from "../src/gate3/stats.js";
import { GATE3_BOOTSTRAP_SEED } from "../src/gate3/config.js";
import {
  LEAK_FACTOR,
  MEDIUM_LEAK_ITERATIONS,
  PERSISTENT_1K_RSS_CAP,
  QUIESCENCE_MS
} from "../src/persistence/memory-guard.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const spikesDir = resolve(repoRoot, "docs", "spikes");
const ARTIFACT_JSON = resolve(spikesDir, "bridge-persistence-exit-gate.json");
const ARTIFACT_HEAD = resolve(spikesDir, "bridge-persistence-exit-gate.head");
const ARTIFACT_EXISTS = existsSync(ARTIFACT_JSON);

const triState = z.enum(["PASS", "FAIL", "INCONCLUSIVE"]);

const ratioVerdictSchema = z.object({
  p95Kernel: z.number(),
  p95Sqlite: z.number(),
  pointRatio: z.number(),
  ucb95: z.number(),
  lcb95: z.number(),
  state: triState
});

const memoryVerdictSchema = z.object({
  arm: z.enum(["kernel", "sqlite"]),
  medium: z.number(),
  big1k: z.number(),
  baseline: z.number(),
  absoluteCapPass: z.boolean(),
  growthAdjusted: z.number(),
  growthPass: z.boolean(),
  state: triState
});

const sampleSchema = z.object({
  arm: z.enum(["kernel", "sqlite"]),
  corpus: z.enum(["medium", "big1k", "baseline"]),
  mode: z.enum(["cold", "warm"]),
  callerWallNs: z.number().nonnegative(),
  childMaxRssBytes: z.number().nonnegative(),
  order: z.enum(["AB", "BA"])
});
const schedulePairSchema = z.object({ order: z.enum(["AB", "BA"]), kernel: sampleSchema, sqlite: sampleSchema });

const scheduleProvenanceSchema = z.object({
  seed: z.number(),
  n: z.number().int().positive(),
  realizedOrder: z.array(z.enum(["AB", "BA"]))
});

const corpusReportSchema = z.object({
  cold: ratioVerdictSchema,
  warm: ratioVerdictSchema,
  warmTrend: z.object({ firstHalfP95Ratio: z.number(), lastHalfP95Ratio: z.number() }),
  memory: z.object({ kernel: memoryVerdictSchema, sqlite: memoryVerdictSchema }),
  lifecycle: z.object({ kernel: z.number(), sqlite: z.number() }),
  coldPairs: z.array(schedulePairSchema).min(1),
  warmPairs: z.array(schedulePairSchema).min(1),
  corpusInfo: z.object({ digest: z.string(), moduleCount: z.number().int(), copies: z.number().int() }),
  schedules: z.object({
    cold: scheduleProvenanceSchema,
    warm: scheduleProvenanceSchema,
    baseline: scheduleProvenanceSchema.optional()
  })
});

const provenanceSchema = z.object({
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  dirty: z.boolean(),
  harnessDigest: z.string(),
  daemonBinarySha: z.string(),
  os: z.string(),
  cpu: z.string(),
  nodeVersion: z.string(),
  rustVersion: z.string(),
  scheduleSeed: z.number().optional(),
  timestamp: z.string().optional(),
  metricsMode: z.string()
});

// The Task 9 true-process sampler's retained sample point.
const rssSamplePointSchema = z.object({
  label: z.string(),
  phase: z.enum(["post-publish", "quiescence"]),
  atMs: z.number(),
  daemonRss: z.number().positive(),
  workerRss: z.number().positive(),
  combined: z.number().positive()
});

// The nested exit-gate provenance block (run-big.ts `ExitGateProvenanceBlock`).
const exitGateSchema = z.object({
  mode: z.literal("persistence"),
  // A2: the exit-gate kernel binary is pinned to release (disclosed).
  binaryProfile: z.literal("release"),
  kernelServiceBin: z.string().min(1),
  persistentBridge: z.literal(true),
  memoizationEnabled: z.literal(true),
  characterizationPersistentBridge: z.literal(false),
  argv: z.array(z.string()).min(2),
  constants: z.object({
    leakFactor: z.number(),
    persistent1kRssCapBytes: z.number(),
    mediumLeakIterations: z.number().int(),
    quiescenceMs: z.number().int()
  }),
  memory: z.object({
    medium: z.object({
      state: triState,
      continuityHeld: z.boolean(),
      inconclusiveReason: z.string().optional(),
      highWaterBytes: z.array(z.number().positive()),
      samples: z.array(rssSamplePointSchema),
      daemonPid: z.number().int().positive(),
      workerPid: z.number().int().positive(),
      leakVerdict: z
        .object({
          leakPass: z.boolean(),
          state: z.enum(["pass", "fail"]),
          baselineHighWaterBytes: z.number(),
          tailHighWaterBytes: z.number(),
          leakLimitBytes: z.number()
        })
        .optional()
    }),
    big1k: z.object({
      state: triState,
      continuityHeld: z.boolean(),
      inconclusiveReason: z.string().optional(),
      combinedBytes: z.array(z.number().positive()),
      samples: z.array(rssSamplePointSchema),
      pids: z.object({ daemon: z.number().int().positive(), worker: z.number().int().positive() }).optional(),
      peakBytes: z.number().positive().optional(),
      capPass: z.boolean().optional(),
      capBytes: z.number().positive()
    })
  })
});

const exitGateReportSchema = z.object({
  provenance: provenanceSchema,
  medium: corpusReportSchema,
  big1k: corpusReportSchema, // the exit artifact is a full both-corpora run.
  verdict: triState,
  exitGate: exitGateSchema
});

describe("bridge-persistence exit-gate committed-artifact CI check", () => {
  it.runIf(!ARTIFACT_EXISTS)("artifact not yet generated — SKIPPING (Task 11 Step 3 operator exit-gate run produces it)", () => {
    // eslint-disable-next-line no-console
    console.warn(
      `[persistenceExitArtifact.ci] ${ARTIFACT_JSON} does not exist yet — the Task 11 Step 3 operator ` +
        `exit-gate run produces it. Skipping schema + headSha-marker validation so the chain stays green until then.`
    );
    expect(ARTIFACT_EXISTS).toBe(false);
  });

  it.skipIf(!ARTIFACT_EXISTS)("validates schema + exitGate provenance block (release binary, persistent bridge, A3 constants), headSha matches marker", () => {
    const report = exitGateReportSchema.parse(JSON.parse(readFileSync(ARTIFACT_JSON, "utf8")));

    // Raw pairs actually present on both corpora.
    expect(report.medium.coldPairs.length).toBeGreaterThan(0);
    expect(report.medium.warmPairs.length).toBeGreaterThan(0);
    expect(report.big1k.coldPairs.length).toBeGreaterThan(0);
    expect(report.big1k.warmPairs.length).toBeGreaterThan(0);
    expect(report.medium.schedules.cold.n).toBe(report.medium.coldPairs.length);
    expect(report.big1k.schedules.warm.n).toBe(report.big1k.warmPairs.length);

    // The A3 constants recorded on the artifact are the pre-registered
    // memory-guard exports — a drifted constant means the artifact was not
    // produced by (or no longer matches) this tree's predicate.
    expect(report.exitGate.constants.leakFactor).toBe(LEAK_FACTOR);
    expect(report.exitGate.constants.persistent1kRssCapBytes).toBe(PERSISTENT_1K_RSS_CAP);
    expect(report.exitGate.constants.mediumLeakIterations).toBe(MEDIUM_LEAK_ITERATIONS);
    expect(report.exitGate.constants.quiescenceMs).toBe(QUIESCENCE_MS);

    // The kernel arm really ran the pinned release binary (A2 disclosure).
    expect(report.exitGate.kernelServiceBin).toMatch(/release/);

    // headSha marker binding (parallel marker convention: <base>.head).
    expect(existsSync(ARTIFACT_HEAD)).toBe(true);
    const marker = readFileSync(ARTIFACT_HEAD, "utf8").trim();
    expect(marker).toMatch(/^[0-9a-f]{40}$/);
    expect(report.provenance.headSha).toBe(marker);
  });

  it.skipIf(!ARTIFACT_EXISTS)(
    "recomputing ratioVerdict from the artifact's own coldPairs/warmPairs (GATE3_BOOTSTRAP_SEED) reproduces the recorded cold/warm states on both corpora",
    () => {
      const report = exitGateReportSchema.parse(JSON.parse(readFileSync(ARTIFACT_JSON, "utf8")));
      const walls = (pairs: readonly z.infer<typeof schedulePairSchema>[]) =>
        pairs.map((pair) => ({ kernel: pair.kernel.callerWallNs, sqlite: pair.sqlite.callerWallNs }));

      const mediumCold = ratioVerdict(walls(report.medium.coldPairs), GATE3_BOOTSTRAP_SEED);
      const mediumWarm = ratioVerdict(walls(report.medium.warmPairs), GATE3_BOOTSTRAP_SEED);
      const big1kCold = ratioVerdict(walls(report.big1k.coldPairs), GATE3_BOOTSTRAP_SEED);
      const big1kWarm = ratioVerdict(walls(report.big1k.warmPairs), GATE3_BOOTSTRAP_SEED);

      expect(mediumCold.state).toBe(report.medium.cold.state);
      expect(mediumWarm.state).toBe(report.medium.warm.state);
      expect(big1kCold.state).toBe(report.big1k.cold.state);
      expect(big1kWarm.state).toBe(report.big1k.warm.state);

      expect(mediumCold.ucb95).toBeCloseTo(report.medium.cold.ucb95, 10);
      expect(mediumCold.lcb95).toBeCloseTo(report.medium.cold.lcb95, 10);
      expect(mediumWarm.ucb95).toBeCloseTo(report.medium.warm.ucb95, 10);
      expect(mediumWarm.lcb95).toBeCloseTo(report.medium.warm.lcb95, 10);
      expect(big1kCold.ucb95).toBeCloseTo(report.big1k.cold.ucb95, 10);
      expect(big1kCold.lcb95).toBeCloseTo(report.big1k.cold.lcb95, 10);
      expect(big1kWarm.ucb95).toBeCloseTo(report.big1k.warm.ucb95, 10);
      expect(big1kWarm.lcb95).toBeCloseTo(report.big1k.warm.lcb95, 10);
    }
  );
});
