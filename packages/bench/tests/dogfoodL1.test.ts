import { describe, expect, it } from "vitest";
import {
  renderDogfoodMarkdown,
  type DogfoodL1Result
} from "../src/dogfoodL1";

function fixture(
  overrides: Partial<DogfoodL1Result> = {}
): DogfoodL1Result {
  const base: DogfoodL1Result = {
    corpusRoot: "/tmp/medium",
    prompt: "T05 prompt body",
    taskId: "T05",
    model: "claude-sonnet-4-6",
    maxTurns: 40,
    wallTimeMs: 300000,
    armOrder: ["index-off", "index-on"],
    armOff: {
      label: "index-off",
      injectModuleIndex: false,
      terminalReason: "success",
      lastCommitOk: true,
      newOperationsCount: 2,
      moduleIndexChars: 0,
      moduleIndexLines: 0,
      cost: {
        totalTokens: 10000,
        inputTokens: 8000,
        outputTokens: 2000,
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 500,
        wallMs: 60000,
        apiMs: 50000,
        numTurns: 20,
        toolCalls: 25,
        costUsd: 0.05
      }
    },
    armOn: {
      label: "index-on",
      injectModuleIndex: true,
      terminalReason: "success",
      lastCommitOk: true,
      newOperationsCount: 1,
      moduleIndexChars: 980,
      moduleIndexLines: 24,
      cost: {
        totalTokens: 6000,
        inputTokens: 5000,
        outputTokens: 1000,
        cacheReadInputTokens: 3000,
        cacheCreationInputTokens: 1000,
        wallMs: 40000,
        apiMs: 35000,
        numTurns: 10,
        toolCalls: 12,
        costUsd: 0.03
      }
    },
    ratio: { totalTokens: 0.6, costUsd: 0.6 },
    acceptance: {
      costUsdOnIsAtMost80PctOfOff: true,
      totalTokensOnIsAtMost80PctOfOff: true
    }
  };
  return { ...base, ...overrides };
}

describe("renderDogfoodMarkdown", () => {
  it("emits PASS when cost USD ratio ≤ 80%", () => {
    const md = renderDogfoodMarkdown(fixture());
    expect(md).toContain("Primary acceptance");
    expect(md).toContain("cost USD");
    expect(md).toContain("PASS");
    expect(md).toContain("60.0%");
    expect(md).toContain("index-off");
    expect(md).toContain("index-on");
    expect(md).toContain("T05");
    expect(md).toContain("claude-sonnet-4-6");
  });

  it("emits FAIL when cost USD ratio > 80%, even if tokens passed", () => {
    const md = renderDogfoodMarkdown(
      fixture({
        ratio: { totalTokens: 0.5, costUsd: 0.95 },
        acceptance: {
          costUsdOnIsAtMost80PctOfOff: false,
          totalTokensOnIsAtMost80PctOfOff: true
        }
      })
    );
    expect(md).toContain("FAIL");
    expect(md).toContain("95.0%");
  });

  it("notes the secondary token signal independently of the primary verdict", () => {
    const md = renderDogfoodMarkdown(
      fixture({
        ratio: { totalTokens: 0.901, costUsd: 0.628 },
        acceptance: {
          costUsdOnIsAtMost80PctOfOff: true,
          totalTokensOnIsAtMost80PctOfOff: false
        }
      })
    );
    expect(md).toContain("Primary acceptance");
    expect(md).toContain("PASS");
    expect(md).toContain("Secondary signal");
    expect(md).toContain("would FAIL");
    expect(md).toContain("90.1%");
    expect(md).toContain("62.8%");
  });

  it("renders 'n/a' for unmeasurable ratios", () => {
    const md = renderDogfoodMarkdown(
      fixture({
        armOff: {
          ...fixture().armOff,
          cost: { ...fixture().armOff.cost, totalTokens: 0, costUsd: 0 }
        },
        ratio: { totalTokens: Number.NaN, costUsd: Number.NaN },
        acceptance: {
          costUsdOnIsAtMost80PctOfOff: false,
          totalTokensOnIsAtMost80PctOfOff: false
        }
      })
    );
    expect(md).toContain("n/a");
  });

  it("notes the N=1 honest read", () => {
    const md = renderDogfoodMarkdown(fixture());
    expect(md).toContain("N=1");
    expect(md.toLowerCase()).toContain("honest read");
  });

  it("documents the arm order so reviewers know cache warmth direction", () => {
    const md = renderDogfoodMarkdown(fixture());
    expect(md).toContain("index-off first");
  });
});
