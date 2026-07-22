// Gate 3 (unkeyed noninferiority), Task 3: nearest-rank distributions, a
// deterministic seeded PRNG, and the paired-bootstrap tri-state
// noninferiority verdict.
//
// Nearest-rank semantics are pinned to match
// crates/strata-kernel/src/bin/redb_spike.rs's `nearest_rank_distribution`
// exactly (percent*n, integer-ceil-divided, 1-indexed into the ascending
// sort): `rank = ceil((percent/100) * n)`, `value = sorted[rank - 1]`. This
// is deliberately NOT interpolated (no "R-7" style percentile) — every
// reported quantile is always an actual observed sample, never a blend.

/** `{ n, min, p50, p95, p99, max, mean, samples }` — nearest-rank quantiles over `samples` (retained in original order, not sorted). */
export interface WallDistribution {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  samples: number[];
}

/** 1-indexed nearest-rank lookup into an ALREADY ascending-sorted array. `percent` in (0,100]. */
function nearestRankValue(sortedAscending: readonly number[], percent: number): number {
  const n = sortedAscending.length;
  if (n === 0) {
    throw new Error("nearestRankValue: sortedAscending must be non-empty");
  }
  const rank = Math.ceil((percent / 100) * n);
  const index = Math.min(Math.max(rank, 1), n) - 1;
  return sortedAscending[index]!;
}

/** Nearest-rank distribution over `samples` (`redb_spike.rs` semantics). Throws on an empty array — there is no distribution over zero samples. */
export function nearestRankDistribution(samples: readonly number[]): WallDistribution {
  if (samples.length === 0) {
    throw new Error("nearestRankDistribution: samples must be non-empty");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = samples.reduce((total, value) => total + value, 0);
  return {
    n,
    min: sorted[0]!,
    p50: nearestRankValue(sorted, 50),
    p95: nearestRankValue(sorted, 95),
    p99: nearestRankValue(sorted, 99),
    max: sorted[n - 1]!,
    mean: sum / n,
    samples: [...samples]
  };
}

/**
 * Deterministic PRNG factory (mulberry32). Same seed -> identical infinite
 * output sequence, always. Returns values in `[0, 1)`.
 */
export function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return function mulberry32(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform random integer in `[0, exclusiveMax)`, drawn from `rng` (a `seededRng` instance). */
function randomIndex(rng: () => number, exclusiveMax: number): number {
  return Math.min(exclusiveMax - 1, Math.floor(rng() * exclusiveMax));
}

export interface PairedRatioBootstrap {
  /** p95(kernel) / p95(sqlite) over the ORIGINAL (unresampled) pairs. */
  pointRatio: number;
  /** 95th nearest-rank percentile of the resampled p95-ratio distribution — the one-sided 95% upper confidence bound. */
  ucb95: number;
  /** 5th nearest-rank percentile of the resampled p95-ratio distribution — the one-sided 95% lower confidence bound. */
  lcb95: number;
}

/**
 * Paired bootstrap on the p95(kernel)/p95(sqlite) wall ratio.
 *
 * Resamples PAIRS with replacement (never resamples the kernel and sqlite
 * arms independently — that would break the pairing that makes this a valid
 * paired design). Each of `resamples` draws builds a same-size (`pairs.length`)
 * resample of pairs, computes nearest-rank p95 separately over the resampled
 * kernel values and the resampled sqlite values, and records their ratio.
 * `ucb95`/`lcb95` are the 95th/5th nearest-rank percentiles of that resampled
 * ratio distribution.
 */
export function pairedP95RatioBootstrap(
  pairs: readonly { kernel: number; sqlite: number }[],
  seed: number,
  resamples = 10_000
): PairedRatioBootstrap {
  if (pairs.length === 0) {
    throw new Error("pairedP95RatioBootstrap: pairs must be non-empty");
  }
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new Error(`pairedP95RatioBootstrap: resamples must be a positive integer, got ${resamples}`);
  }

  const pointRatio =
    nearestRankDistribution(pairs.map((pair) => pair.kernel)).p95 /
    nearestRankDistribution(pairs.map((pair) => pair.sqlite)).p95;

  const rng = seededRng(seed);
  const n = pairs.length;
  const resampledRatios: number[] = new Array(resamples);
  for (let r = 0; r < resamples; r += 1) {
    const kernelDraw: number[] = new Array(n);
    const sqliteDraw: number[] = new Array(n);
    for (let i = 0; i < n; i += 1) {
      // Draw a PAIR index (not independent kernel/sqlite indices) so kernel
      // and sqlite stay yoked within a resample — this is what makes the
      // bootstrap "paired" rather than an unpaired two-sample comparison.
      const pair = pairs[randomIndex(rng, n)]!;
      kernelDraw[i] = pair.kernel;
      sqliteDraw[i] = pair.sqlite;
    }
    resampledRatios[r] = nearestRankDistribution(kernelDraw).p95 / nearestRankDistribution(sqliteDraw).p95;
  }

  const sortedRatios = resampledRatios.slice().sort((a, b) => a - b);
  return {
    pointRatio,
    ucb95: nearestRankValue(sortedRatios, 95),
    lcb95: nearestRankValue(sortedRatios, 5)
  };
}

export type RatioVerdictState = "PASS" | "FAIL" | "INCONCLUSIVE";

// ---------------------------------------------------------------------------
// Task 5 (half a): the baseline-adjusted, capped memory predicate.
// ---------------------------------------------------------------------------

/** Peak-RSS observations for one arm across the three gate-3 corpus sizes. */
export interface MemoryValues {
  /** Peak RSS on the single-copy control corpus. */
  baseline: number;
  /** Peak RSS on `examples/medium`. */
  medium: number;
  /** Peak RSS on the ~1012-module replicated corpus. */
  big1k: number;
}

/** Pre-registered absolute RSS caps, one per arm (`KERNEL_1K_RSS_CAP` / `SQLITE_1K_RSS_CAP`). */
export interface MemoryCaps {
  kernel: number;
  sqlite: number;
}

/** `{ arm, medium, big1k, baseline, absoluteCapPass, growthAdjusted, growthPass, state }` — the baseline-adjusted, capped memory verdict for one arm. */
export interface MemoryVerdict {
  arm: "kernel" | "sqlite";
  medium: number;
  big1k: number;
  baseline: number;
  absoluteCapPass: boolean;
  growthAdjusted: number;
  growthPass: boolean;
  state: RatioVerdictState;
}

/**
 * `absoluteCapPass = big1k <= caps[arm]`; `growthAdjusted =
 * (big1k - baseline) / (medium - baseline)`; `growthPass = growthAdjusted <=
 * growthFactor`; `state` is `"PASS"` iff both pass, else `"FAIL"` —
 * UNLESS `sqliteControl` is given and is itself explosive (its
 * `growthAdjusted > growthFactor`), in which case `state` is downgraded to
 * `"INCONCLUSIVE"` regardless of this arm's own pass/fail: a memory
 * falsifier only means something if the SQLite control it's measured
 * against is itself well-behaved (plan §"Memory predicate", "if the SQLite
 * control itself grows explosively the comparison is INCONCLUSIVE, not a
 * kernel fail").
 *
 * `sqliteControl` is an options arg (not a second function) deliberately:
 * the caller computes the SQLite arm's own `memoryVerdict` first (a normal,
 * never-downgraded call — never pass `sqliteControl` when `arm === "sqlite"`,
 * that would be self-referential) and threads its `growthAdjusted` into the
 * KERNEL arm's call. This keeps `memoryVerdict` a single pure function for
 * both arms while still expressing the plan's asymmetric rule (only the
 * KERNEL comparison can be downgraded by an explosive SQLite control).
 *
 * Guards `medium === baseline` (the growth-ratio denominator) by throwing —
 * a zero/undefined denominator must never silently produce `NaN` or
 * `Infinity` in a gate verdict.
 */
export function memoryVerdict(
  arm: "kernel" | "sqlite",
  values: MemoryValues,
  caps: MemoryCaps,
  growthFactor: number,
  sqliteControl?: { growthAdjusted: number }
): MemoryVerdict {
  const { baseline, medium, big1k } = values;
  if (medium === baseline) {
    throw new Error(
      `memoryVerdict: medium (${medium}) equals baseline (${baseline}) — the growth-ratio denominator ` +
        `(medium - baseline) would be zero; refusing to emit a NaN/Infinity growthAdjusted`
    );
  }
  if (!(growthFactor > 0)) {
    throw new Error(`memoryVerdict: growthFactor must be a positive number, got ${growthFactor}`);
  }

  const cap = caps[arm];
  const absoluteCapPass = big1k <= cap;
  const growthAdjusted = (big1k - baseline) / (medium - baseline);
  const growthPass = growthAdjusted <= growthFactor;

  let state: RatioVerdictState;
  if (sqliteControl && sqliteControl.growthAdjusted > growthFactor) {
    state = "INCONCLUSIVE";
  } else if (absoluteCapPass && growthPass) {
    state = "PASS";
  } else {
    state = "FAIL";
  }

  return { arm, medium, big1k, baseline, absoluteCapPass, growthAdjusted, growthPass, state };
}

/** `{ p95Kernel, p95Sqlite, pointRatio, ucb95, lcb95, state }` — the tri-state noninferiority verdict on the paired p95 wall ratio. */
export interface RatioVerdict {
  p95Kernel: number;
  p95Sqlite: number;
  pointRatio: number;
  ucb95: number;
  lcb95: number;
  state: RatioVerdictState;
}

/** The gate-3 noninferiority threshold: kernel p95 wall must stay within 1.25x SQLite p95 wall. Never widen this. */
export const NONINFERIORITY_RATIO_THRESHOLD = 1.25;

/**
 * PASS iff `ucb95 <= 1.25`, FAIL iff `lcb95 > 1.25`, else INCONCLUSIVE (the
 * confidence interval straddles the threshold — measure more, claim
 * neither). Never widen the threshold to force a PASS.
 */
export function ratioVerdict(
  pairs: readonly { kernel: number; sqlite: number }[],
  seed: number,
  resamples = 10_000
): RatioVerdict {
  const p95Kernel = nearestRankDistribution(pairs.map((pair) => pair.kernel)).p95;
  const p95Sqlite = nearestRankDistribution(pairs.map((pair) => pair.sqlite)).p95;
  const { pointRatio, ucb95, lcb95 } = pairedP95RatioBootstrap(pairs, seed, resamples);

  let state: RatioVerdictState;
  if (ucb95 <= NONINFERIORITY_RATIO_THRESHOLD) {
    state = "PASS";
  } else if (lcb95 > NONINFERIORITY_RATIO_THRESHOLD) {
    state = "FAIL";
  } else {
    state = "INCONCLUSIVE";
  }

  return { p95Kernel, p95Sqlite, pointRatio, ucb95, lcb95, state };
}
