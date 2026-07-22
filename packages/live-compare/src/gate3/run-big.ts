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
import { resolve } from "node:path";
import { buildCorpusInputs } from "../tasks.js";
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
  type RatioVerdict
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
 * corpus the SAME 22-module size as `examples/medium`; in that case the ratio
 * is genuinely uninterpretable, so the verdict is INCONCLUSIVE (sentinel
 * growthAdjusted -1) with the absolute cap still evaluated. That residual
 * denominator degeneracy is a separate, documented concern (needs a smaller
 * baseline corpus); it does not affect the overall gate, which rests on the
 * wall-ratio, and memory stays non-dispositive in `gate3MachineVerdict`.
 */
function memoryVerdictTolerant(
  arm: "kernel" | "sqlite",
  values: MemoryValues,
  sqliteControl?: { growthAdjusted: number }
): MemoryVerdict {
  if (values.medium <= values.baseline) {
    return {
      arm,
      medium: values.medium,
      big1k: values.big1k,
      baseline: values.baseline,
      absoluteCapPass: values.big1k <= CAPS[arm],
      growthAdjusted: -1, // sentinel: growth ratio not computable (baseline≈medium)
      growthPass: false,
      state: "INCONCLUSIVE"
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
  nWarm: number
): Promise<CorpusRun> {
  process.stderr.write(`[run-big] ${label}: cold n=${nCold}...\n`);
  const cold = await runCold(corpus, {
    n: nCold,
    seed: coldSeed,
    timeoutMs: { kernel: COLD_KERNEL_TIMEOUT_MS, sqlite: COLD_SQLITE_TIMEOUT_MS }
  });
  process.stderr.write(`[run-big] ${label}: warm n=${nWarm}...\n`);
  const warm = await runWarm(corpus, { n: nWarm, seed: warmSeed, warmHorizon: WARM_HORIZON, timeoutMs: WARM_STEP_TIMEOUT_MS });
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
    sqliteRss: Math.max(maxRss(cold.pairs, "sqlite"), maxRss(warm.pairs, "sqlite"))
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
  const smoke = process.argv.includes("--smoke");
  const sizing = resolveSizing(smoke);
  process.stderr.write(`[run-big] mode=${smoke ? "SMOKE" : "FULL"} big1kCopies=${sizing.big1kCopies}\n`);

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
      sizing.nBig1kWarm
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

    const mediumReport = assembleCorpusReport(mediumRun, {
      kernel: mediumMemoryPlaceholder("kernel", mediumRun.kernelRss, baselineRss.kernel),
      sqlite: mediumMemoryPlaceholder("sqlite", mediumRun.sqliteRss, baselineRss.sqlite)
    });
    const big1kReport = assembleCorpusReport(big1kRun, { kernel: kernelMem, sqlite: sqliteMem });

    // --- Assemble + WRITE the artifact FIRST --------------------------------
    const provenance = collectProvenance({
      scheduleSeed: GATE3_MEDIUM_COLD_SEED,
      timestamp: new Date().toISOString(),
      metricsMode: GATE3_METRICS_MODE
    });
    const report = buildGate3Report(provenance, { medium: mediumReport, big1k: big1kReport });

    const { jsonPath, markdownPath } = writeGate3Artifacts(report, outDir, {
      deterministicName: !smoke,
      requireRawPairs: true
    });
    // Sibling head marker: binds the committed artifact to the git tree it was
    // measured against (artifact CI test asserts provenance.headSha === marker).
    const markerPath = resolve(outDir, smoke ? "gate3-smoke-profile.head" : "gate3-noninferiority-profile.head");
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  // Infra error -> exit 1 (never a silent success, never a measured-FAIL 2).
  process.exitCode = 1;
});
