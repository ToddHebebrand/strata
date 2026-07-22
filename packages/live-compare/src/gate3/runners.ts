// Gate 3 (unkeyed noninferiority), Task 4: cold + warm run drivers.
//
// `runCold` spawns a FRESH child per arm per pair (process-cold both arms —
// each sample is a brand-new process, proven by a distinct `childPid` per
// sample). `runWarm` spawns exactly TWO persistent children (one per arm),
// started once, and drives `n` interleaved balanced-paired iterations
// through them in per-iteration lockstep.
//
// Warm lockstep note (see task-4-report.md for the full writeup): the
// compiled Task-2 children (`kernel-child.js`, `sqlite-child.js`) compute
// their `iterations` count EAGERLY in a plain `for` loop — verified by
// reading kernel-child.ts/sqlite-child.ts directly, not assumed. If both
// warm children were started with their full `iterations` count upfront and
// left to run freely, they would execute concurrently as two separate OS
// processes, contaminating each other's timed windows. `child-protocol.ts`
// therefore gained an additive, backward-compatible `stepped` request field:
// when true, each child awaits one `ChildStepRequest` line per iteration
// before computing that iteration's mutation, instead of auto-looping. This
// driver holds that gate: it only ever has ONE step in flight across BOTH
// children at a time, so the two arms never race.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { credentialFreeEnv } from "../gate1.js";
import type { ChildRenameTarget, ChildResult } from "./child-protocol.js";
import {
  runBalancedSchedule,
  type ArmSampleInput,
  type BalancedScheduleResult,
  type PairOrder,
  type Sample,
  type SchedulePair
} from "./schedule.js";
import { nearestRankDistribution } from "./stats.js";

// `__dirname` here is this FILE's own directory — `src/gate3` when this
// module runs as source (vitest transpiles tests/*.ts and imports it
// directly from src/), or `dist/gate3` when it runs compiled. Either way,
// going up two levels lands on the package root, so `packageRoot` is
// context-independent — but the children the driver spawns must always be
// the COMPILED entrypoints (`node <entry>.js` needs real JS, not a .ts
// source file), so their paths are always rooted at `dist/gate3/`
// regardless of which context `__dirname` itself resolved from. Mirrors
// gate3ChildHarness.ts's `resolve(import.meta.dirname, "../dist/gate3/...")`.
const packageRoot = resolve(__dirname, "..", "..");
const repoRoot = resolve(packageRoot, "..", "..");

function kernelChildEntry(): string {
  return resolve(packageRoot, "dist", "gate3", "kernel-child.js");
}
function sqliteChildEntry(): string {
  return resolve(packageRoot, "dist", "gate3", "sqlite-child.js");
}

/** What a run driver needs to know about the corpus it's timing against. */
export interface RunnerCorpus {
  corpusRoot: string;
  corpus: Sample["corpus"];
  target: ChildRenameTarget;
}

const DEFAULT_COLD_KERNEL_TIMEOUT_MS = 180_000;
const DEFAULT_COLD_SQLITE_TIMEOUT_MS = 60_000;
const DEFAULT_WARM_STEP_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Shared: a FIFO async line queue over a child's stdout, plus exit tracking.
// ---------------------------------------------------------------------------

interface ChildLineFeed {
  /** Resolves with the next stdout line, or rejects if the child exits/errors before one arrives, or the wait times out. */
  nextLine(timeoutMs: number): Promise<string>;
  /** Resolves with the child's exit code once it has exited (does not itself wait for any particular line first). */
  exited: Promise<number | null>;
  stderrText(): string;
}

function attachChildLineFeed(child: ChildProcessWithoutNullStreams, label: string): ChildLineFeed {
  const queued: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  const stderrChunks: Buffer[] = [];
  let terminalError: Error | null = null;
  let ended = false;

  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(line);
    else queued.push(line);
  });
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const exited = new Promise<number | null>((resolveExit) => {
    child.once("error", (error) => {
      terminalError = error;
      ended = true;
      while (waiters.length > 0) waiters.shift()!.reject(error);
      resolveExit(null);
    });
    child.once("exit", (code) => {
      ended = true;
      if (code !== 0 && terminalError === null) {
        terminalError = new Error(
          `${label}: exited ${code}: ${Buffer.concat(stderrChunks).toString("utf8")}`
        );
      }
      const failure = terminalError;
      if (failure) {
        while (waiters.length > 0) waiters.shift()!.reject(failure);
      }
      resolveExit(code);
    });
  });

  return {
    nextLine(timeoutMs: number): Promise<string> {
      if (queued.length > 0) return Promise.resolve(queued.shift()!);
      if (ended) {
        return Promise.reject(terminalError ?? new Error(`${label}: process ended without another line`));
      }
      return new Promise((resolveLine, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`${label}: timed out after ${timeoutMs}ms waiting for a line`));
        }, timeoutMs);
        waiters.push({
          resolve: (line) => {
            clearTimeout(timer);
            resolveLine(line);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          }
        });
      });
    },
    exited,
    stderrText: () => Buffer.concat(stderrChunks).toString("utf8")
  };
}

function parseLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Cold: one fresh child per arm per pair.
// ---------------------------------------------------------------------------

/**
 * Exported (not just an internal helper) so the driver's own error/kill
 * behavior is directly testable without going through a full `runCold`
 * balanced schedule — see gate3RunnersUnit.test.ts's protocol-violation
 * case, which spawns a stub entrypoint that deliberately breaks the wire
 * contract and asserts both that this rejects AND that the spawned process
 * is actually dead afterward (no leaked child).
 */
export function runChildOnce(entry: string, request: unknown, timeoutMs: number): Promise<ChildResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: repoRoot,
      env: credentialFreeEnv(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    const feed = attachChildLineFeed(child, entry);
    const results: ChildResult[] = [];
    let sawDone = false;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        child.kill("SIGKILL");
        reject(new Error(`child ${entry} timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    void (async () => {
      try {
        // Exactly one ChildResult line then a done line, per cold-mode contract.
        const resultLine = await feed.nextLine(timeoutMs);
        const parsedResult = parseLine(resultLine);
        if (parsedResult.done === true) {
          throw new Error(`child ${entry}: received terminal "done" before any result`);
        }
        results.push(parsedResult as unknown as ChildResult);

        const doneLine = await feed.nextLine(timeoutMs);
        const parsedDone = parseLine(doneLine);
        if (parsedDone.done !== true) {
          throw new Error(`child ${entry}: expected terminal "done" line, got ${doneLine}`);
        }
        sawDone = true;

        const code = await feed.exited;
        clearTimeout(timer);
        settle(() => {
          if (code !== 0 || !sawDone || results.length !== 1) {
            reject(
              new Error(
                `child ${entry} exited ${code} (sawDone=${sawDone}, results=${results.length}): ${feed.stderrText()}`
              )
            );
            return;
          }
          resolvePromise(results[0]!);
        });
      } catch (error) {
        clearTimeout(timer);
        // Symmetric with the timeout branch above and with runWarm's catch:
        // a wire-protocol mismatch (unexpected line shape, premature "done",
        // etc.) means we can no longer trust this child to behave, so it
        // gets killed here too, not just on a timeout. kernel-child.js in
        // particular owns a real `strata-kernel-service` daemon subprocess
        // — leaving it running on a protocol violation would leak a process
        // (and, for the kernel arm, a daemon) per failed cold sample.
        if (!child.killed) child.kill("SIGKILL");
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    })();

    child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });
}

export interface RunColdOptions {
  n: number;
  seed: number;
  /** Per-arm spawn/drive timeouts; defaults are generous for a real medium-corpus cold rename. */
  timeoutMs?: { kernel?: number; sqlite?: number };
}

export interface RunColdResult {
  pairs: SchedulePair[];
  samples: Sample[];
}

/**
 * Runs `n` balanced-paired mutations, each arm of each pair a brand-new
 * spawned child process (cold: `iterations` forced to 1 by the wire
 * protocol). Every sample's `childPid` is that fresh process's own PID —
 * `n` kernel samples should therefore report `n` distinct PIDs.
 */
export async function runCold(corpus: RunnerCorpus, options: RunColdOptions): Promise<RunColdResult> {
  const { n, seed } = options;
  const kernelTimeoutMs = options.timeoutMs?.kernel ?? DEFAULT_COLD_KERNEL_TIMEOUT_MS;
  const sqliteTimeoutMs = options.timeoutMs?.sqlite ?? DEFAULT_COLD_SQLITE_TIMEOUT_MS;

  const request = { corpusRoot: corpus.corpusRoot, target: corpus.target, mode: "cold" as const, iterations: 1 };

  const runArm = async (arm: "kernel" | "sqlite"): Promise<ArmSampleInput> => {
    const entry = arm === "kernel" ? kernelChildEntry() : sqliteChildEntry();
    const timeoutMs = arm === "kernel" ? kernelTimeoutMs : sqliteTimeoutMs;
    const result = await runChildOnce(entry, request, timeoutMs);
    return {
      arm,
      corpus: corpus.corpus,
      mode: "cold",
      callerWallNs: result.callerWallNs,
      childMaxRssBytes: result.childMaxRssBytes,
      published: true,
      childPid: result.childPid
    };
  };

  const runPair = async (order: PairOrder): Promise<{ kernel: ArmSampleInput; sqlite: ArmSampleInput }> => {
    if (order === "AB") {
      const kernel = await runArm("kernel");
      const sqlite = await runArm("sqlite");
      return { kernel, sqlite };
    }
    const sqlite = await runArm("sqlite");
    const kernel = await runArm("kernel");
    return { kernel, sqlite };
  };

  const schedule = await runBalancedSchedule({ corpus: corpus.corpus, mode: "cold", n, seed, runPair });
  return { pairs: schedule.pairs, samples: schedule.samples };
}

// ---------------------------------------------------------------------------
// Warm: two persistent children, driven in strict per-iteration lockstep.
// ---------------------------------------------------------------------------

interface WarmChildHandle {
  pid: number;
  /** Sends one step signal and awaits exactly the one ChildResult it unblocks. Never call concurrently on the same handle. */
  step(): Promise<ChildResult>;
  /** Ends stdin, awaits the terminal "done" line and exit(0). Call only after `iterations` `step()` calls have completed. */
  finish(): Promise<void>;
  /** Best-effort teardown for an error path — safe to call even if the child already exited. */
  kill(): void;
}

function startWarmChild(
  entry: string,
  corpusRoot: string,
  target: ChildRenameTarget,
  iterations: number,
  timeoutMs: number
): WarmChildHandle {
  const child = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    env: credentialFreeEnv(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (child.pid === undefined) {
    throw new Error(`${entry}: spawn returned no pid`);
  }
  const pid = child.pid;
  const feed = attachChildLineFeed(child, entry);

  const initialRequest = { corpusRoot, target, mode: "warm" as const, iterations, stepped: true };
  child.stdin.write(`${JSON.stringify(initialRequest)}\n`);

  return {
    pid,
    async step(): Promise<ChildResult> {
      child.stdin.write(`${JSON.stringify({ step: true })}\n`);
      const line = await feed.nextLine(timeoutMs);
      const parsed = parseLine(line);
      if (parsed.done === true) {
        throw new Error(`${entry}: received terminal "done" before the expected step result`);
      }
      return parsed as unknown as ChildResult;
    },
    async finish(): Promise<void> {
      child.stdin.end();
      const line = await feed.nextLine(timeoutMs);
      const parsed = parseLine(line);
      if (parsed.done !== true) {
        throw new Error(`${entry}: expected terminal "done" line after the last step, got ${line}`);
      }
      const code = await feed.exited;
      if (code !== 0) {
        throw new Error(`${entry}: exited ${code} after "done": ${feed.stderrText()}`);
      }
    },
    kill(): void {
      if (!child.killed) child.kill("SIGKILL");
    }
  };
}

export interface RunWarmOptions {
  n: number;
  seed: number;
  /** Finite pre-registered ceiling on `n` for this warm run — `n` beyond it is refused, not silently honored. */
  warmHorizon: number;
  /** Per-step read timeout for both persistent children; defaults are generous for a real medium-corpus rename. */
  timeoutMs?: number;
}

/** p95(kernel)/p95(sqlite) over one half of the paired samples — see runners.ts module doc / task-4-report.md for the exact split rule. */
export interface WarmTrend {
  firstHalfP95Ratio: number;
  lastHalfP95Ratio: number;
}

export interface RunWarmResult {
  pairs: SchedulePair[];
  samples: Sample[];
  trend: WarmTrend;
}

/**
 * Splits `pairs` (in iteration/pairId order) into a first and last half of
 * EQUAL size, dropping the middle pair on an odd count (so neither half is
 * ever double-counted), and returns the nearest-rank p95(kernel)/p95(sqlite)
 * wall ratio computed independently within each half. This is the
 * nonexchangeability check: if warm-up/thermal/GC drift is biasing one arm
 * over the course of a run, the two halves' ratios diverge.
 *
 * Exported for direct unit coverage of the odd-`n` split rule
 * (gate3RunnersUnit.test.ts) — a pure function on synthetic `SchedulePair`s,
 * no children needed.
 */
export function computeWarmTrend(pairs: readonly SchedulePair[]): WarmTrend {
  const half = Math.floor(pairs.length / 2);
  if (half < 1) {
    throw new Error(`computeWarmTrend: need at least 2 pairs (1 per half), got ${pairs.length}`);
  }
  const firstHalf = pairs.slice(0, half);
  const lastHalf = pairs.slice(pairs.length - half);

  const ratioOf = (subset: readonly SchedulePair[]): number => {
    const kernelP95 = nearestRankDistribution(subset.map((pair) => pair.kernel.callerWallNs)).p95;
    const sqliteP95 = nearestRankDistribution(subset.map((pair) => pair.sqlite.callerWallNs)).p95;
    return kernelP95 / sqliteP95;
  };

  return { firstHalfP95Ratio: ratioOf(firstHalf), lastHalfP95Ratio: ratioOf(lastHalf) };
}

/**
 * Starts exactly TWO persistent children (one per arm) once, then drives `n`
 * balanced-paired iterations through them via `runBalancedSchedule`, holding
 * per-iteration lockstep: only one child is ever mid-step at a time, in the
 * pair's seeded order, so the two arms' timed windows never overlap even
 * though both processes stay alive for the whole run.
 */
export async function runWarm(corpus: RunnerCorpus, options: RunWarmOptions): Promise<RunWarmResult> {
  const { n, seed, warmHorizon } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WARM_STEP_TIMEOUT_MS;

  if (!Number.isInteger(n) || n < 2) {
    throw new Error(`runWarm: n must be an integer >= 2 (need at least 1 pair per trend half), got ${n}`);
  }
  if (!Number.isInteger(warmHorizon) || warmHorizon < 1) {
    throw new Error(`runWarm: warmHorizon must be a positive integer, got ${warmHorizon}`);
  }
  if (n > warmHorizon) {
    throw new Error(`runWarm: n (${n}) exceeds the pre-registered warmHorizon (${warmHorizon})`);
  }

  const kernelChild = startWarmChild(kernelChildEntry(), corpus.corpusRoot, corpus.target, n, timeoutMs);
  const sqliteChild = startWarmChild(sqliteChildEntry(), corpus.corpusRoot, corpus.target, n, timeoutMs);

  const toArmSample = (arm: "kernel" | "sqlite", result: ChildResult): ArmSampleInput => ({
    arm,
    corpus: corpus.corpus,
    mode: "warm",
    callerWallNs: result.callerWallNs,
    childMaxRssBytes: result.childMaxRssBytes,
    published: true,
    childPid: result.childPid
  });

  const runPair = async (order: PairOrder): Promise<{ kernel: ArmSampleInput; sqlite: ArmSampleInput }> => {
    // Strict lockstep: the second child's step is only sent after the
    // first child's result has actually arrived, never concurrently.
    if (order === "AB") {
      const kernelResult = await kernelChild.step();
      const sqliteResult = await sqliteChild.step();
      return { kernel: toArmSample("kernel", kernelResult), sqlite: toArmSample("sqlite", sqliteResult) };
    }
    const sqliteResult = await sqliteChild.step();
    const kernelResult = await kernelChild.step();
    return { kernel: toArmSample("kernel", kernelResult), sqlite: toArmSample("sqlite", sqliteResult) };
  };

  let schedule: BalancedScheduleResult;
  try {
    schedule = await runBalancedSchedule({ corpus: corpus.corpus, mode: "warm", n, seed, runPair });
    await Promise.all([kernelChild.finish(), sqliteChild.finish()]);
  } catch (error) {
    kernelChild.kill();
    sqliteChild.kill();
    throw error;
  }

  const trend = computeWarmTrend(schedule.pairs);
  return { pairs: schedule.pairs, samples: schedule.samples, trend };
}
