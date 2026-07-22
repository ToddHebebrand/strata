// Gate 3 (unkeyed noninferiority), Task 2: isolated-child mutation worker
// acceptance. Spawns the COMPILED children (dist/gate3/*-child.js) over
// stdin/stdout, exactly as the gate-3 timing harness will, and asserts the
// wire contract: real (>0) callerWallNs over the metrics-off timed window,
// real childMaxRssBytes, the lifecycle trace as actually executed, and —
// critically — that every reported mutation is independently re-verified to
// have actually renamed (a no-op cannot score wall time; see
// child-protocol.ts's childResultSchema and each child's post-mutation
// re-query).
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureBuilt } from "./serviceHarness.js";
import {
  RENAME_TARGET,
  kernelChildEntry,
  mediumRoot,
  runChild,
  sqliteChildEntry,
  type ChildResultLike
} from "./gate3ChildHarness.js";

describe("gate3Child", () => {
  beforeAll(async () => {
    ensureBuilt();
  }, 600_000);

  it("both children build to dist/", () => {
    expect(existsSync(sqliteChildEntry)).toBe(true);
    expect(existsSync(kernelChildEntry)).toBe(true);
  });

  it(
    "sqlite-child cold: one mutation, validate+commit timed, real rename",
    async () => {
      const results = await runChild(
        sqliteChildEntry,
        { corpusRoot: mediumRoot, target: RENAME_TARGET, mode: "cold", iterations: 1 },
        60_000
      );
      expect(results).toHaveLength(1);
      const [result] = results as [ChildResultLike];
      expect(result.callerWallNs).toBeGreaterThan(0);
      expect(result.childMaxRssBytes).toBeGreaterThan(1_000_000);
      expect(result.published).toBe(true);
      expect(result.lifecycle).toEqual(["begin", "rename_symbol", "validate", "commit"]);
    },
    120_000
  );

  it(
    "kernel-child cold: one mutation, submit+advance timed, real rename",
    async () => {
      const results = await runChild(
        kernelChildEntry,
        { corpusRoot: mediumRoot, target: RENAME_TARGET, mode: "cold", iterations: 1 },
        180_000
      );
      expect(results).toHaveLength(1);
      const [result] = results as [ChildResultLike];
      expect(result.callerWallNs).toBeGreaterThan(0);
      expect(result.childMaxRssBytes).toBeGreaterThan(1_000_000);
      expect(result.published).toBe(true);
      expect(result.lifecycle).toEqual([
        "begin_change_set",
        "add_intent",
        "submit_change_set",
        "advance_change_set"
      ]);
    },
    240_000
  );

  it(
    "sqlite-child warm: 3 iterations alternate User<->Account, every mutation independently re-verified",
    async () => {
      const results = await runChild(
        sqliteChildEntry,
        { corpusRoot: mediumRoot, target: RENAME_TARGET, mode: "warm", iterations: 3 },
        60_000
      );
      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.callerWallNs).toBeGreaterThan(0);
        expect(result.childMaxRssBytes).toBeGreaterThan(1_000_000);
        expect(result.published).toBe(true);
        expect(result.lifecycle).toEqual(["begin", "rename_symbol", "validate", "commit"]);
      }
      // 3 flips from "User": User -> Account -> User -> Account. Each child
      // ChildResult line is only ever emitted after the child re-queries the
      // graph (a fresh find_declarations call, not the mutation's own return
      // value) and confirms the transition actually landed — so having
      // received exactly 3 results IS the "post-run target name reflects 3
      // flips" evidence; a no-op anywhere in the alternation would have
      // thrown inside the child before a 3rd (or any subsequent) line was
      // written.
    },
    120_000
  );

  it(
    "kernel-child warm: 3 iterations alternate User<->Account, every mutation independently re-verified",
    async () => {
      const results = await runChild(
        kernelChildEntry,
        { corpusRoot: mediumRoot, target: RENAME_TARGET, mode: "warm", iterations: 3 },
        300_000
      );
      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.callerWallNs).toBeGreaterThan(0);
        expect(result.childMaxRssBytes).toBeGreaterThan(1_000_000);
        expect(result.published).toBe(true);
        expect(result.lifecycle).toEqual([
          "begin_change_set",
          "add_intent",
          "submit_change_set",
          "advance_change_set"
        ]);
      }
      // Same "3 flips observable" logic as the sqlite warm case, but the
      // kernel child's per-mutation re-verification is even stronger: it
      // reads the published operation back over the wire and checks its
      // recorded fromName -> toName transition, which a no-op cannot
      // fabricate.
    },
    600_000
  );
});
