import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runBaselineTrial } from "./configs/baseline";
import { runSubstrateTrial } from "./configs/substrate";
import type { TrialMetrics } from "./metrics";
import { buildReport, renderMarkdown } from "./report";

export interface RunBenchmarkParams {
  task: "T03";
  model: string;
  trials: number;
  corpusRoot: string;
  maxTurns: number;
  wallTimeMs: number;
  outDir: string;
  runSubstrate?: (trial: number) => Promise<TrialMetrics>;
  runBaseline?: (trial: number) => Promise<TrialMetrics>;
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

  const projectedRuns = 2 * params.trials;
  console.log(
    `[bench] task=${params.task} model=${params.model} N=${params.trials} ` +
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

  const runSubstrate =
    params.runSubstrate ??
    ((trial: number) =>
      runSubstrateTrial({
        trial,
        corpusRoot: params.corpusRoot,
        model: params.model,
        maxTurns: params.maxTurns,
        wallTimeMs: params.wallTimeMs
      }));
  const runBaseline =
    params.runBaseline ??
    ((trial: number) =>
      runBaselineTrial({
        trial,
        corpusRoot: params.corpusRoot,
        model: params.model,
        maxTurns: params.maxTurns,
        wallTimeMs: params.wallTimeMs,
        keepArtifacts: params.keepArtifacts
      }));

  const substrate: TrialMetrics[] = [];
  const baseline: TrialMetrics[] = [];
  for (let trial = 1; trial <= params.trials; trial++) {
    substrate.push(await runSubstrate(trial));
    baseline.push(await runBaseline(trial));
  }

  const totalCostUsd =
    substrate.reduce((sum, metrics) => sum + metrics.totalCostUsd, 0) +
    baseline.reduce((sum, metrics) => sum + metrics.totalCostUsd, 0);
  const report = buildReport({
    task: params.task,
    model: params.model,
    n: params.trials,
    substrate,
    baseline,
    totalCostUsd
  });

  mkdirSync(params.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactJsonPath = path.join(params.outDir, `t03-${stamp}.json`);
  const artifactMarkdownPath = path.join(params.outDir, `t03-${stamp}.md`);
  writeFileSync(artifactJsonPath, JSON.stringify(report, null, 2));
  writeFileSync(artifactMarkdownPath, renderMarkdown(report));
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const trials = Number(getArg(args, "--trials", "3"));
  const model = getArg(args, "--model", "claude-sonnet-4-6");
  const corpusRoot = path.resolve(__dirname, "../../../examples/medium");
  const outDir = path.resolve(__dirname, "../results");

  if (
    trials > 0 &&
    !process.env.ANTHROPIC_API_KEY &&
    !process.env.CLAUDE_CODE_OAUTH_TOKEN
  ) {
    throw new Error(
      "bench:t03 is operator-only and key-gated; set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, or run --trials=0 for dry-run."
    );
  }

  await runBenchmark({
    task: "T03",
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
