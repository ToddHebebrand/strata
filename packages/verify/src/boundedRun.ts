import { spawn } from "node:child_process";

export interface BoundedRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface BoundedProcessRunOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

/** Per-stream capture bound, mirroring the bridge's stderr discipline. */
const MAX_CAPTURE_BYTES = 1024 * 1024;

/**
 * How long we keep waiting for stdout/stderr to close after the child itself
 * exited. A descendant holding the inherited pipe open would otherwise wedge
 * the promise; after this grace we kill the group and settle with what we have.
 */
const STREAM_CLOSE_GRACE_MS = 2_000;

/** Upper bound on the post-SIGKILL wait for the process group to disappear. */
const GROUP_DRAIN_BUDGET_MS = 10_000;
const GROUP_DRAIN_POLL_MS = 5;

/**
 * Spawns the command DETACHED as its own process group and awaits exit.
 *
 * On timeout, SIGKILLs the whole group (`kill(-pid)`) so descendants the child
 * spawned die with it, then resolves `{ timedOut: true }`.
 *
 * ORDERING CONTRACT (load-bearing, do not relax): when `timedOut` is true the
 * process group is already GONE by the time this promise resolves — the group
 * kill is issued, the child's exit is awaited, and the group is polled until
 * `kill(-pgid, 0)` reports ESRCH, all before resolving. The kernel's
 * operational-failure path releases and re-queues a change set the instant a
 * timeout error propagates, so a still-running first attempt would race a
 * second attempt over the same scratch tree.
 */
export function boundedProcessRun(
  options: BoundedProcessRunOptions
): Promise<BoundedRunResult> {
  return new Promise<BoundedRunResult>((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      // Group leader: its pid IS the process group id, so kill(-pid) reaches
      // every descendant that did not itself detach.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let exited = false;
    let openStreams = 2;
    let exitStatus: number | null = null;
    let streamGrace: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const remaining = MAX_CAPTURE_BYTES - stdoutBytes;
      if (remaining <= 0) return;
      stdout += chunk.slice(0, remaining);
      stdoutBytes += Math.min(chunk.length, remaining);
    });
    child.stderr?.on("data", (chunk: string) => {
      const remaining = MAX_CAPTURE_BYTES - stderrBytes;
      if (remaining <= 0) return;
      stderr += chunk.slice(0, remaining);
      stderrBytes += Math.min(chunk.length, remaining);
    });
    child.stdout?.on("close", () => {
      openStreams -= 1;
      maybeSettle();
    });
    child.stderr?.on("close", () => {
      openStreams -= 1;
      maybeSettle();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (streamGrace !== undefined) clearTimeout(streamGrace);
      if (settled) return;
      settled = true;
      reject(error);
    });

    child.on("exit", (code) => {
      exited = true;
      exitStatus = code;
      clearTimeout(timer);
      if (openStreams > 0 && streamGrace === undefined) {
        // A descendant is still holding the inherited pipe. Give it a bounded
        // grace, then kill the group so the pipe closes and we can settle.
        streamGrace = setTimeout(() => {
          killGroup(child.pid);
          streamGrace = setTimeout(() => {
            openStreams = 0;
            maybeSettle();
          }, STREAM_CLOSE_GRACE_MS);
        }, STREAM_CLOSE_GRACE_MS);
      }
      maybeSettle();
    });

    function maybeSettle(): void {
      if (settled || !exited || openStreams > 0) return;
      settled = true;
      if (streamGrace !== undefined) clearTimeout(streamGrace);
      const finish = (): void => {
        resolve({ status: exitStatus, stdout, stderr, timedOut });
      };
      if (!timedOut) {
        finish();
        return;
      }
      // Kill-before-resolve: the child is reaped, but orphaned descendants are
      // reparented and reaped asynchronously. Only resolve once the group is
      // observably empty.
      void awaitGroupDrained(child.pid).then(finish, finish);
    }
  });
}

/**
 * SIGKILLs the whole process group. Falls back to killing just the direct
 * child if the group signal fails (an already-reaped leader yields ESRCH).
 */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/**
 * Polls until no process remains in the group (`kill(-pgid, 0)` → ESRCH), or
 * the budget elapses. Never rejects: a drain we could not confirm still has to
 * hand the caller its timeout result.
 */
async function awaitGroupDrained(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  const deadline = Date.now() + GROUP_DRAIN_BUDGET_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return;
    }
    await new Promise((wake) => setTimeout(wake, GROUP_DRAIN_POLL_MS));
  }
}
