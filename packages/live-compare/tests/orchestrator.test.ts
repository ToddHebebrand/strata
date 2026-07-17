import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createArtifactRun } from "../src/artifacts.js";
import { runComparisonRound, type ArmExecutionResult } from "../src/orchestrator.js";
import { planRound } from "../src/runner.js";
import type { ScheduledTrial } from "../src/schedule.js";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function artifactsRun() {
  const root = join(mkdtempSync(join(tmpdir(), "strata-orchestrator-")), "run");
  temporary.push(join(root, ".."));
  let mono = 0;
  return {
    root,
    run: createArtifactRun({
      root,
      clock: { wallMs: () => 1_700_000_000_000 + (mono += 100), monoMs: () => mono },
      redactions: []
    })
  };
}

function plan() {
  return planRound({
    trialsPerScenario: 1,
    seed: "pilot-seed-1",
    taskRoleBounds: { maxTurns: 25, wallTimeMs: 240_000, maxBudgetUsd: 0.75 },
    integrationRoleBounds: { maxTurns: 40, wallTimeMs: 420_000, maxBudgetUsd: 4 },
    teamWallMs: 900_000,
    projectedMaxUsd: 55
  });
}

function armResult(costUsd: number, overrides: Partial<ArmExecutionResult["accounting"]> = {}): ArmExecutionResult {
  return {
    accounting: {
      arm: "strata",
      status: "success",
      makespanMs: 120_000,
      totalAgentCostUsd: costUsd,
      numTurns: 12,
      inputTokens: 2_000,
      outputTokens: 700,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      apiDurationMs: 40_000,
      toolCalls: 15,
      budgetTerminals: 0,
      taxonomyCounts: {},
      dynamicScopeObserved: false,
      dispositiveStop: false,
      verificationGreen: true,
      sessions: [],
      ...overrides
    },
    verification: null,
    evidence: { "final-tree/note.txt": `arm cost ${costUsd}\n` }
  };
}

describe("comparison round orchestrator", () => {
  it("runs every trial in schedule order, both arms per pre-registered order, and finalizes", async () => {
    const { root, run } = artifactsRun();
    const executed: string[] = [];
    const outcome = await runComparisonRound({
      plan: plan(),
      artifacts: run,
      executeStrataArm: async (entry: ScheduledTrial) => { executed.push(`${entry.trialId}:strata`); return armResult(0.5); },
      executeBaselineArm: async (entry: ScheduledTrial) => { executed.push(`${entry.trialId}:baseline`); return armResult(1.5); }
    });
    expect(outcome.stopped).toBeNull();
    expect(outcome.completedTrials).toBe(6);
    expect(outcome.completedArms).toBe(12);
    expect(outcome.totalCostUsd).toBeCloseTo(6 * 2, 10);
    expect(executed).toHaveLength(12);
    const schedule = plan().schedule;
    for (const [index, entry] of schedule.entries.entries()) {
      const first = executed[index * 2]!;
      expect(first).toBe(`${entry.trialId}:${entry.armOrder === "strata-first" ? "strata" : "baseline"}`);
    }
    expect(existsSync(join(root, "finalized.json"))).toBe(true);
    expect(existsSync(join(root, `trials/${schedule.entries[0]!.trialId}/strata/team.json`))).toBe(true);
    expect(existsSync(join(root, `trials/${schedule.entries[5]!.trialId}/baseline/evidence/final-tree/note.txt`))).toBe(true);
    const summary = JSON.parse(readFileSync(join(root, "summary.json"), "utf8"));
    expect(summary.trialsRecorded).toBe(6);
  });

  it("stops before consuming another arm once accumulated cost reaches the round maximum", async () => {
    const { run } = artifactsRun();
    let calls = 0;
    const outcome = await runComparisonRound({
      plan: plan(),
      artifacts: run,
      executeStrataArm: async () => { calls += 1; return armResult(30); },
      executeBaselineArm: async () => { calls += 1; return armResult(30); }
    });
    expect(outcome.stopped).toBe("round_maximum_reached");
    expect(calls).toBe(2);
    expect(outcome.totalCostUsd).toBe(60);
  });

  it("stops immediately after a dispositive failure with evidence flushed", async () => {
    const { root, run } = artifactsRun();
    let calls = 0;
    const outcome = await runComparisonRound({
      plan: plan(),
      artifacts: run,
      executeStrataArm: async () => {
        calls += 1;
        return armResult(0.5, { status: "failed", dispositiveStop: true, taxonomyCounts: { lost_update: 1 } });
      },
      executeBaselineArm: async () => { calls += 1; return armResult(1); }
    });
    expect(outcome.stopped).toBe("dispositive_failure");
    expect(calls).toBeLessThanOrEqual(2);
    expect(outcome.failures).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(root, "finalized.json"))).toBe(true);
  });
});
