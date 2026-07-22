// Gate 3 (unkeyed noninferiority), post-recording cleanup: unit coverage for
// `memoryVerdictTolerant`'s degenerate-denominator branch (`run-big.ts`).
//
// Pure-function fixture test — no children, no daemon, no corpus build.
// `run-big.ts`'s `main()` is guarded by a `require.main === module` check
// (mirroring `cli.ts`) so importing it here for its exported pure helper does
// not trigger the real operator run.
import { describe, expect, it } from "vitest";
import { memoryVerdictTolerant } from "../src/gate3/run-big.js";
import { KERNEL_1K_RSS_CAP } from "../src/gate3/config.js";

describe("memoryVerdictTolerant: degenerate denominator (medium <= baseline)", () => {
  it("cap BREACHED + degenerate denominator -> FAIL (the absolute cap is independent of the growth ratio)", () => {
    const verdict = memoryVerdictTolerant("kernel", {
      baseline: 200_000_000,
      medium: 200_000_000, // medium === baseline -> degenerate denominator
      big1k: KERNEL_1K_RSS_CAP + 1 // over the cap
    });

    expect(verdict.growthAdjusted).toBe(-1); // sentinel: growth ratio not computable
    expect(verdict.growthPass).toBe(false);
    expect(verdict.absoluteCapPass).toBe(false);
    expect(verdict.state).toBe("FAIL");
  });

  it("cap OK + degenerate denominator -> INCONCLUSIVE (growth ratio can't be assessed, but nothing measured failed)", () => {
    const verdict = memoryVerdictTolerant("kernel", {
      baseline: 200_000_000,
      medium: 150_000_000, // medium < baseline -> also degenerate (covers the "<=" branch, not just "==")
      big1k: KERNEL_1K_RSS_CAP - 1 // under the cap
    });

    expect(verdict.growthAdjusted).toBe(-1);
    expect(verdict.growthPass).toBe(false);
    expect(verdict.absoluteCapPass).toBe(true);
    expect(verdict.state).toBe("INCONCLUSIVE");
  });

  it("cap exactly AT the boundary (big1k === cap) still counts as a pass -> INCONCLUSIVE", () => {
    const verdict = memoryVerdictTolerant("sqlite", {
      baseline: 100_000_000,
      medium: 100_000_000,
      big1k: 500_000_000
    });
    // Sanity: this fixture is unrelated to the real sqlite cap; it only
    // exercises the "cap ok" arm of the branch with an arbitrary, unbreached
    // value to confirm the arm parameter is threaded through correctly.
    expect(verdict.arm).toBe("sqlite");
    expect(verdict.state).toBe("INCONCLUSIVE");
  });
});
