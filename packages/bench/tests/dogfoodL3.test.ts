import { describe, expect, it } from "vitest";
import {
  L3_TASK_A_PROMPT,
  L3_TASK_B_PROMPT,
  renderDogfoodL3Markdown,
  type DogfoodL3Result
} from "../src/dogfoodL3";

function fixture(overrides: Partial<DogfoodL3Result> = {}): DogfoodL3Result {
  const base: DogfoodL3Result = {
    corpusRoot: "/tmp/medium",
    dbPath: "/tmp/medium.db",
    model: "claude-sonnet-4-6",
    maxTurns: 40,
    wallTimeMs: 300000,
    armA: {
      label: "A-cold",
      prompt: L3_TASK_A_PROMPT,
      terminalReason: "success",
      lastCommitOk: true,
      newOperationsCount: 1,
      commitPatternEmbedded: true,
      pastTasksInjectedCount: 0,
      cost: {
        totalTokens: 1500,
        inputTokens: 10,
        outputTokens: 1490,
        cacheReadInputTokens: 50000,
        cacheCreationInputTokens: 10000,
        wallMs: 30000,
        apiMs: 25000,
        numTurns: 10,
        toolCalls: 9,
        costUsd: 0.06
      }
    },
    armB: {
      label: "B-after-A",
      prompt: L3_TASK_B_PROMPT,
      terminalReason: "success",
      lastCommitOk: true,
      newOperationsCount: 1,
      commitPatternEmbedded: true,
      pastTasksInjectedCount: 1,
      cost: {
        totalTokens: 1000,
        inputTokens: 8,
        outputTokens: 992,
        cacheReadInputTokens: 60000,
        cacheCreationInputTokens: 4000,
        wallMs: 20000,
        apiMs: 17000,
        numTurns: 7,
        toolCalls: 6,
        costUsd: 0.04
      }
    },
    ratio: { totalTokens: 1000 / 1500, costUsd: 0.04 / 0.06 },
    acceptance: {
      bothCommitsOk: true,
      commitPatternEmbeddedInA: true,
      pastTasksInjectedInB: true,
      bCostBelowA: true
    }
  };
  return { ...base, ...overrides };
}

describe("renderDogfoodL3Markdown", () => {
  it("renders all four acceptance lines and the cost ratio", () => {
    const md = renderDogfoodL3Markdown(fixture());
    expect(md).toContain("Both arms succeeded: PASS");
    expect(md).toContain("L3 wrote in Arm A");
    expect(md).toContain("L3 retrieved in Arm B");
    expect(md).toContain("Cost compounding");
    expect(md).toContain("66.7%");
    expect(md).toContain("claude-sonnet-4-6");
  });

  it("flags FAIL when L3 didn't activate in Arm A", () => {
    const md = renderDogfoodL3Markdown(
      fixture({
        armA: { ...fixture().armA, commitPatternEmbedded: false },
        acceptance: {
          ...fixture().acceptance,
          commitPatternEmbeddedInA: false
        }
      })
    );
    expect(md).toContain("FAIL — L3 didn't activate");
  });

  it("flags FAIL when L3 retrieval was cold-start in Arm B", () => {
    const md = renderDogfoodL3Markdown(
      fixture({
        armB: { ...fixture().armB, pastTasksInjectedCount: 0 },
        acceptance: {
          ...fixture().acceptance,
          pastTasksInjectedInB: false
        }
      })
    );
    expect(md).toContain("FAIL — L3 cold-start path or retrieval failed");
  });

  it("flags FAIL on cost compounding when B is more expensive than A", () => {
    const md = renderDogfoodL3Markdown(
      fixture({
        armB: {
          ...fixture().armB,
          cost: { ...fixture().armB.cost, costUsd: 0.08 }
        },
        ratio: { totalTokens: 0.67, costUsd: 0.08 / 0.06 },
        acceptance: {
          ...fixture().acceptance,
          bCostBelowA: false
        }
      })
    );
    expect(md).toContain("Cost compounding (B cost < A cost): FAIL");
  });

  it("notes the N=1 honest read and the two confounds", () => {
    const md = renderDogfoodL3Markdown(fixture());
    expect(md).toContain("N=1");
    expect(md.toLowerCase()).toContain("honest read");
    expect(md.toLowerCase()).toContain("confounds");
    expect(md.toLowerCase()).toContain("cache warmth");
  });
});
