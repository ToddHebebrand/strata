#!/usr/bin/env node
// Gate 3 (unkeyed noninferiority), Task 8: the OPERATOR big run.
//
// Builds the ×46 big1k corpus + a 1-copy baseline corpus (each into a FRESH
// mkdtemp dir — the corpus builder merges into pre-existing outDirs, so a fresh
// dir per corpus is mandatory), runs the real cold + warm balanced schedules,
// the metrics-ON server characterization, and the baseline-adjusted memory
// predicate on BOTH `examples/medium` AND big1k, then WRITES the committed
// artifact `docs/spikes/gate3-noninferiority-profile.{json,md}` FIRST and only
// THEN exits with a tri-state code:
//
//   exit 0  overall PASS (both corpora present, all ratios PASS, lifecycle 4/4)
//   exit 2  measured noninferiority FAIL
//   exit 1  INCONCLUSIVE, a lifecycle-parity mismatch, or an infra error
//
// Lifecycle parity is DISPOSITIVE (`gate3MachineVerdict`): a 4-vs-4 mismatch on
// any present corpus can never yield exit 0. With the recorded medium FAIL
// present (decisions.md 2026-07-22), the expected terminal outcome is exit 2 —
// but the gate logic is correct on its own.
//
// `--smoke`: a tiny end-to-end plumbing validation (big1k = 2 copies, small N)
// that writes to a throwaway tmpdir, NEVER to docs/spikes. Its purpose is that
// Task 9's operator run is not the first execution of this code path. It still
// enforces `requireRawPairs` and still exits on the real tri-state.
//
// NOT run in Task 8 at full size — the ~1012-module measurement is Task 9's
// operator run.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { buildCorpusInputs } from "../tasks.js";
import { kernelServiceBinary } from "../gate1.js";
import {
  LEAK_FACTOR,
  MEDIUM_LEAK_ITERATIONS,
  PERSISTENT_1K_RSS_CAP,
  QUIESCENCE_MS,
  persistentMemoryVerdict,
  type GuardedPids,
  type PersistentMemoryVerdict,
  type RssSamplePoint
} from "../persistence/memory-guard.js";
import {
  createWarmScheduleSampler,
  runMediumLeakCheck,
  type MediumLeakCheckOutcome,
  type WarmScheduleSampler,
  type WarmScheduleSampling
} from "../persistence/exit-gate-memory.js";
import {
  BASELINE_COPIES,
  BIG1K_COPIES,
  buildReplicatedCorpus,
  type ReplicatedCorpus
} from "./corpus.js";
import { runCold, runWarm, runChildOnce, type RunnerCorpus, type WarmTrend } from "./runners.js";
import type { ChildResult, ChildRenameTarget } from "./child-protocol.js";
import type { PairOrder, SchedulePair } from "./schedule.js";
import {
  lifecycleParity,
  memoryVerdict,
  ratioVerdict,
  type MemoryCaps,
  type MemoryValues,
  type MemoryVerdict,
  type RatioVerdict,
  type RatioVerdictState
} from "./stats.js";
import { characterizeKernelServer, type KernelServerCharacterization } from "./characterize.js";
import {
  buildGate3CorpusReport,
  buildGate3Report,
  gate3MachineVerdict,
  writeGate3Artifacts,
  type CorpusInfo,
  type Gate3CorpusReport,
  type ScheduleProvenance
} from "./report.js";
import { collectProvenance, GATE3_METRICS_MODE } from "./provenance.js";
import {
  N_MEDIUM,
  N_BIG1K,
  N_BASELINE,
  WARM_HORIZON,
  GROWTH_FACTOR,
  KERNEL_1K_RSS_CAP,
  SQLITE_1K_RSS_CAP,
  COLD_KERNEL_TIMEOUT_MS,
  COLD_SQLITE_TIMEOUT_MS,
  WARM_STEP_TIMEOUT_MS,
  GATE3_MEDIUM_COLD_SEED,
  GATE3_MEDIUM_WARM_SEED,
  GATE3_MEDIUM_BASELINE_SEED,
  GATE3_BIG1K_COLD_SEED,
  GATE3_BIG1K_WARM_SEED,
  GATE3_BOOTSTRAP_SEED
} from "./config.js";

const packageRoot = resolve(__dirname, "..", "..");
const repoRoot = resolve(packageRoot, "..", "..");
const mediumRoot = resolve(repoRoot, "examples", "medium");
const spikesDir = resolve(repoRoot, "docs", "spikes");

const MEDIUM_TARGET: ChildRenameTarget = { modulePath: "src/types/user.ts", declarationName: "User", newName: "Account" };
const CAPS: MemoryCaps = { kernel: KERNEL_1K_RSS_CAP, sqlite: SQLITE_1K_RSS_CAP };

function kernelChildEntry(): string {
  return resolve(__dirname, "kernel-child.js");
}
function sqliteChildEntry(): string {
  return resolve(__dirname, "sqlite-child.js");
}

interface Sizing {
  smoke: boolean;
  big1kCopies: number;
  nMediumCold: number;
  nMediumWarm: number;
  nBig1kCold: number;
  nBig1kWarm: number;
  nBaseline: number;
  nCharacterize: number;
}

function resolveSizing(smoke: boolean): Sizing {
  if (smoke) {
    // Tiny but structurally complete: 2 copies exercise the replicated-corpus
    // layout; N=2 satisfies runWarm's `n>=2` (one pair per trend half) while
    // keeping the whole smoke to a couple of minutes.
    return {
      smoke,
      big1kCopies: 2,
      nMediumCold: 2,
      nMediumWarm: 2,
      nBig1kCold: 2,
      nBig1kWarm: 2,
      nBaseline: 2,
      nCharacterize: 2
    };
  }
  return {
    smoke,
    big1kCopies: BIG1K_COPIES,
    nMediumCold: N_MEDIUM,
    nMediumWarm: N_MEDIUM,
    nBig1kCold: N_BIG1K,
    nBig1kWarm: N_BIG1K,
    nBaseline: N_BASELINE,
    nCharacterize: N_BIG1K
  };
}

// ---------------------------------------------------------------------------
// Task 11 (bridge-persistence exit gate): CLI surface.
// ---------------------------------------------------------------------------

/** The default exit-gate artifact base name (plan Task 11). */
export const EXIT_GATE_DEFAULT_ARTIFACT_BASE = "bridge-persistence-exit-gate";

export interface RunBigCliOptions {
  smoke: boolean;
  /** `"persistence"` iff `--exit-gate persistence` was passed; null otherwise. */
  exitGate: "persistence" | null;
  /** `--artifact-base <name>`; defaults to `EXIT_GATE_DEFAULT_ARTIFACT_BASE` in exit-gate mode (so an exit-gate run can never overwrite the recorded gate-3 artifact), null otherwise. */
  artifactBase: string | null;
}

/**
 * Parse run-big's argv tail (everything after the script path). Pure and
 * exported for unit tests. With neither new flag present the result is
 * `{ smoke, exitGate: null, artifactBase: null }` and `main`'s behavior is
 * byte-identical to before Task 11 (unknown arguments are ignored, exactly
 * as the pre-Task-11 `--smoke`-only parsing ignored them).
 */
export function parseRunBigArgs(argv: readonly string[]): RunBigCliOptions {
  const smoke = argv.includes("--smoke");

  let exitGate: "persistence" | null = null;
  const exitGateIndex = argv.indexOf("--exit-gate");
  if (exitGateIndex !== -1) {
    const value = argv[exitGateIndex + 1];
    if (value !== "persistence") {
      throw new Error(`--exit-gate: expected "persistence", got ${value === undefined ? "<missing>" : JSON.stringify(value)}`);
    }
    exitGate = "persistence";
  }

  let artifactBase: string | null = null;
  const artifactBaseIndex = argv.indexOf("--artifact-base");
  if (artifactBaseIndex !== -1) {
    const value = argv[artifactBaseIndex + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--artifact-base: a base name is required");
    }
    if (!/^[A-Za-z0-9._-]+$/.test(value)) {
      throw new Error(`--artifact-base: ${JSON.stringify(value)} is not a plain file base name (no path separators)`);
    }
    artifactBase = value;
  }
  if (exitGate !== null && artifactBase === null) artifactBase = EXIT_GATE_DEFAULT_ARTIFACT_BASE;

  return { smoke, exitGate, artifactBase };
}

// ---------------------------------------------------------------------------
// Task 11: A3 memory assembly + exit-gate provenance block (exit-gate mode
// ONLY — the default path never calls anything below except via `main`'s
// explicit `cli.exitGate` branches).
// ---------------------------------------------------------------------------

/** Infer the daemon binary's cargo profile from its path (release/debug directory segment). */
export function binaryProfileOf(binaryPath: string): "release" | "debug" | "unknown" {
  if (binaryPath.includes(`${sep}release${sep}`)) return "release";
  if (binaryPath.includes(`${sep}debug${sep}`)) return "debug";
  return "unknown";
}

/** The exit-gate JSON provenance block (nested under `exitGate` in the artifact, never touching existing schema fields). */
export interface ExitGateProvenanceBlock {
  mode: "persistence";
  binaryProfile: "release" | "debug" | "unknown";
  /** The resolved daemon binary path (the STRATA_KERNEL_SERVICE_BIN value, or the default). */
  kernelServiceBin: string;
  persistentBridge: true;
  /** Task 10 memoization is profiled-in and unconditional in the persistent worker. */
  memoizationEnabled: true;
  /** The metrics-ON characterization daemon stays one-shot (non-dispositive; disclosed). */
  characterizationPersistentBridge: false;
  argv: string[];
  constants: {
    leakFactor: number;
    persistent1kRssCapBytes: number;
    mediumLeakIterations: number;
    quiescenceMs: number;
  };
  memory: {
    medium: {
      state: RatioVerdictState;
      continuityHeld: boolean;
      inconclusiveReason?: string;
      highWaterBytes: number[];
      samples: RssSamplePoint[];
      daemonPid: number;
      workerPid: number;
      leakVerdict?: PersistentMemoryVerdict;
    };
    big1k: {
      state: RatioVerdictState;
      continuityHeld: boolean;
      inconclusiveReason?: string;
      combinedBytes: number[];
      samples: RssSamplePoint[];
      pids?: GuardedPids;
      peakBytes?: number;
      capPass?: boolean;
      capBytes: number;
    };
  };
}

/** Everything `assembleA3Memory` produces: the per-corpus memory verdicts to fold into `corpusState`, plus the artifact's memory sub-block. */
export interface A3MemoryAssembly {
  medium: { kernel: MemoryVerdict; sqlite: MemoryVerdict };
  big1k: { kernel: MemoryVerdict; sqlite: MemoryVerdict };
  memoryBlock: ExitGateProvenanceBlock["memory"];
}

/**
 * The A3 memory component (plan v2 amendment A3), replacing the obsolete
 * `mediumMemoryPlaceholder` / cross-corpus growth assembly IN EXIT-GATE MODE
 * ONLY. Pure over already-measured inputs, so it is unit-testable:
 *
 *   medium.kernel  — the Task 9 leak predicate over the N=12 persistent-
 *                    bridge warm series: PASS iff leakPass; FAIL iff the
 *                    complete series fails the predicate; INCONCLUSIVE iff
 *                    PID continuity was violated (respawn/death) or the
 *                    series is short (run cut off) — with the reason carried
 *                    on the artifact's `exitGate.memory.medium` block.
 *   big1k.kernel   — the absolute pre-registered combined daemon+worker RSS
 *                    cap over samples taken DURING the big1k warm schedule:
 *                    PASS iff peak <= cap; FAIL iff breached; INCONCLUSIVE
 *                    iff continuity was violated mid-schedule or no samples
 *                    were captured.
 *   *.sqlite       — PASS by definition: the A3 predicate constrains ONLY
 *                    the kernel arm's persistent processes (the SQLite arm
 *                    has no daemon/worker); observed child-harness RSS values
 *                    are carried for information only.
 *
 * The `MemoryVerdict` field mapping (growthAdjusted -1 sentinel, growthPass
 * false) mirrors the placeholder's convention: the cross-corpus growth ratio
 * is not part of the A3 verdict.
 */
export function assembleA3Memory(inputs: {
  mediumLeak: MediumLeakCheckOutcome;
  big1kWarm: WarmScheduleSampling;
  observed: { mediumSqliteRss: number; big1kSqliteRss: number; baselineSqliteRss: number };
  caps?: { leakFactor?: number; persistent1kRssCapBytes?: number };
}): A3MemoryAssembly {
  const { mediumLeak, big1kWarm, observed } = inputs;
  const capBytes = inputs.caps?.persistent1kRssCapBytes ?? PERSISTENT_1K_RSS_CAP;

  // --- medium: the leak predicate ---------------------------------------
  let mediumState: RatioVerdictState;
  let mediumReason = mediumLeak.inconclusiveReason;
  let leakVerdict: PersistentMemoryVerdict | undefined;
  if (!mediumLeak.continuityHeld) {
    mediumState = "INCONCLUSIVE";
    mediumReason = mediumReason ?? "medium leak check: PID continuity violated";
  } else if (mediumLeak.highWaterBytes.length < MEDIUM_LEAK_ITERATIONS) {
    mediumState = "INCONCLUSIVE";
    mediumReason = `medium leak check: only ${mediumLeak.highWaterBytes.length}/${MEDIUM_LEAK_ITERATIONS} iterations sampled`;
  } else {
    leakVerdict = persistentMemoryVerdict(
      { mediumHighWaterBytes: mediumLeak.highWaterBytes },
      { leakFactor: inputs.caps?.leakFactor }
    );
    mediumState = leakVerdict.leakPass ? "PASS" : "FAIL";
  }
  const mediumPeak = mediumLeak.highWaterBytes.length > 0 ? Math.max(...mediumLeak.highWaterBytes) : 0;

  // --- big1k: the absolute combined-RSS cap ------------------------------
  let big1kState: RatioVerdictState;
  let big1kReason = big1kWarm.inconclusiveReason;
  let peakBytes: number | undefined;
  let capPass: boolean | undefined;
  if (!big1kWarm.continuityHeld) {
    big1kState = "INCONCLUSIVE";
    big1kReason = big1kReason ?? "big1k warm sampling: PID continuity violated";
  } else if (big1kWarm.combinedBytes.length === 0) {
    big1kState = "INCONCLUSIVE";
    big1kReason = big1kReason ?? "big1k warm sampling: no combined-RSS samples captured";
  } else {
    peakBytes = Math.max(...big1kWarm.combinedBytes);
    capPass = peakBytes <= capBytes;
    big1kState = capPass ? "PASS" : "FAIL";
  }

  const kernelVerdict = (slot: "medium" | "big1k"): MemoryVerdict => ({
    arm: "kernel",
    medium: mediumPeak,
    big1k: slot === "big1k" ? (peakBytes ?? 0) : mediumPeak,
    baseline: 0,
    absoluteCapPass: slot === "big1k" ? (capPass ?? false) : true,
    growthAdjusted: -1,
    growthPass: false,
    state: slot === "big1k" ? big1kState : mediumState
  });
  const sqliteVerdict = (slot: "medium" | "big1k"): MemoryVerdict => ({
    arm: "sqlite",
    medium: observed.mediumSqliteRss,
    big1k: slot === "big1k" ? observed.big1kSqliteRss : observed.mediumSqliteRss,
    baseline: observed.baselineSqliteRss,
    absoluteCapPass: true,
    growthAdjusted: -1,
    growthPass: false,
    // The A3 predicate constrains only the kernel arm's persistent
    // processes; the SQLite arm's slot is PASS by definition (values above
    // are informational child-harness RSS observations).
    state: "PASS"
  });

  return {
    medium: { kernel: kernelVerdict("medium"), sqlite: sqliteVerdict("medium") },
    big1k: { kernel: kernelVerdict("big1k"), sqlite: sqliteVerdict("big1k") },
    memoryBlock: {
      medium: {
        state: mediumState,
        continuityHeld: mediumLeak.continuityHeld,
        ...(mediumReason !== undefined ? { inconclusiveReason: mediumReason } : {}),
        highWaterBytes: [...mediumLeak.highWaterBytes],
        samples: [...mediumLeak.samples],
        daemonPid: mediumLeak.daemonPid,
        workerPid: mediumLeak.workerPid,
        ...(leakVerdict !== undefined ? { leakVerdict } : {})
      },
      big1k: {
        state: big1kState,
        continuityHeld: big1kWarm.continuityHeld,
        ...(big1kReason !== undefined ? { inconclusiveReason: big1kReason } : {}),
        combinedBytes: [...big1kWarm.combinedBytes],
        samples: [...big1kWarm.samples],
        ...(big1kWarm.pids !== undefined ? { pids: big1kWarm.pids } : {}),
        ...(peakBytes !== undefined ? { peakBytes } : {}),
        ...(capPass !== undefined ? { capPass } : {}),
        capBytes
      }
    }
  };
}

const maxRss = (pairs: SchedulePair[], arm: "kernel" | "sqlite"): number =>
  Math.max(...pairs.map((pair) => pair[arm].childMaxRssBytes));

const walls = (pairs: SchedulePair[]): { kernel: number; sqlite: number }[] =>
  pairs.map((pair) => ({ kernel: pair.kernel.callerWallNs, sqlite: pair.sqlite.callerWallNs }));

const realizedOrder = (pairs: SchedulePair[]): PairOrder[] => pairs.map((pair) => pair.order);

/** One cold child per arm to capture the ACTUAL lifecycle traces (the runners drop them). */
async function captureLifecycle(corpusRoot: string, target: ChildRenameTarget): Promise<{ kernel: number; sqlite: number; equal: boolean }> {
  const request = { corpusRoot, target, mode: "cold" as const, iterations: 1 };
  const sqliteResult: ChildResult = await runChildOnce(sqliteChildEntry(), request, COLD_SQLITE_TIMEOUT_MS);
  const kernelResult: ChildResult = await runChildOnce(kernelChildEntry(), request, COLD_KERNEL_TIMEOUT_MS);
  return lifecycleParity(kernelResult.lifecycle, sqliteResult.lifecycle);
}

/**
 * `memoryVerdict`, but tolerant of a degenerate `(medium - baseline)`
 * denominator. The plan's growth predicate is CROSS-corpus —
 * `(big1k_peakRss - baseline_peakRss) / (medium_peakRss - baseline_peakRss)` —
 * so `medium`/`big1k` MUST be different corpora's peaks (this is the reviewer's
 * fix: the assembly, not per-corpus self-comparison). The denominator can still
 * be ~0/negative because the landed 1-copy-baseline design makes the baseline
 * corpus the SAME 22-module size as `examples/medium`; in that case the growth
 * ratio itself is genuinely uninterpretable (sentinel growthAdjusted -1,
 * growthPass false) — but the absolute cap is an INDEPENDENT predicate that
 * does not depend on this denominator at all, so it is still evaluated and is
 * still dispositive: a cap breach yields FAIL even with a degenerate
 * denominator, and only a cap PASS with a degenerate denominator yields
 * INCONCLUSIVE (the growth ratio can't be assessed, but nothing measured
 * failed outright). That residual denominator degeneracy is a separate,
 * documented concern (needs a smaller baseline corpus). Memory is NOT
 * non-dispositive overall, despite that concern: both arms' `MemoryVerdict`
 * states feed `corpusState` (the worst of cold/warm/memory-kernel/memory-
 * sqlite), which feeds `report.verdict`, which is what `gate3MachineVerdict`
 * exits on — so a memory FAIL here can and does drive the process exit code,
 * exactly as the plan intends.
 */
export function memoryVerdictTolerant(
  arm: "kernel" | "sqlite",
  values: MemoryValues,
  sqliteControl?: { growthAdjusted: number }
): MemoryVerdict {
  if (values.medium <= values.baseline) {
    const absoluteCapPass = values.big1k <= CAPS[arm];
    return {
      arm,
      medium: values.medium,
      big1k: values.big1k,
      baseline: values.baseline,
      absoluteCapPass,
      growthAdjusted: -1, // sentinel: growth ratio not computable (baseline≈medium)
      growthPass: false,
      // The absolute cap is an independent predicate: a breach is dispositive
      // (FAIL) regardless of the degenerate growth denominator. Only a cap
      // PASS combined with a non-computable growth ratio is INCONCLUSIVE.
      state: absoluteCapPass ? "INCONCLUSIVE" : "FAIL"
    };
  }
  return memoryVerdict(arm, values, CAPS, GROWTH_FACTOR, sqliteControl);
}

/**
 * The medium corpus report's memory field is a NON-DISPOSITIVE placeholder: the
 * baseline-adjusted growth predicate is inherently cross-corpus (big1k vs
 * medium) and lands on the BIG1K report, which is the corpus whose growth is
 * being tested. Medium's own report records its observed peak RSS with the
 * growth ratio marked not-applicable (sentinel -1, state INCONCLUSIVE) — it
 * never drives `corpusState` to FAIL (medium's state is already the wall-ratio
 * FAIL), and it makes clear in the artifact that the real growth number is on
 * big1k, not duplicated here.
 */
function mediumMemoryPlaceholder(arm: "kernel" | "sqlite", ownRss: number, baseline: number): MemoryVerdict {
  return {
    arm,
    medium: ownRss,
    big1k: ownRss,
    baseline,
    absoluteCapPass: ownRss <= CAPS[arm],
    growthAdjusted: -1,
    growthPass: false,
    state: "INCONCLUSIVE"
  };
}

/** Real content digest + scanned module count for the unreplicated `examples/medium` source (mirrors corpus.ts's sha256-over-sorted-{relPath:sha256(text)} pattern). */
function mediumCorpusInfo(): CorpusInfo {
  const inputs = buildCorpusInputs(mediumRoot);
  const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");
  const digestByRelPath: Record<string, string> = {};
  for (const input of inputs) digestByRelPath[input.path] = sha256Hex(input.text);
  const digest = sha256Hex(
    JSON.stringify(
      Object.keys(digestByRelPath)
        .sort()
        .map((relPath) => [relPath, digestByRelPath[relPath]])
    )
  );
  return { digest, moduleCount: inputs.length, copies: 1 };
}

/** Everything one corpus's battery produces EXCEPT its memory verdict — memory is assembled cross-corpus by `main` once BOTH corpora's peak RSS are known. */
interface CorpusRun {
  coldVerdict: RatioVerdict;
  warmVerdict: RatioVerdict;
  warmTrend: WarmTrend;
  lifecycle: { kernel: number; sqlite: number };
  server: KernelServerCharacterization;
  coldPairs: SchedulePair[];
  warmPairs: SchedulePair[];
  corpusInfo: CorpusInfo;
  schedules: { cold: ScheduleProvenance; warm: ScheduleProvenance };
  /** This corpus's own peak RSS high-water per arm (max across its cold+warm samples). */
  kernelRss: number;
  sqliteRss: number;
  /** Task 11 (exit-gate mode only): the big1k warm-schedule true-process sampling, when a `warmSampler` was supplied. */
  warmSampling?: WarmScheduleSampling;
}

/** Run the full per-corpus battery: cold, warm, characterization, lifecycle, RSS high-water. Does NOT compute memory (that is cross-corpus — see `main`). */
async function runCorpus(
  label: "medium" | "big1k",
  corpus: RunnerCorpus,
  corpusInfo: CorpusInfo,
  sizing: Sizing,
  coldSeed: number,
  warmSeed: number,
  nCold: number,
  nWarm: number,
  /** Task 11 (exit-gate mode only): started right before the (unchanged) warm schedule, stopped right after. Absent -> this function's behavior is byte-identical to before Task 11. */
  warmSampler?: WarmScheduleSampler
): Promise<CorpusRun> {
  process.stderr.write(`[run-big] ${label}: cold n=${nCold}...\n`);
  const cold = await runCold(corpus, {
    n: nCold,
    seed: coldSeed,
    timeoutMs: { kernel: COLD_KERNEL_TIMEOUT_MS, sqlite: COLD_SQLITE_TIMEOUT_MS }
  });
  process.stderr.write(`[run-big] ${label}: warm n=${nWarm}...\n`);
  if (warmSampler) warmSampler.start();
  const warm = await runWarm(corpus, { n: nWarm, seed: warmSeed, warmHorizon: WARM_HORIZON, timeoutMs: WARM_STEP_TIMEOUT_MS });
  const warmSampling = warmSampler ? warmSampler.stop() : undefined;
  process.stderr.write(`[run-big] ${label}: characterization (metrics-on) n=${sizing.nCharacterize}...\n`);
  const server: KernelServerCharacterization = await characterizeKernelServer(corpus, {
    n: sizing.nCharacterize,
    seed: coldSeed
  });
  process.stderr.write(`[run-big] ${label}: lifecycle capture...\n`);
  const lifecycle = await captureLifecycle(corpus.corpusRoot, corpus.target);

  const coldVerdict = ratioVerdict(walls(cold.pairs), GATE3_BOOTSTRAP_SEED);
  const warmVerdict = ratioVerdict(walls(warm.pairs), GATE3_BOOTSTRAP_SEED);

  return {
    coldVerdict,
    warmVerdict,
    warmTrend: warm.trend,
    lifecycle: { kernel: lifecycle.kernel, sqlite: lifecycle.sqlite },
    server,
    coldPairs: cold.pairs,
    warmPairs: warm.pairs,
    corpusInfo,
    schedules: {
      cold: { seed: coldSeed, n: cold.pairs.length, realizedOrder: realizedOrder(cold.pairs) },
      warm: { seed: warmSeed, n: warm.pairs.length, realizedOrder: realizedOrder(warm.pairs) }
    },
    // This corpus's own peak RSS high-water (max across cold+warm samples).
    kernelRss: Math.max(maxRss(cold.pairs, "kernel"), maxRss(warm.pairs, "kernel")),
    sqliteRss: Math.max(maxRss(cold.pairs, "sqlite"), maxRss(warm.pairs, "sqlite")),
    ...(warmSampling !== undefined ? { warmSampling } : {})
  };
}

/** Assemble one corpus's `Gate3CorpusReport` from its battery run + the (cross-corpus-computed) memory verdicts. */
function assembleCorpusReport(
  run: CorpusRun,
  memory: { kernel: MemoryVerdict; sqlite: MemoryVerdict }
): Gate3CorpusReport {
  return buildGate3CorpusReport({
    cold: run.coldVerdict,
    warm: run.warmVerdict,
    warmTrend: run.warmTrend,
    memory,
    lifecycle: run.lifecycle,
    server: run.server,
    coldPairs: run.coldPairs,
    warmPairs: run.warmPairs,
    corpusInfo: run.corpusInfo,
    schedules: run.schedules
  });
}

/** Baseline RSS per arm: cold single mutations on the 1-copy control corpus, peak childMaxRssBytes per arm. */
async function measureBaselineRss(baseline: ReplicatedCorpus, seed: number, n: number): Promise<{ kernel: number; sqlite: number }> {
  const corpus: RunnerCorpus = { corpusRoot: baseline.corpusRoot, corpus: "baseline", target: baseline.renameTarget };
  process.stderr.write(`[run-big] baseline: cold n=${n} (RSS anchor)...\n`);
  const cold = await runCold(corpus, { n, seed, timeoutMs: { kernel: COLD_KERNEL_TIMEOUT_MS, sqlite: COLD_SQLITE_TIMEOUT_MS } });
  return { kernel: maxRss(cold.pairs, "kernel"), sqlite: maxRss(cold.pairs, "sqlite") };
}

function fmtRatio(v: RatioVerdict): string {
  return `ratio=${v.pointRatio.toFixed(3)} ucb=${v.ucb95.toFixed(3)} lcb=${v.lcb95.toFixed(3)} -> ${v.state}`;
}

async function main(): Promise<void> {
  const cli = parseRunBigArgs(process.argv.slice(2));
  const smoke = cli.smoke;
  const sizing = resolveSizing(smoke);
  if (cli.exitGate !== null) {
    // Task 11: the ONLY kernel-arm configuration change in exit-gate mode —
    // kernel-child.ts reads this and passes `--persistent-bridge` to its
    // daemon (runners thread it through via `credentialFreeEnv()`).
    process.env.GATE3_PERSISTENT_BRIDGE = "1";
  }
  process.stderr.write(
    `[run-big] mode=${smoke ? "SMOKE" : "FULL"} big1kCopies=${sizing.big1kCopies}` +
      `${cli.exitGate !== null ? ` exit-gate=${cli.exitGate} artifact-base=${cli.artifactBase}` : ""}\n`
  );

  const workRoot = mkdtempSync(resolve(tmpdir(), "gate3-run-big-"));
  const outDir = smoke ? mkdtempSync(resolve(tmpdir(), "gate3-smoke-out-")) : spikesDir;

  try {
    // --- Build corpora, each into its OWN fresh dir -------------------------
    const big1k = buildReplicatedCorpus(mediumRoot, resolve(workRoot, "big1k"), sizing.big1kCopies);
    const baseline = buildReplicatedCorpus(mediumRoot, resolve(workRoot, "baseline"), BASELINE_COPIES);

    // --- Baseline RSS anchor (both arms) ------------------------------------
    // One 1-copy control corpus serves both legs' baseline (it IS the shared
    // fixed-overhead anchor); no separate big1k baseline is needed.
    const baselineRss = await measureBaselineRss(baseline, GATE3_MEDIUM_BASELINE_SEED, sizing.nBaseline);

    // --- medium leg ----------------------------------------------------------
    const mediumCorpus: RunnerCorpus = { corpusRoot: mediumRoot, corpus: "medium", target: MEDIUM_TARGET };
    const mediumRun = await runCorpus(
      "medium",
      mediumCorpus,
      mediumCorpusInfo(),
      sizing,
      GATE3_MEDIUM_COLD_SEED,
      GATE3_MEDIUM_WARM_SEED,
      sizing.nMediumCold,
      sizing.nMediumWarm
    );

    // --- big1k leg -----------------------------------------------------------
    const big1kCorpus: RunnerCorpus = { corpusRoot: big1k.corpusRoot, corpus: "big1k", target: big1k.renameTarget };
    const big1kRun = await runCorpus(
      "big1k",
      big1kCorpus,
      { digest: big1k.corpusDigest, moduleCount: big1k.moduleCount, copies: big1k.copies },
      sizing,
      GATE3_BIG1K_COLD_SEED,
      GATE3_BIG1K_WARM_SEED,
      sizing.nBig1kCold,
      sizing.nBig1kWarm,
      // Task 11 (exit-gate mode only): true-process combined-RSS sampling
      // around the (unchanged) big1k warm schedule, for the A3 absolute cap.
      cli.exitGate !== null ? createWarmScheduleSampler(process.pid) : undefined
    );

    // --- CROSS-corpus memory predicate (the reviewer's fix) -----------------
    // The plan's growth predicate is `(big1k_peak - baseline) / (medium_peak -
    // baseline)`, comparing the TWO corpora — NOT a corpus against itself. It
    // is assembled here, once both legs' peak RSS are known: the medium leg
    // supplies the `medium` slot, the big1k leg the `big1k` slot, the 1-copy
    // control the `baseline`. sqlite first (never a control), then kernel with
    // the sqlite control threaded in (stats.ts's asymmetric downgrade rule).
    // These dispositive cross-corpus verdicts land on the BIG1K corpus report;
    // the medium report carries a documented non-dispositive placeholder.
    const sqliteMem = memoryVerdictTolerant("sqlite", {
      baseline: baselineRss.sqlite,
      medium: mediumRun.sqliteRss,
      big1k: big1kRun.sqliteRss
    });
    const kernelMem = memoryVerdictTolerant(
      "kernel",
      { baseline: baselineRss.kernel, medium: mediumRun.kernelRss, big1k: big1kRun.kernelRss },
      { growthAdjusted: sqliteMem.growthAdjusted }
    );
    process.stderr.write(
      `[run-big] cross-corpus memory growthAdjusted: sqlite=${sqliteMem.growthAdjusted.toFixed(4)} ` +
        `kernel=${kernelMem.growthAdjusted.toFixed(4)} ` +
        `(baseline k=${baselineRss.kernel} s=${baselineRss.sqlite}; ` +
        `medium k=${mediumRun.kernelRss} s=${mediumRun.sqliteRss}; ` +
        `big1k k=${big1kRun.kernelRss} s=${big1kRun.sqliteRss})\n`
    );

    // --- Task 11: the A3 memory component (exit-gate mode ONLY) -------------
    // The default (no-flags) path below is untouched: it still assembles the
    // placeholder + cross-corpus memory verdicts exactly as before.
    let a3: A3MemoryAssembly | null = null;
    if (cli.exitGate !== null) {
      process.stderr.write(`[run-big] exit-gate: medium N=${MEDIUM_LEAK_ITERATIONS} persistent-bridge leak check...\n`);
      const mediumLeak = await runMediumLeakCheck(mediumRoot);
      a3 = assembleA3Memory({
        mediumLeak,
        big1kWarm: big1kRun.warmSampling ?? {
          combinedBytes: [],
          samples: [],
          continuityHeld: false,
          inconclusiveReason: "big1k warm sampling: sampler was not attached"
        },
        observed: {
          mediumSqliteRss: mediumRun.sqliteRss,
          big1kSqliteRss: big1kRun.sqliteRss,
          baselineSqliteRss: baselineRss.sqlite
        }
      });
      process.stderr.write(
        `[run-big] exit-gate A3 memory: medium=${a3.memoryBlock.medium.state} ` +
          `(leak highWaters n=${a3.memoryBlock.medium.highWaterBytes.length}) ` +
          `big1k=${a3.memoryBlock.big1k.state} (peak=${a3.memoryBlock.big1k.peakBytes ?? "n/a"} ` +
          `cap=${a3.memoryBlock.big1k.capBytes} samples=${a3.memoryBlock.big1k.combinedBytes.length})\n`
      );
    }

    const mediumReport = assembleCorpusReport(
      mediumRun,
      a3 !== null
        ? a3.medium
        : {
            kernel: mediumMemoryPlaceholder("kernel", mediumRun.kernelRss, baselineRss.kernel),
            sqlite: mediumMemoryPlaceholder("sqlite", mediumRun.sqliteRss, baselineRss.sqlite)
          }
    );
    const big1kReport = assembleCorpusReport(big1kRun, a3 !== null ? a3.big1k : { kernel: kernelMem, sqlite: sqliteMem });

    // --- Assemble + WRITE the artifact FIRST --------------------------------
    const provenance = collectProvenance({
      scheduleSeed: GATE3_MEDIUM_COLD_SEED,
      timestamp: new Date().toISOString(),
      metricsMode: GATE3_METRICS_MODE
    });
    const report = buildGate3Report(provenance, { medium: mediumReport, big1k: big1kReport });
    if (a3 !== null) {
      // Task 11: nested exit-gate provenance block, additive to the JSON —
      // no existing schema field is touched.
      const binaryPath = kernelServiceBinary();
      const exitGateBlock: ExitGateProvenanceBlock = {
        mode: "persistence",
        binaryProfile: binaryProfileOf(binaryPath),
        kernelServiceBin: binaryPath,
        persistentBridge: true,
        memoizationEnabled: true,
        characterizationPersistentBridge: false,
        argv: [...process.argv],
        constants: {
          leakFactor: LEAK_FACTOR,
          persistent1kRssCapBytes: PERSISTENT_1K_RSS_CAP,
          mediumLeakIterations: MEDIUM_LEAK_ITERATIONS,
          quiescenceMs: QUIESCENCE_MS
        },
        memory: a3.memoryBlock
      };
      report.exitGate = exitGateBlock;
    }

    const { jsonPath, markdownPath } = writeGate3Artifacts(report, outDir, {
      deterministicName: !smoke,
      requireRawPairs: true,
      ...(cli.artifactBase !== null ? { artifactBase: cli.artifactBase } : {})
    });
    // Sibling head marker: binds the committed artifact to the git tree it was
    // measured against (artifact CI test asserts provenance.headSha === marker).
    // Task 11: an explicit --artifact-base gets its own parallel marker
    // convention (`<base>.head`); the default naming logic is unchanged.
    const markerPath = resolve(
      outDir,
      cli.artifactBase !== null
        ? `${cli.artifactBase}.head`
        : smoke
          ? "gate3-smoke-profile.head"
          : "gate3-noninferiority-profile.head"
    );
    writeFileSync(markerPath, `${provenance.headSha}\n`, "utf8");

    // --- THEN report the verdict + exit -------------------------------------
    const machine = gate3MachineVerdict(report);
    process.stdout.write(`\n=== Gate 3 ${smoke ? "SMOKE " : ""}verdict: ${report.verdict} (exit ${machine.exitCode}) ===\n`);
    process.stdout.write(`reason: ${machine.reason}\n`);
    process.stdout.write(`medium cold: ${fmtRatio(mediumRun.coldVerdict)}\n`);
    process.stdout.write(`medium warm: ${fmtRatio(mediumRun.warmVerdict)}\n`);
    process.stdout.write(`big1k  cold: ${fmtRatio(big1kRun.coldVerdict)}\n`);
    process.stdout.write(`big1k  warm: ${fmtRatio(big1kRun.warmVerdict)}\n`);
    process.stdout.write(`artifact: ${jsonPath}\n          ${markdownPath}\n          ${markerPath}\n`);
    if (smoke) process.stdout.write(`(smoke: wrote to a throwaway tmpdir, NOT docs/spikes)\n`);

    process.exitCode = machine.exitCode;
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
    if (smoke) rmSync(outDir, { recursive: true, force: true });
  }
}

// Guarded (mirrors `cli.ts`'s identical pattern) so this module's pure helpers
// (e.g. `memoryVerdictTolerant`) can be imported by a unit test without
// triggering the real operator run's children/corpora/artifact write.
if (typeof require !== "undefined" && require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    // Infra error -> exit 1 (never a silent success, never a measured-FAIL 2).
    process.exitCode = 1;
  });
}
