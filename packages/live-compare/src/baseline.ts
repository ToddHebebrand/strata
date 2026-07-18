import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertApprovedTaskManifest,
  baselineTaskPrompt,
  type Phase6PacketId,
  type QualifiedTaskManifest
} from "./tasks.js";

/**
 * Registered role bounds. Comparable task roles use identical bounds across
 * arms; the baseline-only integration role uses its own fixed pre-registered
 * bounds. Any per-trial drift from these values invalidates the manifest.
 */
export const REGISTERED_TASK_ROLE_BOUNDS = Object.freeze({
  maxTurns: 25,
  wallTimeMs: 240_000,
  maxBudgetUsd: 0.75
});
export const REGISTERED_INTEGRATION_ROLE_BOUNDS = Object.freeze({
  maxTurns: 40,
  wallTimeMs: 420_000,
  maxBudgetUsd: 4
});

export interface BaselineRoleBounds {
  maxTurns: number;
  wallTimeMs: number;
  maxBudgetUsd: number;
}

export type BaselineRole = "task-1" | "task-2" | "integration";

export interface BaselineSessionRequest {
  role: BaselineRole;
  worktreePath: string;
  branch: string;
  prompt: string;
  bounds: BaselineRoleBounds;
}

export interface BaselineSessionOutcome {
  numTurns: number;
  durationMs: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  toolEvents: number;
  repairEdits: number;
  errors: string[];
}

export type BaselineSessionRunner = (
  request: BaselineSessionRequest
) => Promise<BaselineSessionOutcome>;

export interface BaselineEvent {
  type:
    | "repo_created"
    | "worktree_created"
    | "clock_started"
    | "session_started"
    | "session_ended"
    | "session_failed"
    | "capture"
    | "integration_started"
    | "integration_ended"
    | "totals_computed";
  role?: BaselineRole;
  detail?: string;
  atMs: number;
}

export interface BaselineCapture {
  role: "task-1" | "task-2";
  branch: string;
  commit: string;
  changed: boolean;
}

export interface BaselineTrialTotals {
  wallMs: number;
  numTurns: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  toolEvents: number;
  repairEdits: number;
  failures: number;
}

export interface BaselineTrialResult {
  repoRoot: string;
  baseCommit: string;
  integrationStartCommit: string;
  integrationWorktree: string;
  captures: BaselineCapture[];
  outcomes: Partial<Record<BaselineRole, BaselineSessionOutcome>>;
  phases: { taskPhaseMs: number; capturePhaseMs: number; integrationPhaseMs: number };
  totals: BaselineTrialTotals;
  events: BaselineEvent[];
  gitEnv: Record<string, string>;
  finalize(): void;
  cleanup(): void;
}

export interface BaselineTrialParams {
  corpusRoot: string;
  workspaceRoot: string;
  manifest: QualifiedTaskManifest;
  packetId: Phase6PacketId;
  sessionRunner: BaselineSessionRunner;
  bounds: { task: BaselineRoleBounds; integration: BaselineRoleBounds };
}

const HERMETIC_GIT_ENV = Object.freeze({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "phase6-baseline-harness",
  GIT_AUTHOR_EMAIL: "phase6-baseline@strata.invalid",
  GIT_COMMITTER_NAME: "phase6-baseline-harness",
  GIT_COMMITTER_EMAIL: "phase6-baseline@strata.invalid"
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundsEqual(actual: BaselineRoleBounds, registered: BaselineRoleBounds): boolean {
  return (
    actual.maxTurns === registered.maxTurns &&
    actual.wallTimeMs === registered.wallTimeMs &&
    actual.maxBudgetUsd === registered.maxBudgetUsd
  );
}

function integrationPrompt(manifest: QualifiedTaskManifest, packetId: Phase6PacketId): string {
  const [first, second] = manifest.packets[packetId].assignments;
  return [
    "You are the integration agent for a two-branch baseline team.",
    "Two independent task branches were captured mechanically from your",
    "teammates' worktrees. Integrate both results into the current worktree,",
    "resolving conflicts and completing any incomplete task work yourself.",
    "Use normal file, shell, and Git tools. Leave the tree green.",
    "",
    `Task 1 (branch task-1):\n${first!.taskBody}`,
    "",
    `Task 2 (branch task-2):\n${second!.taskBody}`
  ].join("\n");
}

export async function runBaselineTrial(params: BaselineTrialParams): Promise<BaselineTrialResult> {
  if (
    !boundsEqual(params.bounds.task, REGISTERED_TASK_ROLE_BOUNDS) ||
    !boundsEqual(params.bounds.integration, REGISTERED_INTEGRATION_ROLE_BOUNDS)
  ) {
    throw new Error("per-trial bound drift invalidates the registered manifest");
  }

  assertApprovedTaskManifest(params.manifest);

  const workspaceRoot = resolve(params.workspaceRoot);
  if (readdirSync(workspaceRoot).length > 0) {
    throw new Error(`dirty starting tree rejected: workspace ${workspaceRoot} is not empty`);
  }

  const gitEnv: Record<string, string> = { ...HERMETIC_GIT_ENV };
  const git = (cwd: string, args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });

  const repoRoot = join(workspaceRoot, "repo");
  cpSync(resolve(params.corpusRoot), repoRoot, { recursive: true });
  for (const [path, file] of Object.entries(params.manifest.sourceFiles)) {
    if (sha256(readFileSync(join(repoRoot, path))) !== file.digest) {
      throw new Error(`corpus mirror digest mismatch for ${path}`);
    }
  }

  const events: BaselineEvent[] = [];
  const started = performance.now();
  const at = (): number => performance.now() - started;

  git(repoRoot, ["init", "-b", "main"]);
  git(repoRoot, ["config", "--local", "user.name", gitEnv.GIT_AUTHOR_NAME!]);
  git(repoRoot, ["config", "--local", "user.email", gitEnv.GIT_AUTHOR_EMAIL!]);
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-m", "baseline: source snapshot"]);
  const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  events.push({ type: "repo_created", detail: baseCommit, atMs: at() });

  // Each worktree lives under its own unguessable temp root so a session with
  // normal file/shell tools cannot traverse to a teammate's live worktree or
  // the integration worktree by relative-path guessing.
  const isolatedRoots: string[] = [];
  const isolatedWorktree = (role: BaselineRole): string => {
    const root = mkdtempSync(join(tmpdir(), `strata-phase6-${role}-`));
    isolatedRoots.push(root);
    return join(root, "wt");
  };
  const worktrees: Record<BaselineRole, string> = {
    "task-1": isolatedWorktree("task-1"),
    "task-2": isolatedWorktree("task-2"),
    integration: isolatedWorktree("integration")
  };
  for (const role of ["task-1", "task-2", "integration"] as const) {
    git(repoRoot, ["worktree", "add", "-b", role, worktrees[role], "main"]);
    events.push({ type: "worktree_created", role, atMs: at() });
  }
  const integrationStartCommit = git(worktrees.integration, ["rev-parse", "HEAD"]).trim();

  const assignments = params.manifest.packets[params.packetId].assignments;
  const taskRoles = ["task-1", "task-2"] as const;
  const outcomes: Partial<Record<BaselineRole, BaselineSessionOutcome>> = {};
  let failures = 0;

  events.push({ type: "clock_started", atMs: at() });
  const clockStart = performance.now();

  const taskPromises = taskRoles.map((role, index) => {
    const assignment = assignments[index]!;
    const prompt = baselineTaskPrompt(assignment);
    if (sha256(prompt) !== assignment.promptHashes.baseline) {
      throw new Error(`baseline prompt bytes diverge from the registered hash for ${role}`);
    }
    events.push({ type: "session_started", role, atMs: at() });
    return params.sessionRunner({
      role,
      worktreePath: worktrees[role],
      branch: role,
      prompt,
      bounds: { ...params.bounds.task }
    });
  });
  const settled = await Promise.allSettled(taskPromises);
  for (const [index, outcome] of settled.entries()) {
    const role = taskRoles[index]!;
    if (outcome.status === "fulfilled") {
      outcomes[role] = outcome.value;
    } else {
      failures += 1;
      events.push({ type: "session_failed", role, detail: String(outcome.reason), atMs: at() });
    }
    events.push({ type: "session_ended", role, atMs: at() });
  }
  const taskPhaseMs = performance.now() - clockStart;

  const captureStart = performance.now();
  const captures: BaselineCapture[] = [];
  for (const role of taskRoles) {
    const worktree = worktrees[role];
    const changed = git(worktree, ["status", "--porcelain"]).trim().length > 0;
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "--allow-empty", "-m", `baseline: capture ${role} output`]);
    const commit = git(worktree, ["rev-parse", "HEAD"]).trim();
    captures.push({ role, branch: role, commit, changed });
    events.push({ type: "capture", role, detail: commit, atMs: at() });
  }
  const capturePhaseMs = performance.now() - captureStart;

  if (git(worktrees.integration, ["status", "--porcelain"]).trim().length > 0) {
    throw new Error(
      "integration worktree is not clean before the integration session: manual edits are rejected"
    );
  }

  const integrationStart = performance.now();
  events.push({ type: "integration_started", role: "integration", atMs: at() });
  try {
    outcomes.integration = await params.sessionRunner({
      role: "integration",
      worktreePath: worktrees.integration,
      branch: "integration",
      prompt: integrationPrompt(params.manifest, params.packetId),
      bounds: { ...params.bounds.integration }
    });
  } catch (error) {
    failures += 1;
    events.push({ type: "session_failed", role: "integration", detail: String(error), atMs: at() });
  }
  events.push({ type: "integration_ended", role: "integration", atMs: at() });
  const integrationPhaseMs = performance.now() - integrationStart;

  const recorded = Object.values(outcomes);
  const sum = (select: (outcome: BaselineSessionOutcome) => number): number =>
    recorded.reduce((total, outcome) => total + select(outcome), 0);
  const totals: BaselineTrialTotals = {
    wallMs: performance.now() - clockStart,
    numTurns: sum((outcome) => outcome.numTurns),
    totalCostUsd: sum((outcome) => outcome.totalCostUsd),
    inputTokens: sum((outcome) => outcome.inputTokens),
    outputTokens: sum((outcome) => outcome.outputTokens),
    toolEvents: sum((outcome) => outcome.toolEvents),
    repairEdits: sum((outcome) => outcome.repairEdits),
    failures
  };
  events.push({ type: "totals_computed", atMs: at() });

  let finalized = false;
  return {
    repoRoot,
    baseCommit,
    integrationStartCommit,
    integrationWorktree: worktrees.integration,
    captures,
    outcomes,
    phases: { taskPhaseMs, capturePhaseMs, integrationPhaseMs },
    totals,
    events,
    gitEnv,
    finalize(): void {
      const count = (type: BaselineEvent["type"]): number =>
        events.filter((event) => event.type === type).length;
      const required: [BaselineEvent["type"], number][] = [
        ["repo_created", 1],
        ["worktree_created", 3],
        ["clock_started", 1],
        ["session_started", 2],
        ["session_ended", 2],
        ["capture", 2],
        ["integration_started", 1],
        ["integration_ended", 1],
        ["totals_computed", 1]
      ];
      for (const [type, expected] of required) {
        if (count(type) < expected) {
          throw new Error(`missing event records: expected ${expected} ${type}`);
        }
      }
      finalized = true;
    },
    cleanup(): void {
      if (!finalized) {
        throw new Error("evidence must be preserved: finalize artifacts before cleanup");
      }
      rmSync(workspaceRoot, { recursive: true, force: true });
      for (const root of isolatedRoots) rmSync(root, { recursive: true, force: true });
    }
  };
}
