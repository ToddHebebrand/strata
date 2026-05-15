import { describe, expect, it } from "vitest";
import { distribution, type Distribution } from "../src/metrics";

describe("distribution", () => {
  it("computes N/min/max/median/mean/p25/p75/stddev and keeps raw values", () => {
    const d: Distribution = distribution([10, 2, 8, 4, 6]);
    expect(d.n).toBe(5);
    expect(d.min).toBe(2);
    expect(d.max).toBe(10);
    expect(d.median).toBe(6);
    expect(d.mean).toBe(6);
    expect(d.values).toEqual([10, 2, 8, 4, 6]);
    expect(d.stddev).toBeCloseTo(2.8284, 3);
    expect(d.p25).toBe(4);
    expect(d.p75).toBe(8);
  });

  it("handles a single value without NaN", () => {
    const d = distribution([7]);
    expect(d).toMatchObject({
      n: 1,
      min: 7,
      max: 7,
      median: 7,
      mean: 7,
      p25: 7,
      p75: 7,
      stddev: 0
    });
    expect(d.values).toEqual([7]);
  });

  it("returns an explicit empty distribution for no values (never NaN)", () => {
    const d = distribution([]);
    expect(d.n).toBe(0);
    expect(d.values).toEqual([]);
    expect(d.mean).toBeNull();
    expect(d.median).toBeNull();
    expect(d.min).toBeNull();
    expect(d.max).toBeNull();
    expect(d.p25).toBeNull();
    expect(d.p75).toBeNull();
    expect(d.stddev).toBeNull();
  });

  it("computes an even-length median as the mean of the two middles", () => {
    const d = distribution([1, 2, 3, 4]);
    expect(d.median).toBe(2.5);
  });
});
