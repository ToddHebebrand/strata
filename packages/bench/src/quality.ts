/**
 * The corpus runner was lowered into @strata/verify so the agent commit gate
 * and this benchmark scorer share one finish line by construction (see
 * docs/specs/2026-05-16-behavioral-commit-gate-design.md and the matching
 * decisions.md entry). This module is a thin re-export to keep every existing
 * `../quality` / `./quality` import site and bench behavior unchanged.
 */
export {
  renderStoreToDir,
  resolveCorpusTsconfigInclude,
  resolveTscProgramRootNames,
  assertSrcOnlyScope,
  tscNoEmit,
  tscNoEmitSrc,
  vitestRun,
  runCorpusAcceptance,
  behavioralFixturesForTask,
  type QualityResult,
  type CorpusAcceptanceResult
} from "@strata/verify";
