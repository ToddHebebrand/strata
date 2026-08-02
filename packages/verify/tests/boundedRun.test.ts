import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundedProcessRun } from "../src/boundedRun";

const temporaryRoots: string[] = [];

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), "strata-bounded-run-"));
  temporaryRoots.push(root);
  return root;
}

/**
 * A child that spawns a NON-detached grandchild (so the grandchild inherits
 * the child's process group) and then never exits. Both pids are written to
 * files. This is the exact shape `child.kill()` alone cannot clean up: the
 * direct child dies, the grandchild survives holding the corpus tree — which
 * is why the bounded runner must SIGKILL the whole process group.
 */
function writeGrandchildSleeper(root: string): string {
  const script = path.join(root, "sleeper.cjs");
  writeFileSync(
    script,
    [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      "const dir = process.argv[2];",
      'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {',
      '  stdio: "ignore"',
      "});",
      'fs.writeFileSync(dir + "/child.pid", String(process.pid));',
      'fs.writeFileSync(dir + "/grandchild.pid", String(grandchild.pid));',
      "setInterval(() => {}, 1000);"
    ].join("\n")
  );
  return script;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

async function waitForFile(file: string, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${file}`);
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe("boundedProcessRun", () => {
  it("SIGKILLs the whole process group on timeout and only resolves once it is dead", async () => {
    const root = scratch();
    const script = writeGrandchildSleeper(root);

    const started = Date.now();
    const result = await boundedProcessRun({
      command: process.execPath,
      args: [script, root],
      cwd: root,
      timeoutMs: 1_000
    });
    const elapsed = Date.now() - started;

    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(900);

    // Both pids were recorded by the sleeper before it hung.
    await waitForFile(path.join(root, "grandchild.pid"), 1_000);
    const childPid = Number(readFileSync(path.join(root, "child.pid"), "utf8"));
    const grandchildPid = Number(
      readFileSync(path.join(root, "grandchild.pid"), "utf8")
    );
    expect(childPid).toBeGreaterThan(0);
    expect(grandchildPid).toBeGreaterThan(0);
    expect(grandchildPid).not.toBe(childPid);

    // Kill-before-resolve ordering: the operational requeue path re-offers a
    // change set the instant the timeout error propagates, so by the time this
    // promise resolved BOTH processes must already be gone. No polling here —
    // that is the contract under test.
    expect(alive(childPid)).toBe(false);
    expect(alive(grandchildPid)).toBe(false);
  }, 20_000);

  it("returns the exit status of a fast command without timing out", async () => {
    const root = scratch();
    const result = await boundedProcessRun({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok'); process.stderr.write('err')"],
      cwd: root,
      timeoutMs: 30_000
    });

    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ok");
    expect(result.stderr).toContain("err");
  }, 20_000);

  it("reports a nonzero exit status without timing out", async () => {
    const root = scratch();
    const result = await boundedProcessRun({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      cwd: root,
      timeoutMs: 30_000
    });

    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(3);
  }, 20_000);
});
