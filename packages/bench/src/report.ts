import { aggregate, type ConfigAggregate, type TrialMetrics } from "./metrics";
import type { BenchTaskId } from "./tasks";

export interface BenchmarkReport {
  task: string;
  model: string;
  n: number;
  generatedAt: string;
  substrate: ConfigAggregate;
  baseline: ConfigAggregate;
  substrateTrials: TrialMetrics[];
  baselineTrials: TrialMetrics[];
  totalCostUsd: number;
  comparisonNote: string;
  retryRule: string;
  costNote: string;
}

const RETRY_RULE =
  'A "failure/retry" is one observed self-correction: a verification ' +
  "action that returned a negative result followed by at least one further " +
  "mutating action before the terminal result (substrate: failed validate / " +
  "commit_transaction:false; baseline: non-zero tsc/test run or re-edit of " +
  "an already-edited file).";

export function overlaps(a: number[], b: number[]): boolean {
  if (a.length === 0 || b.length === 0) {
    return true;
  }
  const aMin = Math.min(...a);
  const aMax = Math.max(...a);
  const bMin = Math.min(...b);
  const bMax = Math.max(...b);
  return aMin <= bMax && bMin <= aMax;
}

export function buildReport(input: {
  task: string;
  model: string;
  n: number;
  substrate: TrialMetrics[];
  baseline: TrialMetrics[];
  totalCostUsd: number;
}): BenchmarkReport {
  const substrate = aggregate("substrate", input.substrate);
  const baseline = aggregate("baseline", input.baseline);
  const tokenOverlap = overlaps(
    substrate.totalTokens.values,
    baseline.totalTokens.values
  );
  const comparisonNote =
    input.substrate.length < 3 || input.baseline.length < 3
      ? "N < 3 per config — distribution is indicative only, not a claim."
      : tokenOverlap
        ? "Total-token distributions overlap at this N — no separable signal; reported as the result, not massaged (BS-Bench-D)."
        : "Total-token distributions are separated at this N — see per-metric distributions below; this is not a significance claim, only an observed separation.";

  return {
    task: input.task,
    model: input.model,
    n: input.n,
    generatedAt: new Date().toISOString(),
    substrate,
    baseline,
    substrateTrials: input.substrate,
    baselineTrials: input.baseline,
    totalCostUsd: input.totalCostUsd,
    comparisonNote,
    retryRule: RETRY_RULE,
    costNote: `Round cost is ${2 * input.n} live runs (2 configs x N).`
  };
}

export interface SuiteReport {
  model: string;
  n: number;
  generatedAt: string;
  perTask: Record<string, BenchmarkReport>;
  patternHolds: boolean;
  patternNote: string;
  totalCostUsd: number;
}

const STRUCTURAL: BenchTaskId[] = ["T01", "T03", "T08"];
const CONTROL: BenchTaskId = "T05";

export function buildSuiteReport(input: {
  model: string;
  n: number;
  perTask: Record<
    string,
    { substrate: TrialMetrics[]; baseline: TrialMetrics[] }
  >;
  totalCostUsd: number;
}): SuiteReport {
  const perTask: Record<string, BenchmarkReport> = {};
  for (const [id, runs] of Object.entries(input.perTask)) {
    perTask[id] = buildReport({
      task: id,
      model: input.model,
      n: input.n,
      substrate: runs.substrate,
      baseline: runs.baseline,
      totalCostUsd:
        runs.substrate.reduce((sum, trial) => sum + trial.totalCostUsd, 0) +
        runs.baseline.reduce((sum, trial) => sum + trial.totalCostUsd, 0)
    });
  }

  const separates = (id: string): boolean =>
    perTask[id] !== undefined &&
    !overlaps(
      perTask[id].substrate.totalTokens.values,
      perTask[id].baseline.totalTokens.values
    );
  const structuralSeparate = STRUCTURAL.every((id) => separates(id));
  const controlSeparates = separates(CONTROL);

  return {
    model: input.model,
    n: input.n,
    generatedAt: new Date().toISOString(),
    perTask,
    patternHolds: structuralSeparate && !controlSeparates,
    patternNote:
      "The pattern holds iff the structural tasks (T01,T03,T08) separate AND " +
      "the control (T05) does not; overlapping structural tasks or a " +
      "separated control are reported as stated, not massaged.",
    totalCostUsd: input.totalCostUsd
  };
}

function dist(label: string, d: ConfigAggregate["totalTokens"]): string {
  if (d.n === 0) {
    return `- ${label}: (no trials)`;
  }
  return (
    `- ${label}: n=${d.n} min=${d.min} p25=${d.p25} ` +
    `median=${d.median} mean=${d.mean?.toFixed(1)} p75=${d.p75} ` +
    `max=${d.max} stddev=${d.stddev?.toFixed(2)} ` +
    `raw:[${d.values.join(", ")}]`
  );
}

export function renderMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push("# T03 Benchmark — substrate vs. baseline");
  lines.push("");
  lines.push(
    `Model: \`${report.model}\` · N per config: ${report.n} · generated ${report.generatedAt}`
  );
  lines.push(`Round total cost: $${report.totalCostUsd.toFixed(2)}`);
  lines.push(report.costNote);
  lines.push("");
  lines.push(`> ${report.comparisonNote}`);
  lines.push("");
  lines.push(`Retry rule: ${report.retryRule}`);
  lines.push("");

  for (const [name, aggregateForConfig] of [
    ["substrate", report.substrate] as const,
    ["baseline", report.baseline] as const
  ]) {
    lines.push(`## ${name}`);
    lines.push(
      `Success: ${aggregateForConfig.successCount}/${aggregateForConfig.trials} (rate ${(
        aggregateForConfig.successRate * 100
      ).toFixed(0)}%)`
    );
    lines.push(
      `Terminal reasons: ${JSON.stringify(
        aggregateForConfig.terminalReasonCounts
      )}`
    );
    lines.push(dist("totalTokens", aggregateForConfig.totalTokens));
    lines.push(dist("wallTimeMs", aggregateForConfig.wallTimeMs));
    lines.push(dist("toolInvocations", aggregateForConfig.toolInvocations));
    lines.push(dist("failuresRetries", aggregateForConfig.failuresRetries));
    lines.push(dist("totalCostUsd", aggregateForConfig.totalCostUsd));
    lines.push(
      `- resultQuality: tsc clean ${aggregateForConfig.resultQualityTscCleanCount}/${aggregateForConfig.trials}, vitest passed ${aggregateForConfig.resultQualityVitestPassedCount}/${aggregateForConfig.trials}`
    );
    if (aggregateForConfig.operationRowAppendedCount !== null) {
      lines.push(
        `- operationRowAppended (substrate-only sub-metric, NOT part of the shared bar): ${aggregateForConfig.operationRowAppendedCount}/${aggregateForConfig.trials}`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderSuiteMarkdown(report: SuiteReport): string {
  const lines: string[] = [];
  lines.push("# Phase 1.5 four-task benchmark - substrate vs. baseline");
  lines.push("");
  lines.push(
    `Model: \`${report.model}\` · N per config: ${report.n} · generated ${report.generatedAt}`
  );
  lines.push(`Round total cost: $${report.totalCostUsd.toFixed(2)}`);
  lines.push("");

  for (const [id, taskReport] of Object.entries(report.perTask)) {
    lines.push(`## ${id}`);
    lines.push(renderMarkdown(taskReport).split("\n").slice(2).join("\n"));
    lines.push("");
  }

  lines.push("## cross-task pattern");
  lines.push(report.patternNote);
  lines.push(
    `Observed: pattern ${report.patternHolds ? "HOLDS" : "does NOT hold"} ` +
      "at this N (an observed separation, not a significance claim)."
  );
  lines.push("");
  return lines.join("\n");
}
