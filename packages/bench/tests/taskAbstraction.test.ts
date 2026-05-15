import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TrialMetrics } from "../src/metrics";
import { runBenchmark } from "../src/runner";
import { BENCH_TASKS, type BenchTaskId } from "../src/tasks";

function metrics(config: "substrate" | "baseline", trial: number): TrialMetrics {
  return {
    config,
    trial,
    totalTokens: 100,
    inputTokens: 100,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    wallTimeMs: 1,
    harnessWallTimeMs: 1,
    toolInvocations: 1,
    failuresRetries: 0,
    totalCostUsd: 0.01,
    success: true,
    resultQuality: { tscClean: true, vitestPassed: true },
    terminalReason: "success",
    operationRowAppended: config === "substrate" ? true : null
  };
}

describe("BenchTask abstraction", () => {
  it("registers exactly the four Phase 1.5 tasks", () => {
    const ids = Object.keys(BENCH_TASKS).sort() as BenchTaskId[];
    expect(ids).toEqual(["T01", "T03", "T05", "T08"]);
  });

  it("each task carries a prompt and substrate plus baseline runners", () => {
    for (const id of Object.keys(BENCH_TASKS) as BenchTaskId[]) {
      const task = BENCH_TASKS[id];
      expect(task.id).toBe(id);
      expect(typeof task.prompt).toBe("string");
      expect(task.prompt.length).toBeGreaterThan(20);
      expect(typeof task.substrate).toBe("function");
      expect(typeof task.baseline).toBe("function");
    }
  });

  it("runner executes the requested task list through injected trial functions", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "strata-suite-"));
    const seen: string[] = [];

    const result = await runBenchmark({
      tasks: ["T01", "T03", "T05", "T08"],
      model: "fake-model",
      trials: 1,
      corpusRoot: "/unused",
      maxTurns: 1,
      wallTimeMs: 1,
      outDir,
      runSubstrateTask: async (taskId, trial) => {
        seen.push(`s:${taskId}:${trial}`);
        return metrics("substrate", trial);
      },
      runBaselineTask: async (taskId, trial) => {
        seen.push(`b:${taskId}:${trial}`);
        return metrics("baseline", trial);
      }
    });

    expect(seen).toEqual([
      "s:T01:1",
      "b:T01:1",
      "s:T03:1",
      "b:T03:1",
      "s:T05:1",
      "b:T05:1",
      "s:T08:1",
      "b:T08:1"
    ]);
    expect(existsSync(result.artifactJsonPath)).toBe(true);
    expect(readFileSync(result.artifactMarkdownPath, "utf8")).toContain(
      "cross-task pattern"
    );
  });
});
