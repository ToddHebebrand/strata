import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReport, renderMarkdown } from "../src/report";
import { runBenchmark } from "../src/runner";
import type { TrialMetrics } from "../src/metrics";

function trial(
  config: "substrate" | "baseline",
  trialNumber: number,
  overrides: Partial<TrialMetrics> = {}
): TrialMetrics {
  return {
    config,
    trial: trialNumber,
    totalTokens: 1000,
    inputTokens: 800,
    outputTokens: 200,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    wallTimeMs: 5000,
    harnessWallTimeMs: 5100,
    toolInvocations: 5,
    failuresRetries: 0,
    totalCostUsd: 0.2,
    success: true,
    resultQuality: { tscClean: true, vitestPassed: true },
    terminalReason: "success",
    operationRowAppended: config === "substrate" ? true : null,
    ...overrides
  };
}

describe("buildReport / renderMarkdown", () => {
  it("emits per-config distributions with raw values and never a bare mean", () => {
    const report = buildReport({
      task: "T03",
      model: "claude-sonnet-4-6",
      n: 3,
      substrate: [
        trial("substrate", 1),
        trial("substrate", 2, { totalTokens: 1200 }),
        trial("substrate", 3, { totalTokens: 800 })
      ],
      baseline: [
        trial("baseline", 1, { totalTokens: 4000, failuresRetries: 2 }),
        trial("baseline", 2, {
          totalTokens: 5000,
          success: false,
          terminalReason: "error_max_turns"
        }),
        trial("baseline", 3, { totalTokens: 4500 })
      ],
      totalCostUsd: 1.4
    });

    expect(report.substrate.totalTokens.values).toEqual([1000, 1200, 800]);
    expect(report.baseline.successCount).toBe(2);
    expect(report.baseline.terminalReasonCounts.error_max_turns).toBe(1);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("raw:");
    expect(markdown).toContain("substrate");
    expect(markdown).toContain("baseline");
    expect(typeof report.comparisonNote).toBe("string");
  });
});

describe("runBenchmark (injected config runners, no model/key)", () => {
  it("runs N trials per config, aggregates, and writes JSON + Markdown artifacts", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "strata-rep-"));
    const result = await runBenchmark({
      task: "T03",
      model: "fake-model",
      trials: 2,
      corpusRoot: "/unused-in-injected-mode",
      maxTurns: 5,
      wallTimeMs: 1000,
      outDir,
      runSubstrate: async (trialNumber) => trial("substrate", trialNumber),
      runBaseline: async (trialNumber) => trial("baseline", trialNumber)
    });

    expect(result.artifactJsonPath).toBeDefined();
    expect(existsSync(result.artifactJsonPath)).toBe(true);
    expect(existsSync(result.artifactMarkdownPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(result.artifactJsonPath, "utf8"));
    expect(parsed.substrate.trials).toBe(2);
    expect(parsed.baseline.trials).toBe(2);
  });

  it("dry-run (trials=0) prints projected spend and writes no artifact", async () => {
    const result = await runBenchmark({
      task: "T03",
      model: "fake-model",
      trials: 0,
      corpusRoot: "/unused",
      maxTurns: 5,
      wallTimeMs: 1000,
      outDir: mkdtempSync(path.join(tmpdir(), "strata-dry-")),
      runSubstrate: async (trialNumber) => trial("substrate", trialNumber),
      runBaseline: async (trialNumber) => trial("baseline", trialNumber)
    });

    expect(result.dryRun).toBe(true);
    expect(result.artifactJsonPath).toBe("");
    expect(result.projectedRuns).toBe(0);
  });
});
