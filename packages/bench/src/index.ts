/**
 * @strata-code/bench — the Phase 4 T03 benchmark harness: substrate
 * (runAgentTask/runAgentT03) vs. file-based baseline, N trials each,
 * scored through provably-equivalent text-criteria cores and reported as
 * distributions.
 *
 * The shared T03 scorer core intentionally stays in @strata-code/verify and is
 * imported through that package's barrel. Moving it here would create a
 * verify/agent/bench cycle, so do not "tidy" evaluateT03TextCriteria into
 * this package.
 *
 * The live round is the operator-only `bench:t03` script, never a vitest
 * test.
 */
export const BENCH_PACKAGE = "@strata-code/bench" as const;
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
  isTaskSharedSuccess,
  readModuleMap,
  scoreBaselineTask,
  scoreBaselineWorkingTree,
  scoreSharedCriteria,
  scoreTaskSharedCriteria,
  type ScoreInput,
  type SharedCriteria,
  type TaskSharedCriteria
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
  runSubstrateTaskTrial,
  runSubstrateTrial,
  type ExtractSubstrateInput,
  type RunSubstrateTrialParams
} from "./configs/substrate";
export {
  BASELINE_TOOLS,
  baselinePrompt,
  materializeCorpus,
  runBaselineTaskTrial,
  runBaselineTrial,
  scoreBaselineTrial,
  type MaterializeCorpusOptions,
  type RunBaselineTrialParams,
  type ScoreBaselineTrialInput
} from "./configs/baseline";
export {
  buildReport,
  buildSuiteReport,
  renderMarkdown,
  renderSuiteMarkdown,
  type BenchmarkReport,
  type SuiteReport
} from "./report";
export {
  DEFAULT_PER_TASK_BUDGET,
  parseTaskBudget,
  resolveTaskBudget,
  runBenchmark,
  type PerTaskBudget,
  type RunBenchmarkParams,
  type RunBenchmarkResult,
  type TaskBudget
} from "./runner";
export {
  renderStoreToDir,
  resolveCorpusTsconfigInclude,
  resolveTscProgramRootNames,
  assertSrcOnlyScope,
  tscNoEmit,
  tscNoEmitSrc,
  vitestRun,
  type QualityResult
} from "./quality";
export {
  ALL_TASK_IDS,
  BENCH_TASKS,
  type BenchTask,
  type BenchTaskId,
  type BenchTaskRunParams
} from "./tasks";
export {
  renderDogfoodMarkdown,
  runDogfoodL1,
  type DogfoodArm,
  type DogfoodArmCost,
  type DogfoodL1Result,
  type RunDogfoodL1Params
} from "./dogfoodL1";
export {
  L3_TASK_A_PROMPT,
  L3_TASK_B_PROMPT,
  renderDogfoodL3Markdown,
  runDogfoodL3,
  type DogfoodL3Arm,
  type DogfoodL3ArmCost,
  type DogfoodL3Result,
  type RunDogfoodL3Params
} from "./dogfoodL3";
