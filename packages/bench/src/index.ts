/**
 * @strata/bench — the Phase 4 T03 benchmark harness: substrate
 * (runAgentT03) vs. file-based baseline, N trials each, scored through
 * one provably-equivalent text-criteria core, reported as distributions.
 *
 * The shared T03 scorer core intentionally stays in @strata/verify and is
 * imported through that package's barrel. Moving it here would create a
 * verify/agent/bench cycle, so do not "tidy" evaluateT03TextCriteria into
 * this package.
 *
 * The live round is the operator-only `bench:t03` script, never a vitest
 * test.
 */
export const BENCH_PACKAGE = "@strata/bench" as const;
export {
  aggregate,
  distribution,
  type ConfigAggregate,
  type ConfigName,
  type Distribution,
  type TerminalReason,
  type TrialMetrics
} from "./metrics";
export {
  isSharedSuccess,
  readModuleMap,
  scoreBaselineWorkingTree,
  scoreSharedCriteria,
  type ScoreInput,
  type SharedCriteria
} from "./score";
export {
  countBaselineRetries,
  countSubstrateRetries,
  type BaselineToolEvent,
  type SubstrateToolEvent
} from "./retry";
export {
  collectBaselineSession,
  type BaselineResultCapture,
  type BaselineSession,
  type BaselineToolEvent as BaselineSessionToolEvent
} from "./session";
export {
  extractSubstrateMetrics,
  runSubstrateTrial,
  type ExtractSubstrateInput,
  type RunSubstrateTrialParams
} from "./configs/substrate";
export {
  BASELINE_TOOLS,
  baselinePrompt,
  materializeCorpus,
  runBaselineTrial,
  scoreBaselineTrial,
  type MaterializeCorpusOptions,
  type RunBaselineTrialParams,
  type ScoreBaselineTrialInput
} from "./configs/baseline";
export {
  buildReport,
  renderMarkdown,
  type BenchmarkReport
} from "./report";
export {
  runBenchmark,
  type RunBenchmarkParams,
  type RunBenchmarkResult
} from "./runner";
export {
  renderStoreToDir,
  tscNoEmit,
  vitestRun,
  type QualityResult
} from "./quality";
export { defaultSubstrateResultQuality } from "./configs/substrate";
