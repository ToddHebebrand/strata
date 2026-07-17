import { describe, expect, it } from "vitest";
import {
  FAILURE_TAXONOMY,
  classifyFailure,
  computeTeamAccounting,
  permitProviderRerun,
  planRound,
  validateTeamDeadline
} from "../src/runner.js";

const session = (overrides: Record<string, unknown> = {}) => ({
  sessionId: "session:1",
  role: "task-1",
  startedMonoMs: 0,
  endedMonoMs: 60_000,
  numTurns: 6,
  totalCostUsd: 0.2,
  inputTokens: 900,
  outputTokens: 300,
  terminal: "success",
  failures: [] as string[],
  ...overrides
});

describe("accounting, failure taxonomy, and deadlines", () => {
  it("classifies every pre-registered taxonomy value and rejects unknowns", () => {
    expect(FAILURE_TAXONOMY.dispositive).toHaveLength(10);
    expect(FAILURE_TAXONOMY.coordination).toHaveLength(9);
    expect(FAILURE_TAXONOMY.infrastructure).toHaveLength(7);
    for (const value of FAILURE_TAXONOMY.dispositive) expect(classifyFailure(value)).toBe("dispositive");
    for (const value of FAILURE_TAXONOMY.coordination) expect(classifyFailure(value)).toBe("coordination");
    for (const value of FAILURE_TAXONOMY.infrastructure) expect(classifyFailure(value)).toBe("infrastructure");
    expect(() => classifyFailure("random_noise")).toThrow(/pre-registered/);
  });

  it("proves the 900s symmetric deadline arithmetic and rejects 480s", () => {
    const verdict = validateTeamDeadline({
      taskWallMs: 240_000,
      integrationWallMs: 420_000,
      teamWallMs: 900_000
    });
    expect(verdict.reserveMs).toBe(240_000);
    expect(() => validateTeamDeadline({
      taskWallMs: 240_000,
      integrationWallMs: 420_000,
      teamWallMs: 480_000
    })).toThrow(/structurally insufficient/);
  });

  it("computes makespan and full team cost including the integration role", () => {
    const accounting = computeTeamAccounting({
      arm: "baseline",
      teamWallMs: 900_000,
      sessions: [
        session({ sessionId: "s1", role: "task-1", startedMonoMs: 0, endedMonoMs: 200_000, totalCostUsd: 0.4 }),
        session({ sessionId: "s2", role: "task-2", startedMonoMs: 0, endedMonoMs: 240_000, totalCostUsd: 0.75, terminal: "max_budget", failures: ["max_budget"] }),
        session({ sessionId: "s3", role: "integration", startedMonoMs: 260_000, endedMonoMs: 640_000, totalCostUsd: 2.9, numTurns: 22 })
      ],
      verificationEndedMonoMs: 830_000,
      kernelEventKinds: []
    });
    expect(accounting.makespanMs).toBe(830_000);
    expect(accounting.totalAgentCostUsd).toBeCloseTo(0.4 + 0.75 + 2.9, 10);
    expect(accounting.taxonomyCounts.max_budget).toBe(1);
    expect(accounting.budgetTerminals).toBe(1);
    expect(accounting.status).toBe("failed");
    expect(accounting.dispositiveStop).toBe(false);
    expect(accounting.sessions).toHaveLength(3);
  });

  it("flags team timeout, dispositive stop, and dynamic scope observation", () => {
    const timedOut = computeTeamAccounting({
      arm: "baseline",
      teamWallMs: 900_000,
      sessions: [session({ endedMonoMs: 400_000 })],
      verificationEndedMonoMs: 950_000,
      kernelEventKinds: []
    });
    expect(timedOut.taxonomyCounts.team_timeout).toBe(1);
    expect(timedOut.status).toBe("failed");

    const dispositive = computeTeamAccounting({
      arm: "strata",
      teamWallMs: 900_000,
      sessions: [session({ failures: ["lost_update"], terminal: "failure" })],
      verificationEndedMonoMs: 100_000,
      kernelEventKinds: ["intent_committed"]
    });
    expect(dispositive.dispositiveStop).toBe(true);

    const dynamic = computeTeamAccounting({
      arm: "strata",
      teamWallMs: 900_000,
      sessions: [session()],
      verificationEndedMonoMs: 100_000,
      kernelEventKinds: ["intent_ready", "scope_expanded", "intent_committed"]
    });
    expect(dynamic.dynamicScopeObserved).toBe(true);
    expect(timedOut.dynamicScopeObserved).toBe(false);
  });

  it("permits exactly one zero-output provider rerun and preserves the attempt", () => {
    const dead = {
      assistantTextCount: 0,
      toolCallCount: 0,
      mutatedSource: false,
      billedUsd: 0,
      priorRerunsForSession: 0
    };
    expect(permitProviderRerun(dead)).toBe(true);
    expect(permitProviderRerun({ ...dead, priorRerunsForSession: 1 })).toBe(false);
    expect(permitProviderRerun({ ...dead, assistantTextCount: 1 })).toBe(false);
    expect(permitProviderRerun({ ...dead, toolCallCount: 2 })).toBe(false);
    expect(permitProviderRerun({ ...dead, mutatedSource: true })).toBe(false);
    expect(permitProviderRerun({ ...dead, billedUsd: 0.01 })).toBe(false);

    const failed = computeTeamAccounting({
      arm: "baseline",
      teamWallMs: 900_000,
      sessions: [
        session({ sessionId: "attempt-1", terminal: "failure", failures: ["provider_unavailable"], totalCostUsd: 0 }),
        session({ sessionId: "attempt-2", startedMonoMs: 70_000, endedMonoMs: 130_000 })
      ],
      verificationEndedMonoMs: 200_000,
      kernelEventKinds: []
    });
    expect(failed.sessions.map((entry) => entry.sessionId)).toEqual(["attempt-1", "attempt-2"]);
    expect(failed.taxonomyCounts.provider_unavailable).toBe(1);
  });

  it("plans the pilot round exactly: 30 sessions and USD 42.00 in query budgets", () => {
    const plan = planRound({
      trialsPerScenario: 1,
      seed: "pilot-seed-1",
      taskRoleBounds: { maxTurns: 25, wallTimeMs: 240_000, maxBudgetUsd: 0.75 },
      integrationRoleBounds: { maxTurns: 40, wallTimeMs: 420_000, maxBudgetUsd: 4 },
      teamWallMs: 900_000,
      projectedMaxUsd: 55
    });
    expect(plan.plannedSessions).toBe(30);
    expect(plan.summedQueryBudgetsUsd).toBeCloseTo(42, 10);
    expect(plan.projectedMaxUsd).toBe(55);
    expect(plan.schedule.entries).toHaveLength(6);
    expect(() => planRound({
      trialsPerScenario: 1,
      seed: "pilot-seed-1",
      taskRoleBounds: { maxTurns: 25, wallTimeMs: 240_000, maxBudgetUsd: 0.75 },
      integrationRoleBounds: { maxTurns: 40, wallTimeMs: 420_000, maxBudgetUsd: 4 },
      teamWallMs: 900_000,
      projectedMaxUsd: 41
    })).toThrow(/projected/);
  });
});
