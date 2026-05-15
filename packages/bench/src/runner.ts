import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runBaselineTrial } from "./configs/baseline";
import { runSubstrateTrial } from "./configs/substrate";
import type { TrialMetrics } from "./metrics";
import {
  buildReport,
  buildSuiteReport,
  renderMarkdown,
  renderSuiteMarkdown
} from "./report";
import { ALL_TASK_IDS, BENCH_TASKS, type BenchTaskId } from "./tasks";

export interface RunBenchmarkParams {
  task?: "T03";
  tasks?: BenchTaskId[];
  model: string;
  trials: number;
  corpusRoot: string;
  maxTurns: number;
  wallTimeMs: number;
  outDir: string;
  runSubstrate?: (trial: number) => Promise<TrialMetrics>;
  runBaseline?: (trial: number) => Promise<TrialMetrics>;
  runSubstrateTask?: (
    taskId: BenchTaskId,
    trial: number
  ) => Promise<TrialMetrics>;
  runBaselineTask?: (
    taskId: BenchTaskId,
    trial: number
  ) => Promise<TrialMetrics>;
  keepArtifacts?: boolean;
}

export interface RunBenchmarkResult {
  dryRun: boolean;
  projectedRuns: number;
  artifactJsonPath: string;
  artifactMarkdownPath: string;
}

export async function runBenchmark(
  params: RunBenchmarkParams
): Promise<RunBenchmarkResult> {
  if (params.trials < 0 || !Number.isInteger(params.trials)) {
    throw new Error("--trials must be an integer >= 0");
  }
  if (params.trials > 5) {
    throw new Error("--trials is capped at 5 for the Phase 4 cost budget");
  }

  const taskIds = params.tasks ?? [params.task ?? "T03"];
  const projectedRuns = taskIds.length * 2 * params.trials;
  console.log(
    `[bench] tasks=${taskIds.join(",")} model=${params.model} N=${params.trials} ` +
      `=> ${projectedRuns} live runs. Per-run cost band: unknown until the ` +
      `first live round establishes baseline cost; BS-Bench-C is evaluated ` +
      `from round one actuals.`
  );

  if (params.trials === 0) {
    console.log("[bench] dry-run (trials=0): no live runs, no artifact.");
    return {
      dryRun: true,
      projectedRuns: 0,
      artifactJsonPath: "",
      artifactMarkdownPath: ""
    };
  }

  const perTask: Record<
    string,
    { substrate: TrialMetrics[]; baseline: TrialMetrics[] }
  > = {};

  for (const taskId of taskIds) {
    const task = BENCH_TASKS[taskId];
    if (!task) {
      throw new Error(`Unknown benchmark task: ${taskId}`);
    }
    const substrate: TrialMetrics[] = [];
    const baseline: TrialMetrics[] = [];
    for (let trial = 1; trial <= params.trials; trial++) {
      const runSubstrate =
        params.runSubstrateTask ??
        (params.runSubstrate && taskIds.length === 1
          ? (_taskId: BenchTaskId, trialNumber: number) =>
              params.runSubstrate!(trialNumber)
          : undefined);
      const runBaseline =
        params.runBaselineTask ??
        (params.runBaseline && taskIds.length === 1
          ? (_taskId: BenchTaskId, trialNumber: number) =>
              params.runBaseline!(trialNumber)
          : undefined);
      substrate.push(
        runSubstrate
          ? await runSubstrate(taskId, trial)
          : await task.substrate({
              trial,
              corpusRoot: params.corpusRoot,
              model: params.model,
              maxTurns: params.maxTurns,
              wallTimeMs: params.wallTimeMs,
              keepArtifacts: params.keepArtifacts
            })
      );
      baseline.push(
        runBaseline
          ? await runBaseline(taskId, trial)
          : await task.baseline({
              trial,
              corpusRoot: params.corpusRoot,
              model: params.model,
              maxTurns: params.maxTurns,
              wallTimeMs: params.wallTimeMs,
              keepArtifacts: params.keepArtifacts
            })
      );
    }
    perTask[taskId] = { substrate, baseline };
  }

  const totalCostUsd = Object.values(perTask).reduce(
    (sum, runs) =>
      sum +
      runs.substrate.reduce((s, metrics) => s + metrics.totalCostUsd, 0) +
      runs.baseline.reduce((s, metrics) => s + metrics.totalCostUsd, 0),
    0
  );
  const singleT03 = taskIds.length === 1 && taskIds[0] === "T03";
  const artifactText = singleT03
    ? (() => {
        const report = buildReport({
          task: "T03",
          model: params.model,
          n: params.trials,
          substrate: perTask.T03!.substrate,
          baseline: perTask.T03!.baseline,
          totalCostUsd
        });
        return {
          json: JSON.stringify(report, null, 2),
          markdown: renderMarkdown(report)
        };
      })()
    : (() => {
        const report = buildSuiteReport({
          model: params.model,
          n: params.trials,
          perTask,
          totalCostUsd
        });
        return {
          json: JSON.stringify(report, null, 2),
          markdown: renderSuiteMarkdown(report)
        };
      })();
  mkdirSync(params.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix = singleT03 ? "t03" : "phase15-four-task";
  const artifactJsonPath = path.join(params.outDir, `${prefix}-${stamp}.json`);
  const artifactMarkdownPath = path.join(params.outDir, `${prefix}-${stamp}.md`);
  writeFileSync(artifactJsonPath, artifactText.json);
  writeFileSync(artifactMarkdownPath, artifactText.markdown);
  console.log(
    `[bench] wrote ${artifactJsonPath} and ${artifactMarkdownPath}; ` +
      `round cost $${totalCostUsd.toFixed(2)}`
  );

  return {
    dryRun: false,
    projectedRuns,
    artifactJsonPath,
    artifactMarkdownPath
  };
}

function getArg(args: string[], flag: string, defaultValue: string): string {
  const hit = args.find((arg) => arg.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : defaultValue;
}

function parseTasks(value: string): BenchTaskId[] {
  const tasks = value
    .split(",")
    .map((task) => task.trim())
    .filter((task) => task.length > 0);
  for (const task of tasks) {
    if (!ALL_TASK_IDS.includes(task as BenchTaskId)) {
      throw new Error(`Unknown --tasks entry: ${task}`);
    }
  }
  return tasks as BenchTaskId[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const trials = Number(getArg(args, "--trials", "3"));
  const model = getArg(args, "--model", "claude-sonnet-4-6");
  const tasks = parseTasks(getArg(args, "--tasks", ALL_TASK_IDS.join(",")));
  const corpusRoot = path.resolve(__dirname, "../../../examples/medium");
  const outDir = path.resolve(__dirname, "../results");

  if (
    trials > 0 &&
    !process.env.ANTHROPIC_API_KEY &&
    !process.env.CLAUDE_CODE_OAUTH_TOKEN
  ) {
    throw new Error(
      "bench is operator-only and key-gated; set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, or run --trials=0 for dry-run."
    );
  }

  await runBenchmark({
    tasks,
    model,
    trials,
    corpusRoot,
    maxTurns: Number(getArg(args, "--max-turns", "25")),
    wallTimeMs: Number(getArg(args, "--wall-ms", "240000")),
    outDir,
    keepArtifacts: args.includes("--keep-artifacts")
  });
}

// CommonJS guard: tsconfig.base uses module=CommonJS, so avoid import.meta.
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
