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
import type { SchedulePair } from "./schedule.js";
import { nearestRankDistribution, type MemoryVerdict, type RatioVerdict, type RatioVerdictState } from "./stats.js";

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
    `- Timestamp: ${provenance.timestamp ?? "n/a"}`,
    ""
  ];
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
 * Renders the full Markdown artifact: a provenance header, one
 * `(corpus, mode)` row per present corpus with n/p50/p95, ratio, UCB/LCB and
 * tri-state, a memory block, lifecycle parity, and a verdict banner that
 * literally names the overall verdict and its measured UCB (or, for a FAIL,
 * the measured LCB that falsified it).
 */
export function renderGate3Markdown(report: Gate3Report): string {
  const decisive = decisiveRatioVerdict(report);
  const bannerMetric =
    report.verdict === "FAIL"
      ? `measured LCB ${formatRatio(decisive.lcb95)} > 1.25`
      : `measured UCB ${formatRatio(decisive.ucb95)}`;

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
  options?: { deterministicName?: boolean }
): { jsonPath: string; markdownPath: string } {
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
