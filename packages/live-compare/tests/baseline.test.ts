import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REGISTERED_INTEGRATION_ROLE_BOUNDS,
  REGISTERED_TASK_ROLE_BOUNDS,
  runBaselineTrial,
  type BaselineSessionOutcome,
  type BaselineSessionRequest,
  type BaselineSessionRunner
} from "../src/baseline.js";
import { baselineTaskPrompt, createQualifiedTaskManifest } from "../src/tasks.js";

const corpusRoot = resolve(import.meta.dirname, "../../../examples/medium");
const fixturesRoot = resolve(import.meta.dirname, "fixtures/baseline");
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

interface SessionEdit { path: string; find: string; replace: string; all: boolean }
interface SessionScript {
  edits?: SessionEdit[];
  throws?: string;
  ops?: ({ git: string[] } | { gitAllowFail: string[] } | { write: { path: string; content: string } })[];
  outcome?: BaselineSessionOutcome & Record<string, unknown>;
}
type Scenario = Record<string, SessionScript>;

function loadScenario(name: string): Scenario {
  return JSON.parse(readFileSync(join(fixturesRoot, `${name}.json`), "utf8")) as Scenario;
}

function git(cwd: string, args: string[], allowFail = false): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0"
      }
    });
  } catch (error) {
    if (allowFail) return "";
    throw error;
  }
}

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), "strata-baseline-"));
  temporary.push(path);
  return path;
}

function scriptedRunner(
  scenario: Scenario,
  observed: { requests: BaselineSessionRequest[]; probes: Record<string, unknown> }
): BaselineSessionRunner {
  let startedTasks = 0;
  let releaseBarrier: (() => void) | undefined;
  const barrier = new Promise<void>((resolveBarrier) => { releaseBarrier = resolveBarrier; });
  return async (request) => {
    observed.requests.push(request);
    const script = scenario[request.role];
    if (!script) throw new Error(`no script for ${request.role}`);
    if (request.role !== "integration") {
      startedTasks += 1;
      if (startedTasks === 2) releaseBarrier!();
      await barrier;
      if (request.role === "task-1") {
        observed.probes.otherBranchTipDuringSession = git(request.worktreePath, ["rev-parse", "task-2"]).trim();
        observed.probes.siblingTraversalHitsOtherWorktree =
          existsSync(join(request.worktreePath, "../task-2/src/lib/dateRange.ts")) ||
          existsSync(join(request.worktreePath, "../../task-2/src/lib/dateRange.ts"));
      }
      if (script.throws) throw new Error(script.throws);
      for (const edit of script.edits ?? []) {
        const target = join(request.worktreePath, edit.path);
        if (edit.find === "") {
          writeFileSync(target, "tampered\n", "utf8");
          continue;
        }
        const text = readFileSync(target, "utf8");
        writeFileSync(target, edit.all ? text.split(edit.find).join(edit.replace) : text.replace(edit.find, edit.replace), "utf8");
      }
      return script.outcome!;
    }
    for (const op of script.ops ?? []) {
      if ("git" in op) git(request.worktreePath, op.git);
      else if ("gitAllowFail" in op) git(request.worktreePath, op.gitAllowFail, true);
      else writeFileSync(join(request.worktreePath, op.write.path), op.write.content, "utf8");
    }
    return script.outcome!;
  };
}

async function runScenario(name: string, mutate?: (scenario: Scenario) => void) {
  const scenario = loadScenario(name);
  mutate?.(scenario);
  const manifest = createQualifiedTaskManifest(corpusRoot);
  const observed = { requests: [] as BaselineSessionRequest[], probes: {} as Record<string, unknown> };
  const result = await runBaselineTrial({
    corpusRoot,
    workspaceRoot: workspace(),
    manifest,
    packetId: "D",
    sessionRunner: scriptedRunner(scenario, observed),
    bounds: { task: REGISTERED_TASK_ROLE_BOUNDS, integration: REGISTERED_INTEGRATION_ROLE_BOUNDS }
  });
  return { result, observed, manifest };
}

describe("matched multi-worktree baseline", () => {
  it("creates isolated worktrees from one commit and captures standardized branch commits", async () => {
    const { result, observed } = await runScenario("disjoint");

    const captureParents = result.captures.map((capture) =>
      git(result.repoRoot, ["rev-parse", `${capture.commit}~1`]).trim()
    );
    expect(captureParents).toEqual([result.baseCommit, result.baseCommit]);
    expect(result.integrationStartCommit).toBe(result.baseCommit);

    const worktreeRequests = observed.requests.map((request) => request.worktreePath);
    expect(new Set(worktreeRequests.map((path) => join(path, ".."))).size).toBe(worktreeRequests.length);
    for (const path of worktreeRequests) {
      expect(path.startsWith(result.repoRoot), `worktree ${path} must not live under the repo`).toBe(false);
    }
    expect(observed.probes.siblingTraversalHitsOtherWorktree).toBe(false);

    const order = result.events.filter((event) => event.type === "session_started" || event.type === "session_ended");
    expect(order[0]!.type).toBe("session_started");
    expect(order[1]!.type).toBe("session_started");

    expect(observed.probes.otherBranchTipDuringSession).toBe(result.baseCommit);

    for (const capture of result.captures) {
      expect(capture.changed).toBe(true);
      const message = git(result.repoRoot, ["log", "-1", "--format=%s", capture.commit]).trim();
      expect(message).toBe(`baseline: capture ${capture.role} output`);
    }

    result.finalize();
    result.cleanup();
  }, 60_000);

  it("accounts the integration role fully and enforces registered bounds", async () => {
    const { result, observed, manifest } = await runScenario("conflicting");

    const taskRequests = observed.requests.filter((request) => request.role !== "integration");
    expect(taskRequests).toHaveLength(2);
    for (const request of taskRequests) {
      expect(request.bounds).toEqual({ maxTurns: 25, wallTimeMs: 240_000, maxBudgetUsd: 0.75 });
      const assignment = manifest.packets.D.assignments.find((entry) => entry.role === (request.role === "task-1" ? "agent-1" : "agent-2"))!;
      expect(request.prompt).toBe(baselineTaskPrompt(assignment));
      expect(request.prompt).toContain("Target locations:");
      expect(/\b[0-9a-f]{16}\b/.test(request.prompt), "baseline prompt must not leak stable IDs").toBe(false);
    }
    const integration = observed.requests.find((request) => request.role === "integration")!;
    expect(integration.bounds).toEqual({ maxTurns: 40, wallTimeMs: 420_000, maxBudgetUsd: 4 });
    for (const assignment of manifest.packets.D.assignments) {
      expect(integration.prompt).toContain(assignment.taskBody);
    }
    expect(integration.prompt).toContain("task-1");
    expect(integration.prompt).toContain("task-2");
    for (const forbidden of ["mcp__strata", "socket", manifest.registrationDigest, manifest.sourceDigest, manifest.graphDigest]) {
      expect(integration.prompt.includes(forbidden), `integration prompt must not contain ${forbidden}`).toBe(false);
    }

    expect(result.totals.totalCostUsd).toBeCloseTo(0.24 + 0.2 + 1.1, 10);
    expect(result.totals.numTurns).toBe(7 + 6 + 14);
    expect(result.totals.toolEvents).toBe(10 + 8 + 12);
    expect(result.totals.repairEdits).toBe(1);
    expect(result.totals.failures).toBe(0);
    expect(result.phases.integrationPhaseMs).toBeGreaterThanOrEqual(0);
    expect(result.totals.wallMs).toBeGreaterThanOrEqual(
      result.phases.taskPhaseMs + result.phases.capturePhaseMs + result.phases.integrationPhaseMs
    );

    const resolved = readFileSync(join(result.integrationWorktree, "src/types/user.ts"), "utf8");
    expect(resolved).toContain("return `<${user.email.toLowerCase()}>`;");

    result.finalize();
    result.cleanup();
  }, 60_000);

  it("rejects any per-trial bound drift as manifest invalidation", async () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    const observed = { requests: [] as BaselineSessionRequest[], probes: {} };
    await expect(runBaselineTrial({
      corpusRoot,
      workspaceRoot: workspace(),
      manifest,
      packetId: "D",
      sessionRunner: scriptedRunner(loadScenario("disjoint"), observed),
      bounds: {
        task: { ...REGISTERED_TASK_ROLE_BOUNDS, maxTurns: 26 },
        integration: REGISTERED_INTEGRATION_ROLE_BOUNDS
      }
    })).rejects.toThrow(/bound drift invalidates/);
  }, 30_000);

  it("integrates incomplete, invalid, and failed task branches without harness repair", async () => {
    const incomplete = await runScenario("incomplete");
    const emptyCapture = incomplete.result.captures.find((capture) => capture.role === "task-2")!;
    expect(emptyCapture.changed).toBe(false);
    expect(incomplete.result.totals.repairEdits).toBe(2);
    incomplete.result.finalize();
    incomplete.result.cleanup();

    const invalid = await runScenario("invalid");
    const broken = git(invalid.result.repoRoot, ["show", "task-2:src/lib/dateRange.ts"]);
    expect(broken).toContain("isWithinRange((date: Date");
    const repaired = readFileSync(join(invalid.result.integrationWorktree, "src/lib/dateRange.ts"), "utf8");
    expect(repaired).toContain("isWithinRange(date: Date");
    invalid.result.finalize();
    invalid.result.cleanup();

    const failing = await runScenario("failing");
    expect(failing.result.totals.failures).toBe(1);
    expect(failing.result.captures.find((capture) => capture.role === "task-2")!.changed).toBe(false);
    expect(failing.result.totals.repairEdits).toBe(2);
    expect(existsSync(failing.result.repoRoot)).toBe(true);
    failing.result.finalize();
    failing.result.cleanup();
    expect(existsSync(failing.result.repoRoot)).toBe(false);
  }, 120_000);

  it("runs hermetically and refuses dirty inputs, tampered corpora, and evidence destruction", async () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);

    const dirty = workspace();
    writeFileSync(join(dirty, "leftover.txt"), "stale\n", "utf8");
    await expect(runBaselineTrial({
      corpusRoot,
      workspaceRoot: dirty,
      manifest,
      packetId: "D",
      sessionRunner: scriptedRunner(loadScenario("disjoint"), { requests: [], probes: {} }),
      bounds: { task: REGISTERED_TASK_ROLE_BOUNDS, integration: REGISTERED_INTEGRATION_ROLE_BOUNDS }
    })).rejects.toThrow(/dirty starting/);

    const tampered = mkdtempSync(join(tmpdir(), "strata-baseline-tampered-"));
    temporary.push(tampered);
    cpSync(corpusRoot, tampered, { recursive: true });
    const target = join(tampered, "src/lib/dateRange.ts");
    writeFileSync(target, `${readFileSync(target, "utf8")}// drift\n`, "utf8");
    await expect(runBaselineTrial({
      corpusRoot: tampered,
      workspaceRoot: workspace(),
      manifest,
      packetId: "D",
      sessionRunner: scriptedRunner(loadScenario("disjoint"), { requests: [], probes: {} }),
      bounds: { task: REGISTERED_TASK_ROLE_BOUNDS, integration: REGISTERED_INTEGRATION_ROLE_BOUNDS }
    })).rejects.toThrow(/corpus mirror/);

    const { result } = await runScenario("disjoint");
    expect(result.gitEnv.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(result.gitEnv.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(result.gitEnv.GIT_TERMINAL_PROMPT).toBe("0");
    expect(git(result.repoRoot, ["config", "--local", "user.name"]).trim().length).toBeGreaterThan(0);

    expect(() => result.cleanup()).toThrow(/finalize/);
    const events = result.events.splice(result.events.findIndex((event) => event.type === "capture"), 1);
    expect(events).toHaveLength(1);
    expect(() => result.finalize()).toThrow(/missing event/);
  }, 60_000);

  it("rejects a manifest whose registration digest drifted before any session", async () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    const tampered = structuredClone(manifest) as any;
    tampered.packets.D.allowedSourcePaths.push("src/store.ts");
    const observed = { requests: [] as BaselineSessionRequest[], probes: {} };
    await expect(runBaselineTrial({
      corpusRoot,
      workspaceRoot: workspace(),
      manifest: tampered,
      packetId: "D",
      sessionRunner: scriptedRunner(loadScenario("disjoint"), observed),
      bounds: { task: REGISTERED_TASK_ROLE_BOUNDS, integration: REGISTERED_INTEGRATION_ROLE_BOUNDS }
    })).rejects.toThrow(/registration digest/);
    expect(observed.requests).toHaveLength(0);
  }, 30_000);

  it("returns a deeply frozen manifest from qualification", () => {
    const manifest = createQualifiedTaskManifest(corpusRoot);
    expect(() => { (manifest as any).sourceDigest = "0".repeat(64); }).toThrow();
    expect(() => { (manifest.packets.D as any).allowedSourcePaths.push("src/store.ts"); }).toThrow();
    expect(() => { (manifest.targets.User as any).stableId = "0".repeat(16); }).toThrow();
    expect(() => { (manifest.boundary as any).push(manifest.boundary[0]); }).toThrow();
  });
});
