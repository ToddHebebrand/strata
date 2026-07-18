import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeVerifierDigest, runDryRunCommand, runLiveCommand } from "../src/cli.js";
import { createQualifiedTaskManifest } from "../src/tasks.js";

const corpusRoot = resolve(import.meta.dirname, "../../../examples/medium");
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const DRY_RUN_ARGS = [
  "--model=claude-sonnet-4-6",
  "--trials=1",
  "--corpus-variant=x-namespace-enriched-v1",
  "--task-max-turns=25",
  "--task-wall-ms=240000",
  "--task-max-budget-usd=0.75",
  "--integration-max-turns=40",
  "--integration-wall-ms=420000",
  "--integration-max-budget-usd=4.00",
  "--team-wall-ms=900000",
  "--projected-max-usd=55.00",
  "--seed=pilot-seed-1"
];

function credentialTrappingEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return new Proxy({ PATH: process.env.PATH ?? "", ...extra } as NodeJS.ProcessEnv, {
    get(target, property: string) {
      if (property === "ANTHROPIC_API_KEY" || property === "CLAUDE_CODE_OAUTH_TOKEN") {
        if (!(property in target)) {
          throw new Error(`dry-run must never read credential ${property}`);
        }
      }
      return target[property];
    }
  });
}

function approvalFor(manifest: ReturnType<typeof createQualifiedTaskManifest>, sourceCommit: string) {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    taskSet: ["D", "M", "R", "S", "X", "G"],
    corpusVariant: "x-namespace-enriched-v1",
    trials: 1,
    seed: "pilot-seed-1",
    taskRoleBounds: { maxTurns: 25, wallTimeMs: 240_000, maxBudgetUsd: 0.75 },
    integrationRoleBounds: { maxTurns: 40, wallTimeMs: 420_000, maxBudgetUsd: 4 },
    teamWallMs: 900_000,
    projectedMaxUsd: 55,
    sourceCommit,
    sourceDigest: manifest.sourceDigest,
    taskRegistrationDigest: manifest.registrationDigest,
    verifierDigest: computeVerifierDigest(),
    credentialSource: "ANTHROPIC_API_KEY"
  };
}

function writeApproval(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "strata-approval-"));
  temporary.push(directory);
  const path = join(directory, "approval.json");
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
  return path;
}

describe("guarded live-comparison CLI", () => {
  it("dry-run plans 30 sessions and USD 42.00 without credentials or live writes", async () => {
    const outcome = await runDryRunCommand(DRY_RUN_ARGS, {
      corpusRoot,
      env: credentialTrappingEnv()
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.plannedSessions).toBe(30);
    expect(outcome.report.summedQueryBudgetsUsd).toBeCloseTo(42, 10);
    expect(outcome.report.projectedMaxUsd).toBe(55);
    expect(outcome.output).toContain("30 planned sessions");
    expect(outcome.output).toContain("USD 42.00");
    expect(outcome.output).toContain("USD 55.00");
    expect(outcome.output).toContain("no live result written");
  }, 30_000);

  it("dry-run rejects bound drift, insufficient deadlines, and wrong variants", async () => {
    const deps = { corpusRoot, env: credentialTrappingEnv() };
    const withArg = (flag: string, value: string): string[] =>
      DRY_RUN_ARGS.map((arg) => (arg.startsWith(`${flag}=`) ? `${flag}=${value}` : arg));
    await expect(runDryRunCommand(withArg("--task-max-turns", "26"), deps)).rejects.toThrow(/bound drift/);
    await expect(runDryRunCommand(withArg("--team-wall-ms", "480000"), deps)).rejects.toThrow(/structurally insufficient/);
    await expect(runDryRunCommand(withArg("--corpus-variant", "current"), deps)).rejects.toThrow(/corpus variant/);
    await expect(runDryRunCommand(withArg("--projected-max-usd", "41"), deps)).rejects.toThrow(/projected/);
  }, 30_000);

  it("starts the live adapter only with a fully matching approval, flag, and credential", async () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    const sourceCommit = "fedcba9876543210fedcba9876543210fedcba98";
    const started: unknown[] = [];
    const deps = {
      corpusRoot,
      currentSourceCommit: sourceCommit,
      worktreeStatus: "",
      env: { ANTHROPIC_API_KEY: "test-credential" } as NodeJS.ProcessEnv,
      loadLiveAdapter: async () => async (plan: unknown) => { started.push(plan); }
    };
    const approvalPath = writeApproval(approvalFor(manifest, sourceCommit));
    const outcome = await runLiveCommand(
      [...DRY_RUN_ARGS, `--approval=${approvalPath}`, "--execute-live"],
      deps
    );
    expect(outcome.exitCode).toBe(0);
    expect(started).toHaveLength(1);
  }, 30_000);

  it("refuses to start live on any approval mismatch, missing flag, or missing credential", async () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    const sourceCommit = "fedcba9876543210fedcba9876543210fedcba98";
    const started: unknown[] = [];
    const deps = {
      corpusRoot,
      currentSourceCommit: sourceCommit,
      worktreeStatus: "",
      env: { ANTHROPIC_API_KEY: "test-credential" } as NodeJS.ProcessEnv,
      loadLiveAdapter: async () => async (plan: unknown) => { started.push(plan); }
    };
    const good = approvalFor(manifest, sourceCommit);

    await expect(runLiveCommand(
      [...DRY_RUN_ARGS, `--approval=${writeApproval(good)}`],
      deps
    )).rejects.toThrow(/--execute-live/);

    await expect(runLiveCommand(
      [...DRY_RUN_ARGS, `--approval=${writeApproval(good)}`, "--execute-live"],
      { ...deps, env: {} as NodeJS.ProcessEnv }
    )).rejects.toThrow(/credential/);

    await expect(runLiveCommand(
      [...DRY_RUN_ARGS, `--approval=${writeApproval(good)}`, "--execute-live"],
      { ...deps, env: { CLAUDE_CODE_OAUTH_TOKEN: "other-credential" } as NodeJS.ProcessEnv }
    ), "wrong credential source must refuse").rejects.toThrow(/credential/);

    await expect(runLiveCommand(
      [...DRY_RUN_ARGS, `--approval=${writeApproval(good)}`, "--execute-live"],
      { ...deps, env: { ANTHROPIC_API_KEY: "a", CLAUDE_CODE_OAUTH_TOKEN: "b" } as NodeJS.ProcessEnv }
    ), "both credentials set must refuse").rejects.toThrow(/credential/);

    await expect(runLiveCommand(
      [...DRY_RUN_ARGS, `--approval=${writeApproval(good)}`, "--execute-live"],
      { ...deps, worktreeStatus: " M packages/live-compare/src/verify.ts" }
    ), "dirty worktree must refuse").rejects.toThrow(/clean/);

    const tampers: [string, unknown][] = [
      ["model", "claude-haiku-4-5"],
      ["provider", "other"],
      ["taskSet", ["D", "M"]],
      ["corpusVariant", "current"],
      ["trials", 3],
      ["seed", "other-seed"],
      ["taskRoleBounds", { maxTurns: 26, wallTimeMs: 240_000, maxBudgetUsd: 0.75 }],
      ["integrationRoleBounds", { maxTurns: 40, wallTimeMs: 420_000, maxBudgetUsd: 5 }],
      ["teamWallMs", 800_000],
      ["projectedMaxUsd", 60],
      ["sourceCommit", "0".repeat(40)],
      ["sourceDigest", "0".repeat(64)],
      ["taskRegistrationDigest", "0".repeat(64)],
      ["verifierDigest", "0".repeat(64)],
      ["credentialSource", "OTHER_VARIABLE"]
    ];
    for (const [field, value] of tampers) {
      const tampered = { ...good, [field]: value };
      await expect(
        runLiveCommand([...DRY_RUN_ARGS, `--approval=${writeApproval(tampered)}`, "--execute-live"], deps),
        `tampered ${field} must refuse`
      ).rejects.toThrow(new RegExp(field.replace(/[A-Z]/g, (c) => c)));
    }
    expect(started).toHaveLength(0);
  }, 60_000);
});
