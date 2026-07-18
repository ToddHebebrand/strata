import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { REGISTERED_INTEGRATION_ROLE_BOUNDS, REGISTERED_TASK_ROLE_BOUNDS, type BaselineRoleBounds } from "./baseline.js";
import { planRound, type RoundPlan } from "./runner.js";
import { createQualifiedTaskManifest, APPROVED_CORPUS_VARIANT } from "./tasks.js";

interface ParsedArgs {
  model: string;
  trials: number;
  corpusVariant: string;
  taskRoleBounds: BaselineRoleBounds;
  integrationRoleBounds: BaselineRoleBounds;
  teamWallMs: number;
  projectedMaxUsd: number;
  seed: string;
  approvalPath?: string;
  executeLive: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  let executeLive = false;
  for (const argument of argv) {
    if (argument === "--") continue;
    if (argument === "--execute-live") {
      executeLive = true;
      continue;
    }
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (!match) throw new Error(`unrecognized argument ${argument}`);
    values.set(match[1]!, match[2]!);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value === "") throw new Error(`missing required --${key}`);
    return value;
  };
  const integer = (key: string): number => {
    const value = Number(required(key));
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${key} must be a positive integer`);
    return value;
  };
  const usd = (key: string): number => {
    const value = Number(required(key));
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${key} must be a positive number`);
    return value;
  };
  return {
    model: required("model"),
    trials: integer("trials"),
    corpusVariant: required("corpus-variant"),
    taskRoleBounds: {
      maxTurns: integer("task-max-turns"),
      wallTimeMs: integer("task-wall-ms"),
      maxBudgetUsd: usd("task-max-budget-usd")
    },
    integrationRoleBounds: {
      maxTurns: integer("integration-max-turns"),
      wallTimeMs: integer("integration-wall-ms"),
      maxBudgetUsd: usd("integration-max-budget-usd")
    },
    teamWallMs: integer("team-wall-ms"),
    projectedMaxUsd: usd("projected-max-usd"),
    seed: required("seed"),
    approvalPath: values.get("approval"),
    executeLive
  };
}

function buildPlan(args: ParsedArgs, corpusRoot: string): { plan: RoundPlan; manifest: ReturnType<typeof createQualifiedTaskManifest> } {
  if (args.corpusVariant !== APPROVED_CORPUS_VARIANT) {
    throw new Error(`corpus variant ${args.corpusVariant} is not the approved ${APPROVED_CORPUS_VARIANT}`);
  }
  const manifest = createQualifiedTaskManifest(corpusRoot);
  const plan = planRound({
    trialsPerScenario: args.trials,
    seed: args.seed,
    taskRoleBounds: args.taskRoleBounds,
    integrationRoleBounds: args.integrationRoleBounds,
    teamWallMs: args.teamWallMs,
    projectedMaxUsd: args.projectedMaxUsd
  });
  return { plan, manifest };
}

export interface DryRunOutcome {
  exitCode: number;
  report: {
    plannedSessions: number;
    plannedTrials: number;
    summedQueryBudgetsUsd: number;
    projectedMaxUsd: number;
    sourceDigest: string;
    taskRegistrationDigest: string;
  };
  output: string;
}

/** Key-free planning. Never reads credentials, never calls the SDK, writes nothing. */
export async function runDryRunCommand(
  argv: readonly string[],
  deps: { corpusRoot: string; env: NodeJS.ProcessEnv }
): Promise<DryRunOutcome> {
  const args = parseArgs(argv);
  const { plan, manifest } = buildPlan(args, deps.corpusRoot);
  const output = [
    `dry-run PASS: ${plan.plannedSessions} planned sessions across ${plan.plannedTrials} matched trials`,
    `summed per-query budgets: USD ${plan.summedQueryBudgetsUsd.toFixed(2)}`,
    `projected round maximum: USD ${plan.projectedMaxUsd.toFixed(2)}`,
    `model ${args.model}, seed ${args.seed}, corpus ${args.corpusVariant}`,
    `source digest ${manifest.sourceDigest}`,
    `task registration digest ${manifest.registrationDigest}`,
    "no live result written; no keyed call made"
  ].join("\n");
  return {
    exitCode: 0,
    report: {
      plannedSessions: plan.plannedSessions,
      plannedTrials: plan.plannedTrials,
      summedQueryBudgetsUsd: plan.summedQueryBudgetsUsd,
      projectedMaxUsd: plan.projectedMaxUsd,
      sourceDigest: manifest.sourceDigest,
      taskRegistrationDigest: manifest.registrationDigest
    },
    output
  };
}

export type LiveAdapter = (plan: RoundPlan) => Promise<void>;

export interface LiveCommandDeps {
  corpusRoot: string;
  currentSourceCommit: string;
  /** Output of `git status --porcelain`; must be empty for live execution. */
  worktreeStatus: string;
  env: NodeJS.ProcessEnv;
  loadLiveAdapter: () => Promise<LiveAdapter>;
}

const CREDENTIAL_SOURCES = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/**
 * Digest over the registered live-compare source files. Binds the operator
 * approval to the exact verifier/harness code, independent of the source
 * commit (which cannot see uncommitted modifications on its own).
 */
export function computeVerifierDigest(): string {
  const sourceRoot = resolve(__dirname, __dirname.endsWith("dist") ? "../src" : ".");
  const hash = createHash("sha256");
  for (const name of readdirSync(sourceRoot).filter((entry) => entry.endsWith(".ts")).sort()) {
    hash.update(name).update("\0").update(readFileSync(join(sourceRoot, name))).update("\0");
  }
  return hash.digest("hex");
}

function assertApprovalField(field: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `approval field ${field} does not match the manifest: ` +
        `approved ${JSON.stringify(actual)}, required ${JSON.stringify(expected)}`
    );
  }
}

/** The live command refuses to start unless the approval matches exactly. */
export async function runLiveCommand(
  argv: readonly string[],
  deps: LiveCommandDeps
): Promise<{ exitCode: number }> {
  const args = parseArgs(argv);
  if (!args.executeLive) {
    throw new Error("refusing to start live sessions without the explicit --execute-live flag");
  }
  if (!args.approvalPath) throw new Error("missing required --approval=<path>");
  const approval = JSON.parse(readFileSync(args.approvalPath, "utf8")) as Record<string, unknown>;
  const { plan, manifest } = buildPlan(args, deps.corpusRoot);

  assertApprovalField("provider", approval.provider, "anthropic");
  assertApprovalField("model", approval.model, args.model);
  assertApprovalField("taskSet", approval.taskSet, ["D", "M", "R", "S", "X", "G"]);
  assertApprovalField("corpusVariant", approval.corpusVariant, APPROVED_CORPUS_VARIANT);
  assertApprovalField("trials", approval.trials, args.trials);
  assertApprovalField("seed", approval.seed, args.seed);
  assertApprovalField("taskRoleBounds", approval.taskRoleBounds, { ...REGISTERED_TASK_ROLE_BOUNDS });
  assertApprovalField(
    "integrationRoleBounds",
    approval.integrationRoleBounds,
    { ...REGISTERED_INTEGRATION_ROLE_BOUNDS }
  );
  assertApprovalField("teamWallMs", approval.teamWallMs, 900_000);
  assertApprovalField("projectedMaxUsd", approval.projectedMaxUsd, args.projectedMaxUsd);
  assertApprovalField("sourceCommit", approval.sourceCommit, deps.currentSourceCommit);
  assertApprovalField("sourceDigest", approval.sourceDigest, manifest.sourceDigest);
  assertApprovalField(
    "taskRegistrationDigest",
    approval.taskRegistrationDigest,
    manifest.registrationDigest
  );
  assertApprovalField("verifierDigest", approval.verifierDigest, computeVerifierDigest());

  if (deps.worktreeStatus.trim().length > 0) {
    throw new Error(
      "live execution requires a clean worktree; uncommitted changes present:\n" + deps.worktreeStatus
    );
  }

  const credentialSource = approval.credentialSource;
  if (!CREDENTIAL_SOURCES.includes(credentialSource as (typeof CREDENTIAL_SOURCES)[number])) {
    throw new Error(
      `approval field credentialSource must be one of ${CREDENTIAL_SOURCES.join(", ")}`
    );
  }
  const otherSource = CREDENTIAL_SOURCES.find((source) => source !== credentialSource)!;
  if (!deps.env[credentialSource as string]) {
    throw new Error(`the approved credential source ${credentialSource} is not set`);
  }
  if (deps.env[otherSource]) {
    throw new Error(
      `only the approved credential source may be set; unset ${otherSource} (do not run both)`
    );
  }

  const adapter = await deps.loadLiveAdapter();
  await adapter(plan);
  return { exitCode: 0 };
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const corpusRoot = resolve(__dirname, "../../../examples/medium");
  if (command === "dry-run") {
    const outcome = await runDryRunCommand(rest, { corpusRoot, env: process.env });
    process.stdout.write(`${outcome.output}\n`);
    process.exitCode = outcome.exitCode;
    return;
  }
  if (command === "run") {
    const repoRoot = resolve(corpusRoot, "../..");
    const currentSourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();
    const worktreeStatus = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    const outcome = await runLiveCommand(rest, {
      corpusRoot,
      currentSourceCommit,
      worktreeStatus,
      env: process.env,
      loadLiveAdapter: async () => {
        const { createLiveAdapter } = await import("./liveAdapter.js");
        const model = rest.find((argument) => argument.startsWith("--model="))?.slice("--model=".length);
        if (!model) throw new Error("missing required --model");
        return createLiveAdapter({ model });
      }
    });
    process.exitCode = outcome.exitCode;
    return;
  }
  throw new Error(`unknown command ${command ?? "(none)"}; expected dry-run or run`);
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
