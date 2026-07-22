// Gate 3 (unkeyed noninferiority), Task 7: report builder, corpus/overall
// tri-state verdict resolution, and the committed-artifact writer.
//
// Everything in this file is PURE assembly/formatting over already-computed
// inputs (RatioVerdicts, MemoryVerdicts, lifecycle counts, an optional
// server characterization, a Provenance record) — none of it runs children,
// a daemon, git, or rustc. That is deliberate: it is what makes
// `gate3Report.unit.test.ts` a fast fixture-only suite (per the plan's
// "Unit tests use FIXTURES ... construct RatioVerdicts/MemoryVerdicts
// directly"). The impure collectors live in `provenance.ts`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KernelServerCharacterization } from "./characterize.js";
import type { Provenance } from "./provenance.js";
import type { WarmTrend } from "./runners.js";
import type { PairOrder, SchedulePair } from "./schedule.js";
import { nearestRankDistribution, type MemoryVerdict, type RatioVerdict, type RatioVerdictState } from "./stats.js";

/**
 * Task 8 (Task-7 review obligation 1): per-schedule provenance carried on the
 * committed artifact — the fixed `seed`, the sample count `n` (the number of
 * PAIRS; each pair is one kernel + one sqlite sample, so `n` is the N per
 * (corpus, mode) for BOTH arms), and the fully-realized AB/BA `order` sequence
 * the seed produced. Together these let any reader reproduce the exact schedule
 * a measurement ran, not just its summary.
 */
export interface ScheduleProvenance {
  seed: number;
  /** Pairs run (N per (corpus, mode); each pair yields one kernel + one sqlite sample). */
  n: number;
  /** The realized AB/BA order per pair, in pair order — deterministic for the seed. */
  realizedOrder: PairOrder[];
}

/**
 * Task 8 (Task-7 review obligation 1): per-corpus identity carried on the
 * committed artifact — the corpus content `digest`, its `moduleCount`, and the
 * `copies` used to build it (1 for baseline, 46 for big1k; `medium` reports its
 * own 22 / 1). Binds the measurement to the exact corpus it ran against.
 */
export interface CorpusInfo {
  digest: string;
  moduleCount: number;
  copies: number;
}

// ---------------------------------------------------------------------------
// Shapes — plan `docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md`,
// "Shared vocabulary" (`Gate3CorpusReport` / `Gate3Report`).
// ---------------------------------------------------------------------------

/**
 * Per-corpus gate-3 evidence: `{ cold, warm, warmTrend, memory, lifecycle,
 * server? }` exactly per the plan's shared vocabulary, plus two optional
 * raw-sample fields (`coldPairs`/`warmPairs`) so the committed JSON artifact
 * can retain every raw `SchedulePair` behind the summary `RatioVerdict`s
 * ("JSON retains ALL raw samples", not just the bootstrap summary) without
 * forcing every caller — including hand-built unit-test fixtures that never
 * ran a real child — to supply them.
 */
export interface Gate3CorpusReport {
  cold: RatioVerdict;
  warm: RatioVerdict;
  warmTrend: WarmTrend;
  memory: { kernel: MemoryVerdict; sqlite: MemoryVerdict };
  lifecycle: { kernel: number; sqlite: number };
  server?: KernelServerCharacterization;
  /** Raw per-pair samples backing `cold` (from `runCold`), when the caller has them. */
  coldPairs?: SchedulePair[];
  /** Raw per-pair samples backing `warm` (from `runWarm`), when the caller has them. */
  warmPairs?: SchedulePair[];
  /**
   * Task 8 (Task-7 review obligation 1): the corpus this report measured —
   * digest + module count + copies. Optional so hand-built unit-test fixtures
   * that never built a real corpus keep compiling; the real artifact path
   * (`run-big.ts`) always populates it.
   */
  corpusInfo?: CorpusInfo;
  /**
   * Task 8 (Task-7 review obligation 1): per-mode schedule provenance (seed +
   * realized order + N). Optional for the same fixture-compat reason; the real
   * artifact path always populates `cold`/`warm` (and `baseline` when a
   * baseline-RSS schedule ran for this corpus).
   */
  schedules?: { cold: ScheduleProvenance; warm: ScheduleProvenance; baseline?: ScheduleProvenance };
}

/**
 * `buildGate3CorpusReport`'s input is literally the `Gate3CorpusReport`
 * shape itself — the function only assembles/packages already-computed
 * pieces (Tasks 2-6's `ratioVerdict`, `memoryVerdict`, `lifecycleParity`,
 * `characterizeKernelServer`, `runCold`/`runWarm`), it does not compute any
 * of them. Named separately from `Gate3CorpusReport` for call-site clarity
 * even though the type is identical today.
 */
export type Gate3CorpusReportInputs = Gate3CorpusReport;

/**
 * Assembles an already-computed cold/warm `RatioVerdict` pair, warm trend,
 * both arms' `MemoryVerdict`s, lifecycle counts, and an optional server
 * characterization into one `Gate3CorpusReport`. This is a trivial pass-
 * through by design (see `Gate3CorpusReportInputs`'s doc) — kept as a named
 * function rather than inlined so report construction has one obvious call
 * site and so a future field can be validated/defaulted here in one place.
 */
export function buildGate3CorpusReport(inputs: Gate3CorpusReportInputs): Gate3CorpusReport {
  return { ...inputs };
}

const STATE_RANK: Record<RatioVerdictState, number> = { FAIL: 2, INCONCLUSIVE: 1, PASS: 0 };

/** Worst of `states` by FAIL ≺ INCONCLUSIVE ≺ PASS precedence. Throws on an empty array — there is no worst-of-nothing. */
function worstState(states: readonly RatioVerdictState[]): RatioVerdictState {
  if (states.length === 0) {
    throw new Error("worstState: states must be non-empty");
  }
  return states.reduce((worst, state) => (STATE_RANK[state] > STATE_RANK[worst] ? state : worst));
}

/**
 * A corpus's own tri-state, derived as the WORST of exactly four component
 * verdicts: `cold.state`, `warm.state`, `memory.kernel.state`,
 * `memory.sqlite.state`. This is the corpus-state derivation rule this task
 * defines (the plan's `Gate3CorpusReport` shape itself carries no `state`
 * field): every field that is itself a tri-state `RatioVerdict`/
 * `MemoryVerdict` feeds it, worst wins. `lifecycle` is deliberately
 * EXCLUDED — it is a pass/fail-by-inspection call-count pair (kernel 4 vs
 * sqlite 4), not a `PASS`/`FAIL`/`INCONCLUSIVE` verdict, and the plan's own
 * Task-8 acceptance suite already asserts lifecycle parity as an
 * independent condition ("AND lifecycle 4/4") rather than folding it into
 * the noninferiority tri-state — this function mirrors that separation
 * instead of inventing a new rule for how a lifecycle mismatch would rank.
 * `server` (metrics-on characterization) is also excluded: per the plan it
 * "feeds the gate-3 REPORT, never the wall verdict".
 */
export function corpusState(report: Gate3CorpusReport): RatioVerdictState {
  return worstState([report.cold.state, report.warm.state, report.memory.kernel.state, report.memory.sqlite.state]);
}

/** `{ provenance, medium, big1k?, verdict }` — the full committed gate-3 report. */
export interface Gate3Report {
  provenance: Provenance;
  medium: Gate3CorpusReport;
  big1k?: Gate3CorpusReport;
  verdict: RatioVerdictState;
}

/**
 * Overall verdict = the worst state across whichever corpora are present
 * (FAIL ≺ INCONCLUSIVE ≺ PASS: any FAIL anywhere -> FAIL; else any
 * INCONCLUSIVE -> INCONCLUSIVE; else PASS) — EXCEPT overall **PASS**
 * additionally requires BOTH corpora present. A medium-only report whose
 * corpus state is itself PASS is capped down to INCONCLUSIVE: big1k is the
 * decisive, at-scale corpus, and "the kernel scales" cannot be claimed from
 * the 22-module corpus alone. A medium-only FAIL or INCONCLUSIVE corpus
 * state is NOT capped — those are genuine findings the moment they are
 * observed, independent of what a bigger corpus might later show.
 */
export function buildGate3Report(
  provenance: Provenance,
  corpora: { medium: Gate3CorpusReport; big1k?: Gate3CorpusReport }
): Gate3Report {
  const { medium, big1k } = corpora;
  const mediumState = corpusState(medium);

  const verdict: RatioVerdictState = big1k
    ? worstState([mediumState, corpusState(big1k)])
    : mediumState === "PASS"
      ? "INCONCLUSIVE"
      : mediumState;

  return { provenance, medium, big1k, verdict };
}

// ---------------------------------------------------------------------------
// Machine verdict (exit code) — lifecycle parity is DISPOSITIVE here.
// ---------------------------------------------------------------------------

/** `true` iff a corpus's traced lifecycle counts are the canonical 4-vs-4. */
function lifecycleOk(report: Gate3CorpusReport): boolean {
  return report.lifecycle.kernel === 4 && report.lifecycle.sqlite === 4;
}

/** The overall machine outcome for a gate-3 run: a tri-state exit code plus a human reason. */
export interface Gate3MachineVerdict {
  /** 0 = overall PASS; 2 = measured FAIL; 1 = INCONCLUSIVE or an integrity failure (e.g. lifecycle mismatch). */
  exitCode: 0 | 1 | 2;
  reason: string;
}

/**
 * Task 8 (Task-7 review obligation 3): the machine verdict `run-big.ts` exits
 * on, with lifecycle parity made **dispositive** — an overall PASS additionally
 * REQUIRES 4-vs-4 lifecycle parity on EVERY present corpus, so a lifecycle
 * mismatch can never yield exit 0. Precedence:
 *
 *   - a measured `FAIL` anywhere -> exit 2 (the noninferiority falsifier
 *     dominates; a lifecycle note is appended if one is also mismatched);
 *   - else a lifecycle mismatch on any present corpus -> exit 1 (integrity
 *     failure: the arms' call structures are not comparable, so no PASS can be
 *     certified — this is the AND-lifecycle-into-PASS gate);
 *   - else `INCONCLUSIVE` -> exit 1;
 *   - else (`PASS` AND all lifecycles 4/4) -> exit 0.
 *
 * (With the recorded medium FAIL present, this returns exit 2 as expected — but
 * the lifecycle gate is correct on its own, independent of that.)
 */
export function gate3MachineVerdict(report: Gate3Report): Gate3MachineVerdict {
  const corpora: Array<{ label: string; corpus: Gate3CorpusReport }> = [{ label: "medium", corpus: report.medium }];
  if (report.big1k) corpora.push({ label: "big1k", corpus: report.big1k });

  const mismatches = corpora.filter(({ corpus }) => !lifecycleOk(corpus)).map(({ label }) => label);
  const lifecycleNote = mismatches.length > 0 ? ` (WARNING: lifecycle mismatch on ${mismatches.join(", ")})` : "";

  if (report.verdict === "FAIL") {
    return { exitCode: 2, reason: `measured noninferiority FAIL${lifecycleNote}` };
  }
  if (mismatches.length > 0) {
    return {
      exitCode: 1,
      reason: `lifecycle parity mismatch on ${mismatches.join(", ")} — cannot certify PASS (lifecycle is dispositive)`
    };
  }
  if (report.verdict === "INCONCLUSIVE") {
    return { exitCode: 1, reason: "INCONCLUSIVE (confidence interval straddles the 1.25x threshold)" };
  }
  return { exitCode: 0, reason: "overall PASS (both corpora present, all ratios PASS, lifecycle 4/4)" };
}

// ---------------------------------------------------------------------------
// Markdown rendering + artifact writer.
// ---------------------------------------------------------------------------

function formatNs(value: number): string {
  return `${(value / 1_000_000).toFixed(3)}ms`;
}

function formatRatio(value: number): string {
  return value.toFixed(4);
}

/** `n`/`p50` per arm, derived from raw pairs when the caller supplied them; `undefined` fields render as "n/a" ­— hand-built RatioVerdict fixtures never carry raw pairs. */
function pairSummary(pairs: SchedulePair[] | undefined): { n?: number; p50Kernel?: number; p50Sqlite?: number } {
  if (!pairs || pairs.length === 0) return {};
  return {
    n: pairs.length,
    p50Kernel: nearestRankDistribution(pairs.map((pair) => pair.kernel.callerWallNs)).p50,
    p50Sqlite: nearestRankDistribution(pairs.map((pair) => pair.sqlite.callerWallNs)).p50
  };
}

function renderRatioRow(corpusLabel: string, mode: "cold" | "warm", verdict: RatioVerdict, pairs?: SchedulePair[]): string {
  const { n, p50Kernel, p50Sqlite } = pairSummary(pairs);
  const cells = [
    corpusLabel,
    mode,
    n !== undefined ? String(n) : "n/a",
    p50Kernel !== undefined ? formatNs(p50Kernel) : "n/a",
    p50Sqlite !== undefined ? formatNs(p50Sqlite) : "n/a",
    formatNs(verdict.p95Kernel),
    formatNs(verdict.p95Sqlite),
    formatRatio(verdict.pointRatio),
    formatRatio(verdict.ucb95),
    formatRatio(verdict.lcb95),
    verdict.state
  ];
  return `| ${cells.join(" | ")} |`;
}

function renderMemoryRow(verdict: MemoryVerdict): string {
  const cells = [
    verdict.arm,
    String(verdict.baseline),
    String(verdict.medium),
    String(verdict.big1k),
    verdict.absoluteCapPass ? "yes" : "no",
    formatRatio(verdict.growthAdjusted),
    verdict.growthPass ? "yes" : "no",
    verdict.state
  ];
  return `| ${cells.join(" | ")} |`;
}

function renderCorpusSection(label: string, report: Gate3CorpusReport): string[] {
  const lines: string[] = [];
  lines.push(`### ${label}`, "");
  lines.push(...renderCorpusProvenance(report));
  lines.push(
    "| Corpus | Mode | n | p50(kernel) | p50(sqlite) | p95(kernel) | p95(sqlite) | ratio | ucb95 | lcb95 | state |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    renderRatioRow(label, "cold", report.cold, report.coldPairs),
    renderRatioRow(label, "warm", report.warm, report.warmPairs),
    ""
  );
  lines.push(
    `Warm trend: firstHalfP95Ratio=${formatRatio(report.warmTrend.firstHalfP95Ratio)}, ` +
      `lastHalfP95Ratio=${formatRatio(report.warmTrend.lastHalfP95Ratio)}`,
    ""
  );
  lines.push(
    "| Memory arm | baseline | medium | big1k | absoluteCapPass | growthAdjusted | growthPass | state |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    renderMemoryRow(report.memory.kernel),
    renderMemoryRow(report.memory.sqlite),
    ""
  );
  lines.push(
    `Lifecycle-call parity: kernel=${report.lifecycle.kernel}, sqlite=${report.lifecycle.sqlite} ` +
      `(${report.lifecycle.kernel === 4 && report.lifecycle.sqlite === 4 ? "4-vs-4" : "MISMATCH"})`,
    ""
  );
  if (report.server) {
    lines.push(
      `Server characterization (metrics-on, non-dispositive): submit p95=${formatNs(report.server.submit.p95)}, ` +
        `advance p95=${formatNs(report.server.advance.p95)}, daemonRss=${report.server.daemonRss}B, ` +
        `workerRss=${report.server.workerRss}B`,
      ""
    );
  }
  return lines;
}

function renderProvenanceHeader(provenance: Provenance): string[] {
  return [
    "## Provenance",
    "",
    `- HEAD sha: \`${provenance.headSha}\` (dirty: ${provenance.dirty})`,
    `- Harness digest: \`${provenance.harnessDigest}\``,
    `- Daemon binary sha: \`${provenance.daemonBinarySha}\``,
    `- OS: ${provenance.os} / CPU: ${provenance.cpu}`,
    `- Node: ${provenance.nodeVersion} / Rust: ${provenance.rustVersion}`,
    `- Schedule seed: ${provenance.scheduleSeed ?? "n/a"}`,
    `- Metrics mode: ${provenance.metricsMode ?? "n/a"}`,
    `- Timestamp: ${provenance.timestamp ?? "n/a"}`,
    ""
  ];
}

/** Per-corpus identity + per-mode schedule provenance lines (obligation 1), rendered when the caller attached them. */
function renderCorpusProvenance(report: Gate3CorpusReport): string[] {
  const lines: string[] = [];
  if (report.corpusInfo) {
    lines.push(
      `Corpus: digest \`${report.corpusInfo.digest}\`, ${report.corpusInfo.moduleCount} modules, ` +
        `${report.corpusInfo.copies} cop${report.corpusInfo.copies === 1 ? "y" : "ies"}`,
      ""
    );
  }
  if (report.schedules) {
    const fmt = (label: string, s: ScheduleProvenance): string =>
      `- ${label}: seed ${s.seed}, N=${s.n} (per arm), realized order ${s.realizedOrder.join("")}`;
    lines.push("Schedules (N is pairs; each pair = 1 kernel + 1 sqlite sample):");
    lines.push(fmt("cold", report.schedules.cold), fmt("warm", report.schedules.warm));
    if (report.schedules.baseline) lines.push(fmt("baseline", report.schedules.baseline));
    lines.push("");
  }
  return lines;
}

/**
 * The decisive number(s) for the verdict banner: for a FAIL, the driving
 * `lcb95` of the worst-state corpus/mode (the falsifying lower bound); for
 * a PASS or INCONCLUSIVE, the driving `ucb95`. "Driving" = the corpus/mode
 * whose own state equals the overall verdict, preferring `big1k` over
 * `medium` (the decisive corpus) and `warm` over `cold` when both modes of
 * the chosen corpus match.
 */
function decisiveRatioVerdict(report: Gate3Report): RatioVerdict {
  const candidates: Array<{ corpus: Gate3CorpusReport; mode: "cold" | "warm" }> = [];
  if (report.big1k) {
    candidates.push({ corpus: report.big1k, mode: "warm" }, { corpus: report.big1k, mode: "cold" });
  }
  candidates.push({ corpus: report.medium, mode: "warm" }, { corpus: report.medium, mode: "cold" });

  const matching = candidates.find(({ corpus, mode }) => corpus[mode].state === report.verdict);
  const chosen = matching ?? candidates[0]!;
  return chosen.corpus[chosen.mode];
}

/**
 * `true` iff the overall verdict is `FAIL` but NO cold/warm ratio candidate
 * (across whichever corpora are present) is itself in state `FAIL` — i.e. the
 * FAIL is driven purely by a `MemoryVerdict` (see `corpusState`'s worst-of-four
 * derivation, which folds memory into the tri-state). In that case
 * `decisiveRatioVerdict`'s fallback (`candidates[0]`, since nothing matches
 * `report.verdict`) would pick an arbitrary ratio candidate that is NOT itself
 * failing — rendering its `lcb95` as "> 1.25" would misrepresent a
 * non-falsifying number as the falsifier. Callers must check this before
 * trusting `decisiveRatioVerdict`'s `lcb95` as "the falsifying bound".
 */
function isMemoryDrivenFail(report: Gate3Report): boolean {
  if (report.verdict !== "FAIL") return false;
  const ratioStates: RatioVerdictState[] = [report.medium.cold.state, report.medium.warm.state];
  if (report.big1k) ratioStates.push(report.big1k.cold.state, report.big1k.warm.state);
  return !ratioStates.includes("FAIL");
}

/**
 * Renders the full Markdown artifact: a provenance header, one
 * `(corpus, mode)` row per present corpus with n/p50/p95, ratio, UCB/LCB and
 * tri-state, a memory block, lifecycle parity, and a verdict banner that
 * literally names the overall verdict and its measured UCB (or, for a FAIL,
 * the measured LCB that falsified it).
 */
export function renderGate3Markdown(report: Gate3Report): string {
  const memoryDrivenFail = isMemoryDrivenFail(report);
  const bannerMetric = memoryDrivenFail
    ? "driven by memory verdict (no ratio candidate itself failed — see the Memory arm table(s) below)"
    : report.verdict === "FAIL"
      ? `measured LCB ${formatRatio(decisiveRatioVerdict(report).lcb95)} > 1.25`
      : `measured UCB ${formatRatio(decisiveRatioVerdict(report).ucb95)}`;

  const lines: string[] = [
    "# Gate 3 — unkeyed noninferiority profile (kernel vs SQLite, key-free)",
    "",
    `## Verdict: ${report.verdict} (${bannerMetric})`,
    ""
  ];
  lines.push(...renderProvenanceHeader(report.provenance));
  lines.push(...renderCorpusSection("medium", report.medium));
  if (report.big1k) {
    lines.push(...renderCorpusSection("big1k", report.big1k));
  }
  return lines.join("\n");
}

/**
 * Writes the JSON (the full `Gate3Report` object — every raw sample the
 * caller attached via `coldPairs`/`warmPairs`, plus full `provenance` —
 * verbatim, nothing summarized away) and Markdown artifacts. Default names
 * are timestamped for local gitignored reruns; `{ deterministicName: true }`
 * yields the fixed `gate3-noninferiority-profile.{json,md}` names the
 * operator script commits under `docs/spikes/`.
 */
export function writeGate3Artifacts(
  report: Gate3Report,
  outDir: string,
  options?: { deterministicName?: boolean; requireRawPairs?: boolean }
): { jsonPath: string; markdownPath: string } {
  // Task 8 (Task-7 review obligation 2): on the REAL artifact path
  // (`run-big.ts` passes `requireRawPairs: true`), every present corpus MUST
  // carry non-empty coldPairs/warmPairs — a committed artifact that renders
  // "n/a" for n is not acceptable. Fixture-only unit writes never set this flag.
  if (options?.requireRawPairs) {
    const corpora: Array<{ label: string; corpus: Gate3CorpusReport }> = [{ label: "medium", corpus: report.medium }];
    if (report.big1k) corpora.push({ label: "big1k", corpus: report.big1k });
    for (const { label, corpus } of corpora) {
      if (!corpus.coldPairs || corpus.coldPairs.length === 0) {
        throw new Error(`writeGate3Artifacts: ${label}.coldPairs is empty — raw pairs are mandatory on the committed artifact`);
      }
      if (!corpus.warmPairs || corpus.warmPairs.length === 0) {
        throw new Error(`writeGate3Artifacts: ${label}.warmPairs is empty — raw pairs are mandatory on the committed artifact`);
      }
    }
  }
  mkdirSync(outDir, { recursive: true });
  const base = options?.deterministicName
    ? "gate3-noninferiority-profile"
    : `gate3-profile-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const jsonPath = join(outDir, `${base}.json`);
  const markdownPath = join(outDir, `${base}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, `${renderGate3Markdown(report)}\n`, "utf8");
  return { jsonPath, markdownPath };
}
