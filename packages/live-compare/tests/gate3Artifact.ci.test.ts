// Gate 3 (unkeyed noninferiority), Task 8: the committed-artifact CI check.
//
// Validates `docs/spikes/gate3-noninferiority-profile.json` against a zod
// schema and binds it to the git tree it was measured against via a sibling
// marker file `docs/spikes/gate3-noninferiority-profile.head`.
//
// Marker mechanism: `run-big.ts` writes the marker = `provenance.headSha` (the
// git HEAD at measurement time) alongside the artifact, so the two are
// consistent by construction. This test asserts `artifact.provenance.headSha
// === marker` — a mismatch means the committed artifact and its marker
// diverged (a hand-edited headSha, or a regenerated artifact whose marker was
// not updated), i.e. the artifact no longer reflects the tree it claims.
//
// GRACEFUL SKIP: while the artifact does not yet exist (Task 9's operator run
// produces it), this suite SKIPS with a clear message rather than failing — so
// the `kernel:gate3:test` / `kernel:full-key-free:test` chain stays green
// before Task 9.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ratioVerdict } from "../src/gate3/stats.js";
import { GATE3_BOOTSTRAP_SEED } from "../src/gate3/config.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const spikesDir = resolve(repoRoot, "docs", "spikes");
const ARTIFACT_JSON = resolve(spikesDir, "gate3-noninferiority-profile.json");
const ARTIFACT_HEAD = resolve(spikesDir, "gate3-noninferiority-profile.head");
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
  // Obligation 2: raw pairs mandatory + non-empty on the committed artifact.
  coldPairs: z.array(schedulePairSchema).min(1),
  warmPairs: z.array(schedulePairSchema).min(1),
  // Obligation 1: per-corpus identity + per-mode schedule provenance.
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
  // Obligation 1: metrics mode explicit on the artifact.
  metricsMode: z.string()
});

const gate3ReportSchema = z.object({
  provenance: provenanceSchema,
  medium: corpusReportSchema,
  big1k: corpusReportSchema, // committed artifact is a full both-corpora run.
  verdict: triState
});

describe("gate3 committed-artifact CI check", () => {
  it.runIf(!ARTIFACT_EXISTS)("artifact not yet generated — SKIPPING (Task 9 operator run produces it)", () => {
    // eslint-disable-next-line no-console
    console.warn(
      `[gate3Artifact.ci] ${ARTIFACT_JSON} does not exist yet — Task 9's operator big run produces it. ` +
        `Skipping schema + headSha-marker validation so the chain stays green until then.`
    );
    expect(ARTIFACT_EXISTS).toBe(false);
  });

  it.skipIf(!ARTIFACT_EXISTS)("validates against the zod schema, carries mandatory raw pairs + provenance, headSha matches marker", () => {
    const report = gate3ReportSchema.parse(JSON.parse(readFileSync(ARTIFACT_JSON, "utf8")));

    // Raw pairs actually present (n is real, never "n/a").
    expect(report.medium.coldPairs.length).toBeGreaterThan(0);
    expect(report.medium.warmPairs.length).toBeGreaterThan(0);
    expect(report.big1k.coldPairs.length).toBeGreaterThan(0);
    expect(report.big1k.warmPairs.length).toBeGreaterThan(0);

    // N per (corpus, mode) recorded and consistent with the raw pairs.
    expect(report.medium.schedules.cold.n).toBe(report.medium.coldPairs.length);
    expect(report.big1k.schedules.warm.n).toBe(report.big1k.warmPairs.length);

    // headSha marker binding.
    expect(existsSync(ARTIFACT_HEAD)).toBe(true);
    const marker = readFileSync(ARTIFACT_HEAD, "utf8").trim();
    expect(marker).toMatch(/^[0-9a-f]{40}$/);
    expect(report.provenance.headSha).toBe(marker);
  });

  // Post-recording cleanup: binds the committed verdict to the committed raw
  // samples. `ratioVerdict`'s bootstrap is seeded/deterministic
  // (`GATE3_BOOTSTRAP_SEED`, see run-big.ts's `ratioVerdict(walls(pairs),
  // GATE3_BOOTSTRAP_SEED)` call sites), and the artifact retains every raw
  // pair — so recomputing `ratioVerdict` straight from `coldPairs`/`warmPairs`
  // must reproduce EXACTLY the recorded `cold.state`/`warm.state` on both
  // corpora. A mismatch here would mean the committed verdict does not
  // actually follow from the committed samples — a real integrity finding,
  // not something to paper over by adjusting this test.
  it.skipIf(!ARTIFACT_EXISTS)(
    "recomputing ratioVerdict from the artifact's own coldPairs/warmPairs (GATE3_BOOTSTRAP_SEED) reproduces the recorded cold/warm states on both corpora",
    () => {
      const report = gate3ReportSchema.parse(JSON.parse(readFileSync(ARTIFACT_JSON, "utf8")));
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

      // Not just the tri-state label — the recomputed ucb95/lcb95 numbers
      // themselves must match the recorded ones exactly (deterministic seed).
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
