// Gate 3 (unkeyed noninferiority), Task 3: nearest-rank distribution, seeded
// PRNG, and paired-bootstrap tri-state verdict unit coverage. Pure numeric
// code, no children, no daemon — fast and deterministic.
import { describe, expect, it } from "vitest";
import {
  nearestRankDistribution,
  pairedP95RatioBootstrap,
  ratioVerdict,
  seededRng
} from "../src/gate3/stats.js";

describe("nearestRankDistribution", () => {
  it("matches the redb_spike.rs nearest-rank semantics on 1..20", () => {
    // Mirrors crates/strata-kernel/src/bin/redb_spike.rs's
    // nearest_rank_distribution_uses_every_sample test exactly: p50=10,
    // p95=19, max=20 for a 20-element 1..20 sample (unsorted input).
    const samples = [20, 1, 19, 2, 18, 3, 17, 4, 16, 5, 15, 6, 14, 7, 13, 8, 12, 9, 11, 10];
    const distribution = nearestRankDistribution(samples);
    expect(distribution.n).toBe(20);
    expect(distribution.p50).toBe(10);
    expect(distribution.p95).toBe(19);
    expect(distribution.max).toBe(20);
    expect(distribution.min).toBe(1);
  });

  it("p95 of [1..10] is rank ceil(9.5)=10 -> the max (10)", () => {
    const distribution = nearestRankDistribution([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(distribution.p95).toBe(10);
    expect(distribution.p50).toBe(5);
  });

  it("n=1: every percentile is the single sample", () => {
    const distribution = nearestRankDistribution([5]);
    expect(distribution.n).toBe(1);
    expect(distribution.p50).toBe(5);
    expect(distribution.p95).toBe(5);
    expect(distribution.p99).toBe(5);
    expect(distribution.max).toBe(5);
    expect(distribution.min).toBe(5);
    expect(distribution.mean).toBe(5);
  });

  it("n=2: p50 is rank ceil(1.0)=1 (the smaller), p95/p99 are rank ceil(1.9)/ceil(1.98)=2 (the larger)", () => {
    const distribution = nearestRankDistribution([30, 10]);
    expect(distribution.n).toBe(2);
    expect(distribution.min).toBe(10);
    expect(distribution.max).toBe(30);
    expect(distribution.p50).toBe(10);
    expect(distribution.p95).toBe(30);
    expect(distribution.p99).toBe(30);
  });

  it("retains raw samples and rejects an empty array", () => {
    const distribution = nearestRankDistribution([3, 1, 2]);
    expect(distribution.samples).toEqual([3, 1, 2]);
    expect(() => nearestRankDistribution([])).toThrow();
  });
});

describe("seededRng", () => {
  it("is deterministic for a fixed seed and varies for a different seed", () => {
    const a1 = seededRng(42);
    const a2 = seededRng(42);
    const sequenceA1 = [a1(), a1(), a1(), a1(), a1()];
    const sequenceA2 = [a2(), a2(), a2(), a2(), a2()];
    expect(sequenceA2).toEqual(sequenceA1);

    const b = seededRng(43);
    const sequenceB = [b(), b(), b(), b(), b()];
    expect(sequenceB).not.toEqual(sequenceA1);
  });

  it("produces values in [0, 1)", () => {
    const rng = seededRng(7);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

// Synthetic pair fixtures. sqlite is held constant at 100 across every pair
// so p95(sqlite) is trivially 100 for the point estimate AND every bootstrap
// resample (a resample of an all-100 population is still all-100) — the
// entire bootstrap ratio distribution is therefore driven purely by
// resampling kernel, keeping these fixtures' expected regions computable by
// hand (see reasoning inline).
function constantPairs(kernelValues: readonly number[]): { kernel: number; sqlite: number }[] {
  return kernelValues.map((kernel) => ({ kernel, sqlite: 100 }));
}

describe("pairedP95RatioBootstrap + ratioVerdict", () => {
  it("is deterministic for a fixed seed", () => {
    const pairs = constantPairs([118, 122, 118, 122, 118, 122, 118, 122, 118, 122]);
    const first = pairedP95RatioBootstrap(pairs, 1234, 2000);
    const second = pairedP95RatioBootstrap(pairs, 1234, 2000);
    expect(second).toEqual(first);
  });

  it("PASS: kernel tightly bounded within [118,122] (~1.2x sqlite=100) -> ucb95 well under 1.25", () => {
    // n=10 pairs alternating kernel 118/122 against a constant sqlite=100.
    // Every possible bootstrap resample of this population also lies within
    // {118,122}, so p95(kernel) in ANY resample is at most 122 -> the ratio
    // distribution is bounded above by 1.22, strictly under the 1.25
    // threshold, so ucb95 (a 95th percentile of that bounded distribution)
    // must also be <= 1.22.
    const pairs = constantPairs([118, 122, 118, 122, 118, 122, 118, 122, 118, 122]);
    const result = pairedP95RatioBootstrap(pairs, 1, 10_000);
    expect(result.pointRatio).toBeCloseTo(1.22, 5);
    expect(result.ucb95).toBeGreaterThan(1.0);
    expect(result.ucb95).toBeLessThanOrEqual(1.22);
    expect(result.lcb95).toBeLessThanOrEqual(result.ucb95);

    const verdict = ratioVerdict(pairs, 1, 10_000);
    expect(verdict.state).toBe("PASS");
    expect(verdict.ucb95).toBeLessThanOrEqual(1.25);
  });

  it("FAIL: kernel tightly bounded within [145,155] (~1.5x sqlite=100) -> lcb95 well over 1.25", () => {
    // Same construction, but the whole {145,155} population sits above the
    // 1.25 threshold, so EVERY bootstrap resample's ratio is >= 1.45 -> the
    // 5th percentile (lcb95) is also >= 1.45, comfortably over 1.25.
    const pairs = constantPairs([145, 155, 145, 155, 145, 155, 145, 155, 145, 155]);
    const result = pairedP95RatioBootstrap(pairs, 2, 10_000);
    expect(result.pointRatio).toBeCloseTo(1.55, 5);
    expect(result.lcb95).toBeGreaterThan(1.25);

    const verdict = ratioVerdict(pairs, 2, 10_000);
    expect(verdict.state).toBe("FAIL");
    expect(verdict.lcb95).toBeGreaterThan(1.25);
  });

  it("INCONCLUSIVE: a rare high outlier makes the bootstrap CI straddle 1.25", () => {
    // 19 pairs at kernel=115 (ratio 1.15) + 1 outlier pair at kernel=200
    // (ratio 2.0), sqlite=100 throughout. p95 of a 20-draw resample is its
    // 2nd-largest value (nearest-rank ceil(0.95*20)=19th of 20). That is
    // 115 unless the resample happens to draw the single outlier pair at
    // least twice (probability of a single draw hitting the outlier is
    // 1/20=0.05); with p=0.05 and 20 draws, P(>=2 hits) ~= 0.264 by the
    // binomial distribution, and P(<=1 hit) ~= 0.736 — both well over the 5%
    // tail on each side, so the resampled ratio distribution has real mass
    // at BOTH 1.15 (no/one outlier draw) and 2.0 (>=2 outlier draws),
    // putting 1.25 strictly between lcb95 and ucb95.
    const kernelValues = [...Array(19).fill(115), 200];
    const pairs = constantPairs(kernelValues);
    const result = pairedP95RatioBootstrap(pairs, 3, 10_000);
    expect(result.lcb95).toBeLessThanOrEqual(1.25);
    expect(result.ucb95).toBeGreaterThan(1.25);

    const verdict = ratioVerdict(pairs, 3, 10_000);
    expect(verdict.state).toBe("INCONCLUSIVE");
  });

  it("rejects an empty pairs array", () => {
    expect(() => pairedP95RatioBootstrap([], 1, 100)).toThrow();
  });
});
