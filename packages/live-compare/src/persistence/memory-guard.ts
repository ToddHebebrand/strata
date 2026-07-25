// Bridge-persistence slice, Task 9: true-process RSS guard — the A3
// exit-verdict memory component (plan v2, review M5).
//
// The recorded gate-3 harness measured the CHILD HARNESS process's maxRSS, a
// placeholder that never observed the daemon or its bridge worker. A3
// replaces that placeholder with THIS module's predicate over the real
// processes, sampled from the OS:
//
//   measureTrueRss  — `ps -o rss= -p <pid>` per process (KiB -> bytes): the
//                     kernel's own resident-set accounting, not a
//                     self-report.
//
//   PID continuity  — the daemon PID is the spawned child's; the persistent
//                     worker PID is discovered from the OS as the daemon's
//                     `node .../worker.js --persistent` child (`pgrep -P`).
//                     The daemon exposes no worker PID over the protocol,
//                     deliberately: this guard adds NO protocol surface.
//                     Every sample re-verifies both PIDs are alive AND
//                     unchanged since sampler creation — a worker respawn
//                     produces a new PID, so a respawn (silent or not) is a
//                     continuity violation that invalidates the run: RSS of
//                     a fresh worker says nothing about the leak behavior of
//                     the one that died.
//
//   Sampling protocol (pre-registered): one sample immediately after each
//   mutation publishes, plus one after a `QUIESCENCE_MS` = 200 ms quiescence
//   beat; the per-iteration high-water is the max of the two; the FULL
//   sample series is retained on the sampler for the artifact.
//
//   Predicates (pre-registered, constants below): the medium leak check
//   (`LEAK_FACTOR`) and the absolute big1k combined-RSS cap
//   (`PERSISTENT_1K_RSS_CAP`), both consumed by Task 11's A3 wiring through
//   `persistentMemoryVerdict`.
//
// See docs/superpowers/plans/2026-07-23-bridge-persistence-slice.md, Task 9.
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Pre-registered constants.
// ---------------------------------------------------------------------------

/**
 * Medium leak predicate factor, pre-registered: over `MEDIUM_LEAK_ITERATIONS`
 * = 12 warm mutations on examples/medium with `--persistent-bridge`, the
 * high-water of iterations 9-12 must be ≤ the high-water of iterations 1-4
 * × 1.15. A persistent worker that accretes per-mutation state (mirror
 * copies, retained candidates, unbounded caches) shows up as tail growth the
 * warm baseline cannot absorb.
 */
export const LEAK_FACTOR = 1.15;

/** The pre-registered medium leak-check series length (warm mutations). */
export const MEDIUM_LEAK_ITERATIONS = 12;

/** Pre-registered quiescence beat after the post-publish sample (ms). */
export const QUIESCENCE_MS = 200;

/**
 * Absolute combined daemon+persistent-worker RSS cap for big1k with
 * `--persistent-bridge`, stated BEFORE the exit run (A3).
 *
 * Measured basis (2026-07-24, one-off, release binary
 * `target/release/strata-kernel-service`, ×46 big1k replicated corpus
 * [1012 modules], `--persistent-bridge`, ONE published rename, sampled by
 * this module's `measureTrueRss`):
 *
 *   post-hydration (pre-mutation): daemon 133.4 MB + worker 744.8 MB
 *                                  = combined 878.2 MB (920,813,568 B) — the
 *                                  run's peak (eagerly hydrated 55.6k-node
 *                                  mirror before GC settles);
 *   post-publish:                  daemon 218.1 MB + worker 538.7 MB
 *                                  = combined 756.8 MB (793,575,424 B);
 *   quiescence (+200 ms):          daemon 167.2 MB + worker 514.3 MB
 *                                  = combined 681.5 MB (714,653,696 B).
 *
 * Cap = measured run-peak combined 878.2 MB × 1.5 ≈ 1317 MB, rounded UP to a
 * clean number: 1400 MB. (The ~508 MB one-shot worker figure predates
 * delta-sync and the hydrated persistent mirror; it was NOT reused — the cap
 * is set from measured persistent-bridge reality, using the run peak rather
 * than the smaller post-publish figure so a first post-publish sample taken
 * near the hydration transient cannot false-fail the exit run.)
 */
export const PERSISTENT_1K_RSS_CAP = 1400 * 1024 * 1024;

// ---------------------------------------------------------------------------
// True-process RSS measurement.
// ---------------------------------------------------------------------------

export interface GuardedPids {
  daemon: number;
  worker: number;
}

export interface TrueRssSample {
  /** Daemon resident set, bytes. */
  daemonRss: number;
  /** Persistent worker resident set, bytes. */
  workerRss: number;
  /** daemonRss + workerRss. */
  combined: number;
}

/** A retained sample point: the measurement plus its protocol position. */
export interface RssSamplePoint extends TrueRssSample {
  label: string;
  /** "post-publish" or "quiescence" per the pre-registered protocol. */
  phase: "post-publish" | "quiescence";
  atMs: number;
}

export interface IterationSample {
  label: string;
  postPublish: RssSamplePoint;
  quiescence: RssSamplePoint;
  /** max(postPublish.combined, quiescence.combined) — the pre-registered
   * per-iteration high-water. */
  highWaterBytes: number;
}

/** Thrown when a guarded PID dies or the worker PID changes mid-run. */
export class PidContinuityViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PidContinuityViolation";
  }
}

/** `ps -o pid=,rss= -p <pids>` — one call for all requested PIDs; returns
 * bytes per PID. PIDs `ps` omits are dead (or unobservable, which the guard
 * treats identically). */
function psRssBytes(pids: readonly number[]): Map<number, number> {
  const unique = [...new Set(pids)];
  let stdout = "";
  try {
    stdout = execFileSync("ps", ["-o", "pid=,rss=", "-p", unique.join(",")], {
      encoding: "utf8"
    });
  } catch (error) {
    // `ps` exits non-zero when NO requested pid exists; fall through with
    // whatever it printed (possibly nothing).
    stdout = (error as { stdout?: string }).stdout ?? "";
  }
  const result = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) result.set(Number(match[1]), Number(match[2]) * 1024);
  }
  return result;
}

/**
 * True OS-observed RSS of the daemon and persistent worker, in bytes.
 * Throws `PidContinuityViolation` if either PID is not alive.
 */
export function measureTrueRss(pids: GuardedPids): TrueRssSample {
  const rss = psRssBytes([pids.daemon, pids.worker]);
  const daemonRss = rss.get(pids.daemon);
  const workerRss = rss.get(pids.worker);
  if (daemonRss === undefined) {
    throw new PidContinuityViolation(`daemon PID ${pids.daemon} is not alive`);
  }
  if (workerRss === undefined) {
    throw new PidContinuityViolation(`worker PID ${pids.worker} is not alive`);
  }
  return { daemonRss, workerRss, combined: daemonRss + workerRss };
}

// ---------------------------------------------------------------------------
// Persistent-worker PID discovery (OS-side; no protocol surface).
// ---------------------------------------------------------------------------

/** `pgrep -P <pid>`: direct children. Exit code 1 = no children. */
function childPids(parentPid: number): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(parentPid)], { encoding: "utf8" })
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function commandOf(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/**
 * Discover the daemon's persistent bridge worker from the OS: the ONE direct
 * child whose argv carries the `--persistent` worker flag (the daemon spawns
 * it as `node .../worker.js --persistent`; bridge/persistent.rs). Returns
 * null when absent (not yet spawned, or dead). Throws if MORE than one
 * matches — two live persistent workers under one daemon violates the N=1
 * worker contract outright.
 */
export function discoverPersistentWorkerPid(daemonPid: number): number | null {
  const matches = childPids(daemonPid).filter((pid) => {
    const command = commandOf(pid);
    return command.includes("--persistent") && command.includes("worker");
  });
  if (matches.length > 1) {
    throw new PidContinuityViolation(
      `daemon ${daemonPid} has ${matches.length} persistent worker children (${matches.join(", ")}); expected exactly one`
    );
  }
  return matches[0] ?? null;
}

/** Poll for the eagerly-hydrated persistent worker child (Task 6 spawns it
 * at daemon startup) until it appears or `timeoutMs` elapses. */
export async function waitForPersistentWorkerPid(
  daemonPid: number,
  timeoutMs: number
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = discoverPersistentWorkerPid(daemonPid);
    if (pid !== null) return pid;
    if (Date.now() >= deadline) {
      throw new Error(`no persistent worker child of daemon ${daemonPid} within ${timeoutMs}ms`);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
}

// ---------------------------------------------------------------------------
// The sampler: PID continuity + the pre-registered sampling protocol.
// ---------------------------------------------------------------------------

export interface RssSampler {
  /** The PIDs fixed at creation; every sample re-verifies them. */
  pids(): GuardedPids;
  /** One continuity-checked sample (used by both protocol phases). Throws
   * `PidContinuityViolation` on death or respawn; the violation is sticky. */
  sample(label: string, phase: RssSamplePoint["phase"]): RssSamplePoint;
  /** The pre-registered per-iteration protocol: post-publish sample,
   * `QUIESCENCE_MS` beat, quiescence sample; high-water = max combined. */
  sampleIteration(label: string): Promise<IterationSample>;
  /** The full retained series, in sampling order. */
  samples(): readonly RssSamplePoint[];
  /** True iff no sample ever observed a death or respawn. */
  continuityHeld(): boolean;
}

/**
 * Create the run's sampler with the initial (spawn-time) PIDs. Continuity is
 * checked at EVERY sample: the daemon must be alive, the worker must be
 * alive, and the daemon's persistent-worker child discovered from the OS
 * must still BE the creation-time worker PID — a respawned worker (new PID)
 * flags the run invalid even though a live worker exists.
 */
export function createRssSampler(pids: GuardedPids): RssSampler {
  const initial: GuardedPids = { ...pids };
  const series: RssSamplePoint[] = [];
  const startMs = Date.now();
  let violated = false;

  const sample = (label: string, phase: RssSamplePoint["phase"]): RssSamplePoint => {
    try {
      const discovered = discoverPersistentWorkerPid(initial.daemon);
      if (discovered !== initial.worker) {
        throw new PidContinuityViolation(
          `persistent worker PID changed: expected ${initial.worker}, ` +
            (discovered === null ? "found none (worker dead)" : `found ${discovered} (respawn)`)
        );
      }
      const measured = measureTrueRss(initial);
      const point: RssSamplePoint = { label, phase, atMs: Date.now() - startMs, ...measured };
      series.push(point);
      return point;
    } catch (error) {
      violated = true;
      throw error;
    }
  };

  return {
    pids: () => ({ ...initial }),
    sample,
    async sampleIteration(label: string): Promise<IterationSample> {
      const postPublish = sample(label, "post-publish");
      await new Promise((resolveSleep) => setTimeout(resolveSleep, QUIESCENCE_MS));
      const quiescence = sample(label, "quiescence");
      return {
        label,
        postPublish,
        quiescence,
        highWaterBytes: Math.max(postPublish.combined, quiescence.combined)
      };
    },
    samples: () => series,
    continuityHeld: () => !violated
  };
}

// ---------------------------------------------------------------------------
// The A3 verdict.
// ---------------------------------------------------------------------------

export interface PersistentMemorySamples {
  /** Per-iteration high-waters of the N=12 warm medium mutations, in
   * iteration order (combined daemon+worker bytes). */
  mediumHighWaterBytes: readonly number[];
  /** Combined daemon+worker samples from the big1k exit run; when provided,
   * the absolute cap predicate is computed. */
  big1kCombinedBytes?: readonly number[];
}

export interface PersistentMemoryCaps {
  /** Defaults to the pre-registered `LEAK_FACTOR`. */
  leakFactor?: number;
  /** Defaults to the pre-registered `PERSISTENT_1K_RSS_CAP`. */
  persistent1kRssCapBytes?: number;
}

export interface PersistentMemoryVerdict {
  /** Medium leak check: tail (iterations 9-12) high-water ≤ baseline
   * (iterations 1-4) high-water × leakFactor. */
  leakPass: boolean;
  /** Absolute big1k cap check; present only when big1k samples were given. */
  capPass?: boolean;
  /** "pass" iff leakPass and (capPass, when computed). */
  state: "pass" | "fail";
  baselineHighWaterBytes: number;
  tailHighWaterBytes: number;
  leakLimitBytes: number;
  big1kPeakBytes?: number;
  persistent1kRssCapBytes?: number;
}

/**
 * The A3 memory predicate, consumed by Task 11's exit-gate wiring. The
 * medium leak check always runs (requires the full pre-registered
 * `MEDIUM_LEAK_ITERATIONS`-length series); the absolute big1k cap check runs
 * exactly when `big1kCombinedBytes` is provided.
 */
export function persistentMemoryVerdict(
  samples: PersistentMemorySamples,
  caps: PersistentMemoryCaps = {}
): PersistentMemoryVerdict {
  const series = samples.mediumHighWaterBytes;
  if (series.length < MEDIUM_LEAK_ITERATIONS) {
    throw new Error(
      `medium leak check requires the pre-registered N=${MEDIUM_LEAK_ITERATIONS} ` +
        `iteration high-water series; got ${series.length}`
    );
  }
  const leakFactor = caps.leakFactor ?? LEAK_FACTOR;
  const baselineHighWaterBytes = Math.max(...series.slice(0, 4));
  const tailHighWaterBytes = Math.max(...series.slice(MEDIUM_LEAK_ITERATIONS - 4, MEDIUM_LEAK_ITERATIONS));
  const leakLimitBytes = baselineHighWaterBytes * leakFactor;
  const leakPass = tailHighWaterBytes <= leakLimitBytes;

  const verdict: PersistentMemoryVerdict = {
    leakPass,
    state: leakPass ? "pass" : "fail",
    baselineHighWaterBytes,
    tailHighWaterBytes,
    leakLimitBytes
  };
  if (samples.big1kCombinedBytes !== undefined) {
    if (samples.big1kCombinedBytes.length === 0) {
      throw new Error("big1k cap check requires at least one combined-RSS sample");
    }
    const persistent1kRssCapBytes = caps.persistent1kRssCapBytes ?? PERSISTENT_1K_RSS_CAP;
    const big1kPeakBytes = Math.max(...samples.big1kCombinedBytes);
    verdict.big1kPeakBytes = big1kPeakBytes;
    verdict.persistent1kRssCapBytes = persistent1kRssCapBytes;
    verdict.capPass = big1kPeakBytes <= persistent1kRssCapBytes;
    if (!verdict.capPass) verdict.state = "fail";
  }
  return verdict;
}
