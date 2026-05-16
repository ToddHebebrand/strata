/**
 * Single source of truth: which behavioral fixture(s) a benchmark task's
 * commit gate / scorer must run. The gate runs ONLY these (an empty list =>
 * tsc-only, nothing behavioral to assert). This replaces the previous
 * whole-suite scope that made the shared multi-task corpus unsatisfiable
 * per-task (decisions.md 2026-05-16, BG-4).
 *
 * T03 (rename) and T08 (change_return_type) have no behavioral-only failure
 * mode — tsc + text criteria fully constrain them — so they map to []. Only
 * T01 and T05 ship a real behavioral fixture.
 */
export const TASK_BEHAVIORAL_FIXTURES: Record<string, readonly string[]> = {
  T01: ["tests/format.test.ts"],
  T03: [],
  T05: ["tests/dateRange.test.ts"],
  T08: []
};

/**
 * Resolve a task's behavioral fixture list. Fail-loud on an unknown id: a
 * new task MUST register here deliberately and is never silently treated as
 * whole-suite or as empty (that silent default is exactly the BG-4 defect).
 */
export function behavioralFixturesForTask(
  taskId: string
): readonly string[] {
  if (!Object.prototype.hasOwnProperty.call(TASK_BEHAVIORAL_FIXTURES, taskId)) {
    throw new Error(
      `behavioralFixturesForTask: unknown task id: ${taskId}`
    );
  }
  return TASK_BEHAVIORAL_FIXTURES[taskId];
}
