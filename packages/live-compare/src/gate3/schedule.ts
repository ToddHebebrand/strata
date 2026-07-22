// Gate 3 (unkeyed noninferiority), Task 3: the balanced paired AB/BA
// scheduler. Drives `n` paired mutations — one kernel-arm sample and one
// sqlite-arm sample per pair — with the run order for each pair (kernel
// first vs sqlite first) chosen by a seeded PRNG, so systematic
// warm-up/ordering drift cannot bias one arm. The actual mechanics of
// running a pair (spawning fresh cold children, or driving two persistent
// warm children) are injected via `runPair` — this module only owns pairing,
// ordering, and sample tagging. Task 4 builds the real cold/warm drivers on
// top of this.
import { seededRng } from "./stats.js";

/** "AB" = kernel-then-sqlite runs first this pair; "BA" = sqlite-then-kernel runs first. Kernel is always "A", sqlite is always "B". */
export type PairOrder = "AB" | "BA";

/** One timed mutation sample — the shared gate-3 `Sample` vocabulary (plan `docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md`, "Shared vocabulary"). */
export interface Sample {
  arm: "kernel" | "sqlite";
  corpus: "medium" | "big1k" | "baseline";
  mode: "cold" | "warm";
  pairId: number;
  order: PairOrder;
  iteration: number;
  callerWallNs: number;
  childMaxRssBytes: number;
  published: true;
  /**
   * Task 4 addition: the child process's own PID, when the sample came from
   * a real spawned child (`runCold`/`runWarm` always set this). Optional so
   * pre-existing hand-built `ArmSampleInput` literals (Task 3's scheduler
   * tests, which don't spawn real children) keep compiling unchanged.
   */
  childPid?: number;
}

/**
 * What `runPair` reports for one arm of one pair: everything a `Sample`
 * needs EXCEPT the fields the scheduler itself assigns (`pairId`, `order`,
 * `iteration`) — `runPair` only receives `order` as input, not a pair
 * index, so it cannot know its own `pairId`/`iteration` ahead of the
 * scheduler tagging them on return. See task-3-report.md for this
 * interpretation of the brief's `runPair: (order) => Promise<{kernel:Sample,
 * sqlite:Sample}>` signature.
 */
export type ArmSampleInput = Omit<Sample, "pairId" | "order" | "iteration">;

export interface SchedulePair {
  pairId: number;
  order: PairOrder;
  kernel: Sample;
  sqlite: Sample;
}

export interface RunBalancedScheduleOptions {
  corpus: Sample["corpus"];
  mode: Sample["mode"];
  /** Number of pairs to run. */
  n: number;
  seed: number;
  /** Runs both arms for one pair, in the given order, and reports each arm's outcome. */
  runPair: (order: PairOrder) => Promise<{ kernel: ArmSampleInput; sqlite: ArmSampleInput }>;
}

export interface BalancedScheduleResult {
  pairs: SchedulePair[];
  /** Flattened `kernel, sqlite` per pair, in pair order — `2 * pairs.length` entries. */
  samples: Sample[];
}

/**
 * Runs `n` paired mutations (one per arm each), tagging every resulting
 * `Sample` with `{ pairId, order, iteration }`. `order` for pair `i` is
 * chosen by `seededRng(seed)`'s `i`-th draw (`< 0.5` -> "AB", else "BA"), so
 * the realized order sequence is fully deterministic for a fixed seed —
 * required for a reproducible, auditable schedule.
 */
export async function runBalancedSchedule(opts: RunBalancedScheduleOptions): Promise<BalancedScheduleResult> {
  const { n, seed, runPair } = opts;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`runBalancedSchedule: n must be a positive integer, got ${n}`);
  }

  const rng = seededRng(seed);
  const pairs: SchedulePair[] = [];
  const samples: Sample[] = [];

  for (let pairId = 0; pairId < n; pairId += 1) {
    const order: PairOrder = rng() < 0.5 ? "AB" : "BA";
    const outcome = await runPair(order);

    const kernelSample: Sample = { ...outcome.kernel, pairId, order, iteration: pairId };
    const sqliteSample: Sample = { ...outcome.sqlite, pairId, order, iteration: pairId };

    if (kernelSample.arm !== "kernel") {
      throw new Error(`runBalancedSchedule: pair ${pairId} runPair().kernel.arm was ${kernelSample.arm}, not "kernel"`);
    }
    if (sqliteSample.arm !== "sqlite") {
      throw new Error(`runBalancedSchedule: pair ${pairId} runPair().sqlite.arm was ${sqliteSample.arm}, not "sqlite"`);
    }

    pairs.push({ pairId, order, kernel: kernelSample, sqlite: sqliteSample });
    samples.push(kernelSample, sqliteSample);
  }

  return { pairs, samples };
}
