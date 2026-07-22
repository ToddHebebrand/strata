// Gate 3 (unkeyed noninferiority), Task 6: lifecycle-call parity derived
// from a runtime trace, not a hand-list. `lifecycleParity` consumes the
// ACTUAL `ChildResult.lifecycle` arrays the Task-2 children recorded from
// their own wrapped calls, so a future call-structure change in
// sqlite-child.ts/kernel-child.ts propagates here automatically instead of
// silently disagreeing with a hardcoded expectation.
import { describe, expect, it, beforeAll } from "vitest";
import { lifecycleParity, KERNEL_CANONICAL_LIFECYCLE, SQLITE_CANONICAL_LIFECYCLE } from "../src/gate3/stats.js";
import { ensureBuilt } from "./serviceHarness.js";
import { RENAME_TARGET, kernelChildEntry, mediumRoot, runChild, sqliteChildEntry } from "./gate3ChildHarness.js";

describe("lifecycleParity", () => {
  beforeAll(async () => {
    ensureBuilt();
  }, 600_000);

  it("canonical sequences are exactly the Task-2-documented call orders", () => {
    expect(SQLITE_CANONICAL_LIFECYCLE).toEqual(["begin", "rename_symbol", "validate", "commit"]);
    expect(KERNEL_CANONICAL_LIFECYCLE).toEqual([
      "begin_change_set",
      "add_intent",
      "submit_change_set",
      "advance_change_set"
    ]);
  });

  it(
    "real medium cold-run traces from both children: kernel 4 == sqlite 4, equal:true",
    async () => {
      const [sqliteResult] = await runChild(
        sqliteChildEntry,
        { corpusRoot: mediumRoot, target: RENAME_TARGET, mode: "cold", iterations: 1 },
        60_000
      );
      const [kernelResult] = await runChild(
        kernelChildEntry,
        { corpusRoot: mediumRoot, target: RENAME_TARGET, mode: "cold", iterations: 1 },
        180_000
      );

      const sqliteTrace = sqliteResult!.lifecycle;
      const kernelTrace = kernelResult!.lifecycle;

      // Sanity: these are the real traces, not a hand-list, before we even
      // call lifecycleParity.
      expect(sqliteTrace).toEqual(["begin", "rename_symbol", "validate", "commit"]);
      expect(kernelTrace).toEqual(["begin_change_set", "add_intent", "submit_change_set", "advance_change_set"]);

      const parity = lifecycleParity(kernelTrace, sqliteTrace);
      expect(parity).toEqual({ kernel: 4, sqlite: 4, equal: true });
    },
    300_000
  );

  it("synthetic 5-call kernel trace disagrees with the canonical 4-call sequence -> equal:false", () => {
    const syntheticKernelTrace = [
      "begin_change_set",
      "add_intent",
      "add_intent",
      "submit_change_set",
      "advance_change_set"
    ];
    const parity = lifecycleParity(syntheticKernelTrace, SQLITE_CANONICAL_LIFECYCLE);
    expect(parity).toEqual({ kernel: 5, sqlite: 4, equal: false });
  });
});
