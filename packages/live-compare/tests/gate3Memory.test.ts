// Gate 3 (unkeyed noninferiority), Task 5 (half a): the baseline-adjusted,
// capped memory predicate. Pure numeric code, no children, no daemon —
// fixtures verbatim from the plan/brief (docs/superpowers/plans/
// 2026-07-20-iteration6-slice-a-gate3.md, Task 5 Step 1):
//
//   baseline 200, medium 260, big1k 380 -> growthAdjusted (380-200)/(260-200)
//   = 3.0 <= growthFactor(4) -> growthPass; big1k 900 -> 11.7 > 4 -> FAIL;
//   an absolute cap breach fails regardless of growth; an explosive SQLite
//   control flags the KERNEL comparison INCONCLUSIVE.
import { describe, expect, it } from "vitest";
import { memoryVerdict, type MemoryCaps } from "../src/gate3/stats.js";

const GENEROUS_CAPS: MemoryCaps = { kernel: 100_000, sqlite: 100_000 };
const GROWTH_FACTOR = 4;

describe("memoryVerdict", () => {
  it("PASS: baseline 200, medium 260, big1k 380 -> growthAdjusted 3.0 <= 4", () => {
    const verdict = memoryVerdict(
      "kernel",
      { baseline: 200, medium: 260, big1k: 380 },
      GENEROUS_CAPS,
      GROWTH_FACTOR
    );
    expect(verdict.arm).toBe("kernel");
    expect(verdict.baseline).toBe(200);
    expect(verdict.medium).toBe(260);
    expect(verdict.big1k).toBe(380);
    expect(verdict.growthAdjusted).toBeCloseTo(3.0, 10);
    expect(verdict.growthPass).toBe(true);
    expect(verdict.absoluteCapPass).toBe(true);
    expect(verdict.state).toBe("PASS");
  });

  it("FAIL: baseline 200, medium 260, big1k 900 -> growthAdjusted ~11.7 > 4", () => {
    const verdict = memoryVerdict(
      "kernel",
      { baseline: 200, medium: 260, big1k: 900 },
      GENEROUS_CAPS,
      GROWTH_FACTOR
    );
    expect(verdict.growthAdjusted).toBeCloseTo(11.666666666, 6);
    expect(verdict.growthPass).toBe(false);
    expect(verdict.absoluteCapPass).toBe(true);
    expect(verdict.state).toBe("FAIL");
  });

  it("FAIL: an absolute cap breach fails regardless of a passing growth ratio", () => {
    const verdict = memoryVerdict(
      "kernel",
      { baseline: 200, medium: 260, big1k: 380 },
      { kernel: 300, sqlite: 100_000 },
      GROWTH_FACTOR
    );
    expect(verdict.growthAdjusted).toBeCloseTo(3.0, 10);
    expect(verdict.growthPass).toBe(true);
    expect(verdict.absoluteCapPass).toBe(false);
    expect(verdict.state).toBe("FAIL");
  });

  it("uses the sqlite cap for the sqlite arm, not the kernel cap", () => {
    const verdict = memoryVerdict(
      "sqlite",
      { baseline: 200, medium: 260, big1k: 380 },
      { kernel: 100_000, sqlite: 300 },
      GROWTH_FACTOR
    );
    expect(verdict.absoluteCapPass).toBe(false);
    expect(verdict.state).toBe("FAIL");
  });

  it("INCONCLUSIVE: an explosive SQLite control downgrades an otherwise-PASS kernel verdict", () => {
    // SQLite control itself: baseline 200, medium 210, big1k 900 ->
    // growthAdjusted (900-200)/(210-200) = 70, itself >> growthFactor(4).
    const sqliteControl = memoryVerdict(
      "sqlite",
      { baseline: 200, medium: 210, big1k: 900 },
      GENEROUS_CAPS,
      GROWTH_FACTOR
    );
    expect(sqliteControl.growthAdjusted).toBeCloseTo(70, 6);
    expect(sqliteControl.growthPass).toBe(false);

    const kernelVerdict = memoryVerdict(
      "kernel",
      { baseline: 200, medium: 260, big1k: 380 },
      GENEROUS_CAPS,
      GROWTH_FACTOR,
      { growthAdjusted: sqliteControl.growthAdjusted }
    );
    // Kernel's own numbers still pass on their own merits...
    expect(kernelVerdict.absoluteCapPass).toBe(true);
    expect(kernelVerdict.growthPass).toBe(true);
    // ...but the verdict is downgraded because the control itself is
    // uninterpretable (explosive growth in the SQLite baseline/medium/big1k
    // trio means the comparison can't attribute kernel growth to the kernel).
    expect(kernelVerdict.state).toBe("INCONCLUSIVE");
  });

  it("a non-explosive SQLite control does NOT downgrade a passing kernel verdict", () => {
    const sqliteControl = memoryVerdict(
      "sqlite",
      { baseline: 200, medium: 260, big1k: 380 },
      GENEROUS_CAPS,
      GROWTH_FACTOR
    );
    expect(sqliteControl.growthPass).toBe(true);

    const kernelVerdict = memoryVerdict(
      "kernel",
      { baseline: 200, medium: 260, big1k: 380 },
      GENEROUS_CAPS,
      GROWTH_FACTOR,
      { growthAdjusted: sqliteControl.growthAdjusted }
    );
    expect(kernelVerdict.state).toBe("PASS");
  });

  it("guards the medium===baseline division edge case by throwing, never emitting NaN", () => {
    expect(() =>
      memoryVerdict("kernel", { baseline: 200, medium: 200, big1k: 380 }, GENEROUS_CAPS, GROWTH_FACTOR)
    ).toThrow();
  });
});
