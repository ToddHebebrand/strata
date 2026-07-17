import { REGISTERED_INTEGRATION_ROLE_BOUNDS, REGISTERED_TASK_ROLE_BOUNDS, type BaselineRoleBounds } from "./baseline.js";
import { createSchedule, type ExperimentSchedule } from "./schedule.js";

/** Pre-registered failure taxonomy (design § Failure taxonomy). */
export const FAILURE_TAXONOMY = Object.freeze({
  dispositive: Object.freeze([
    "lost_update",
    "dirty_read",
    "partial_commit",
    "stale_publication",
    "invalid_final_code",
    "task_predicate_missing",
    "manual_intervention",
    "authority_escape",
    "canonical_history_mismatch",
    "unexpected_out_of_scope_change"
  ] as const),
  coordination: Object.freeze([
    "task_agent_timeout",
    "integration_agent_timeout",
    "team_timeout",
    "max_turns",
    "max_budget",
    "needs_decision_unresolved",
    "candidate_validation_failed",
    "integration_failed",
    "dynamic_scenario_not_exercised"
  ] as const),
  infrastructure: Object.freeze([
    "provider_unavailable",
    "provider_rate_limited",
    "agent_process_crash",
    "service_process_crash",
    "artifact_write_failed",
    "harness_invariant_failed",
    "verifier_infrastructure_failed"
  ] as const)
});

export type FailureClass = keyof typeof FAILURE_TAXONOMY;
export type FailureValue =
  | (typeof FAILURE_TAXONOMY.dispositive)[number]
  | (typeof FAILURE_TAXONOMY.coordination)[number]
  | (typeof FAILURE_TAXONOMY.infrastructure)[number];

export function classifyFailure(value: string): FailureClass {
  for (const failureClass of Object.keys(FAILURE_TAXONOMY) as FailureClass[]) {
    if ((FAILURE_TAXONOMY[failureClass] as readonly string[]).includes(value)) return failureClass;
  }
  throw new Error(`failure ${value} is not in the pre-registered taxonomy`);
}

/**
 * The symmetric team deadline must leave the reserve the design proved
 * necessary: full concurrent task phase plus full integration phase plus
 * 240,000 ms for capture, materialization, and the shared verifier.
 */
export function validateTeamDeadline(params: {
  taskWallMs: number;
  integrationWallMs: number;
  teamWallMs: number;
}): { reserveMs: number } {
  const reserveMs = params.teamWallMs - params.taskWallMs - params.integrationWallMs;
  if (reserveMs < 240_000) {
    throw new Error(
      `team deadline ${params.teamWallMs}ms is structurally insufficient: ` +
        `${params.taskWallMs}ms task + ${params.integrationWallMs}ms integration leaves ${reserveMs}ms ` +
        "for capture and common verification (240000ms required)"
    );
  }
  return { reserveMs };
}

export interface TeamSessionRecord {
  sessionId: string;
  role: "task-1" | "task-2" | "integration";
  startedMonoMs: number;
  endedMonoMs: number;
  numTurns: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  apiDurationMs: number;
  toolCalls: number;
  terminal: string;
  failures: string[];
}

export interface CoordinationCounters {
  freshDecisions: number;
  requeues: number;
  scopeExpansions: number;
  publicationGenerations: number;
}

export interface IntegrationCounters {
  mergeConflicts: number;
  repairEdits: number;
  changedPaths: number;
}

export interface TeamAccounting {
  arm: "strata" | "baseline";
  status: "success" | "failed";
  makespanMs: number;
  totalAgentCostUsd: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  apiDurationMs: number;
  toolCalls: number;
  budgetTerminals: number;
  taxonomyCounts: Partial<Record<FailureValue, number>>;
  dynamicScopeObserved: boolean;
  dispositiveStop: boolean;
  verificationGreen: boolean | null;
  coordination?: CoordinationCounters;
  integration?: IntegrationCounters;
  sessions: TeamSessionRecord[];
}

export function computeTeamAccounting(params: {
  arm: "strata" | "baseline";
  teamWallMs: number;
  sessions: TeamSessionRecord[];
  verificationEndedMonoMs: number;
  /** Result of the arm-neutral final verifier; null if the arm died before it ran. */
  verification: { green: boolean } | null;
  kernelEventKinds: readonly string[];
  coordination?: CoordinationCounters;
  integration?: IntegrationCounters;
}): TeamAccounting {
  const taxonomyCounts: Partial<Record<FailureValue, number>> = {};
  const count = (value: string): void => {
    classifyFailure(value);
    taxonomyCounts[value as FailureValue] = (taxonomyCounts[value as FailureValue] ?? 0) + 1;
  };
  for (const session of params.sessions) {
    for (const failure of session.failures) count(failure);
  }
  if (params.verification !== null && !params.verification.green) count("invalid_final_code");

  const makespanMs = Math.max(
    params.verificationEndedMonoMs,
    ...params.sessions.map((session) => session.endedMonoMs)
  );
  if (makespanMs > params.teamWallMs) count("team_timeout");

  const budgetTerminals = params.sessions.filter((session) => session.terminal === "max_budget").length;
  const dispositiveStop = Object.keys(taxonomyCounts).some(
    (value) => classifyFailure(value) === "dispositive"
  );
  const status: TeamAccounting["status"] = Object.keys(taxonomyCounts).length === 0 ? "success" : "failed";
  const sum = (select: (session: TeamSessionRecord) => number): number =>
    params.sessions.reduce((total, session) => total + select(session), 0);

  return {
    arm: params.arm,
    status,
    makespanMs,
    totalAgentCostUsd: sum((session) => session.totalCostUsd),
    numTurns: sum((session) => session.numTurns),
    inputTokens: sum((session) => session.inputTokens),
    outputTokens: sum((session) => session.outputTokens),
    cacheReadInputTokens: sum((session) => session.cacheReadInputTokens),
    cacheCreationInputTokens: sum((session) => session.cacheCreationInputTokens),
    apiDurationMs: sum((session) => session.apiDurationMs),
    toolCalls: sum((session) => session.toolCalls),
    budgetTerminals,
    taxonomyCounts,
    dynamicScopeObserved: params.kernelEventKinds.includes("scope_expanded"),
    dispositiveStop,
    verificationGreen: params.verification?.green ?? null,
    ...(params.coordination ? { coordination: params.coordination } : {}),
    ...(params.integration ? { integration: params.integration } : {}),
    sessions: [...params.sessions]
  };
}

const RERUNNABLE_FAILURES: readonly string[] = ["provider_unavailable", "provider_rate_limited"];

/**
 * One rerun is permitted only for a provider outage or rate limit that
 * produced no assistant content, no tool call, no source/canonical mutation,
 * and no billable result. Every other failure class — including service
 * crashes, harness invariants, and verifier failures — is never rerunnable.
 * The original attempt remains an artifact.
 */
export function permitProviderRerun(attempt: {
  failureValue: string;
  assistantTextCount: number;
  toolCallCount: number;
  mutatedSource: boolean;
  billedUsd: number;
  priorRerunsForSession: number;
}): boolean {
  classifyFailure(attempt.failureValue);
  return (
    RERUNNABLE_FAILURES.includes(attempt.failureValue) &&
    attempt.priorRerunsForSession === 0 &&
    attempt.assistantTextCount === 0 &&
    attempt.toolCallCount === 0 &&
    !attempt.mutatedSource &&
    attempt.billedUsd === 0
  );
}

export interface RoundPlan {
  plannedSessions: number;
  plannedTrials: number;
  summedQueryBudgetsUsd: number;
  projectedMaxUsd: number;
  schedule: ExperimentSchedule;
}

function boundsEqual(actual: BaselineRoleBounds, registered: BaselineRoleBounds): boolean {
  return (
    actual.maxTurns === registered.maxTurns &&
    actual.wallTimeMs === registered.wallTimeMs &&
    actual.maxBudgetUsd === registered.maxBudgetUsd
  );
}

export function planRound(params: {
  trialsPerScenario: number;
  seed: string;
  taskRoleBounds: BaselineRoleBounds;
  integrationRoleBounds: BaselineRoleBounds;
  teamWallMs: number;
  projectedMaxUsd: number;
}): RoundPlan {
  if (
    !boundsEqual(params.taskRoleBounds, REGISTERED_TASK_ROLE_BOUNDS) ||
    !boundsEqual(params.integrationRoleBounds, REGISTERED_INTEGRATION_ROLE_BOUNDS)
  ) {
    throw new Error("per-trial bound drift invalidates the registered manifest");
  }
  validateTeamDeadline({
    taskWallMs: params.taskRoleBounds.wallTimeMs,
    integrationWallMs: params.integrationRoleBounds.wallTimeMs,
    teamWallMs: params.teamWallMs
  });
  const schedule = createSchedule({ seed: params.seed, trialsPerScenario: params.trialsPerScenario });
  const matchedTrials = schedule.entries.length;
  const taskSessions = matchedTrials * 4;
  const integrationSessions = matchedTrials;
  const plannedSessions = taskSessions + integrationSessions;
  const summedQueryBudgetsUsd =
    taskSessions * params.taskRoleBounds.maxBudgetUsd +
    integrationSessions * params.integrationRoleBounds.maxBudgetUsd;
  if (params.projectedMaxUsd < summedQueryBudgetsUsd) {
    throw new Error(
      `projected round maximum USD ${params.projectedMaxUsd.toFixed(2)} is below the ` +
        `summed per-query budgets USD ${summedQueryBudgetsUsd.toFixed(2)}`
    );
  }
  return {
    plannedSessions,
    plannedTrials: matchedTrials,
    summedQueryBudgetsUsd,
    projectedMaxUsd: params.projectedMaxUsd,
    schedule
  };
}
