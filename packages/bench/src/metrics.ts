export type ConfigName = "substrate" | "baseline";

export type TerminalReason =
  | "success"
  | "error_max_turns"
  | "error_wall_time"
  | "error_during_execution"
  | "error_other";

/** One trial's measurements, matching spec § "Metrics & statistics". */
export interface TrialMetrics {
  config: ConfigName;
  trial: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  wallTimeMs: number;
  /** Harness Date.now() bracket, cross-check of SDK duration_ms. */
  harnessWallTimeMs: number;
  toolInvocations: number;
  failuresRetries: number;
  totalCostUsd: number;
  /** All ten shared criteria pass. */
  success: boolean;
  /** tsc --noEmit clean AND the corpus's own vitest passes. */
  resultQuality: { tscClean: boolean; vitestPassed: boolean };
  terminalReason: TerminalReason;
  /** Substrate-only sub-metric; null for baseline (spec fairness decision). */
  operationRowAppended: boolean | null;
}

/**
 * A numeric metric's distribution across trials. NEVER reduced to a bare
 * mean; the raw per-trial values are always carried. Empty input yields
 * nulls, never NaN.
 */
export interface Distribution {
  n: number;
  min: number | null;
  max: number | null;
  median: number | null;
  mean: number | null;
  p25: number | null;
  p75: number | null;
  stddev: number | null;
  /** Raw per-trial values in insertion order. */
  values: number[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) {
    return sorted[0]!;
  }
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) {
    return sorted[lo]!;
  }
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

export function distribution(values: number[]): Distribution {
  const n = values.length;
  if (n === 0) {
    return {
      n: 0,
      min: null,
      max: null,
      median: null,
      mean: null,
      p25: null,
      p75: null,
      stddev: null,
      values: []
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) /
    n;

  return {
    n,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    median: percentile(sorted, 0.5),
    mean,
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    stddev: Math.sqrt(variance),
    values: [...values]
  };
}

/** Per-config aggregate across that config's trials. */
export interface ConfigAggregate {
  config: ConfigName;
  trials: number;
  successCount: number;
  successRate: number;
  terminalReasonCounts: Record<string, number>;
  totalTokens: Distribution;
  wallTimeMs: Distribution;
  toolInvocations: Distribution;
  failuresRetries: Distribution;
  totalCostUsd: Distribution;
  resultQualityTscCleanCount: number;
  resultQualityVitestPassedCount: number;
  /** Substrate only; null when not applicable. */
  operationRowAppendedCount: number | null;
}

export function aggregate(
  config: ConfigName,
  trials: TrialMetrics[]
): ConfigAggregate {
  const terminalReasonCounts: Record<string, number> = {};
  for (const trial of trials) {
    terminalReasonCounts[trial.terminalReason] =
      (terminalReasonCounts[trial.terminalReason] ?? 0) + 1;
  }

  const successCount = trials.filter((trial) => trial.success).length;
  const opRows = trials
    .map((trial) => trial.operationRowAppended)
    .filter((value): value is boolean => value !== null);

  return {
    config,
    trials: trials.length,
    successCount,
    successRate: trials.length === 0 ? 0 : successCount / trials.length,
    terminalReasonCounts,
    totalTokens: distribution(trials.map((trial) => trial.totalTokens)),
    wallTimeMs: distribution(trials.map((trial) => trial.wallTimeMs)),
    toolInvocations: distribution(
      trials.map((trial) => trial.toolInvocations)
    ),
    failuresRetries: distribution(
      trials.map((trial) => trial.failuresRetries)
    ),
    totalCostUsd: distribution(trials.map((trial) => trial.totalCostUsd)),
    resultQualityTscCleanCount: trials.filter(
      (trial) => trial.resultQuality.tscClean
    ).length,
    resultQualityVitestPassedCount: trials.filter(
      (trial) => trial.resultQuality.vitestPassed
    ).length,
    operationRowAppendedCount:
      opRows.length === 0 ? null : opRows.filter((value) => value).length
  };
}
