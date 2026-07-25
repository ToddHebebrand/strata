// Bridge-persistence slice, Task 8: the differential shadow oracle. Arm P
// (daemon with --persistent-bridge) and arm O (daemon without) are driven
// through IDENTICAL seeded mutation sequences on examples/medium, and every
// per-step semantic surface is compared: submit/advance state transitions,
// published-operation presence and content (affected node ids, rename
// transitions, intents, publication digest), re-inspected payloads of every
// affected node, diagnostics and renamed-symbol surfaces on failure paths,
// and a final tree-state digest reconstructed the `materializeFinalTree`
// way (generation-zero registered payloads overlaid with re-inspected
// payloads of every operation-affected registered statement).
// ANY mismatch fails with the full diff.
//
// Coverage required by the plan (v2, review Q8):
//   sequential-1  — six alternating User<->Account interface renames;
//   sequential-2  — mixed rename + add_parameter sequence (the coordination
//                   protocol's add_parameter intent surface IS used);
//   concurrent    — two overlapping clients on the SAME daemon interleaving
//                   two change sets from begin through published;
//   failpoint     — a publication that legitimately fails mid-sequence: a
//                   stale add_parameter change set submitted before an
//                   overlapping rename publishes is driven down the real
//                   needs_decision -> cancel -> fresh-decision path (the
//                   protocol-induced failure, no daemon-side injection).
//
// Metrics are ON for both arms so workerRun records corroborate the bridge
// lifecycle (persistent arm: one worker child, snapshot-free trips), but the
// COMPARISON is over semantic outputs only — never timings.
//
// See docs/superpowers/plans/2026-07-23-bridge-persistence-slice.md, Task 8.
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ORACLE_SEQUENCES,
  runDifferentialOracle,
  type SequenceComparison
} from "../src/persistence/differential-oracle.js";
import { ensureBuilt } from "./serviceHarness.js";

const corpusRoot = resolve(import.meta.dirname, "../../../examples/medium");

/** Fixed oracle seed: every free choice in the sequences (interleave leader,
 * independent-step order) derives from this via the gate-3 seeded PRNG. */
const ORACLE_SEED = 0x08_2607;

describe("differential shadow oracle (persistent vs one-shot bridge)", () => {
  beforeAll(() => ensureBuilt(), 600_000);

  it("drives sequential, concurrent, and failpoint sequences through both arms with zero semantic mismatches", async () => {
    const report = await runDifferentialOracle(corpusRoot, {
      sequences: [...ORACLE_SEQUENCES],
      seed: ORACLE_SEED
    });

    // The oracle's contract: ANY mismatch fails, with the full diff visible.
    expect(
      report.mismatches,
      `differential oracle mismatches:\n${JSON.stringify(report.mismatches, null, 2)}`
    ).toEqual([]);
    expect(report.sequences.map((sequence) => sequence.name)).toEqual([...ORACLE_SEQUENCES]);
    expect(report.steps.length).toBeGreaterThan(0);
    expect(report.steps.every((step) => step.matched)).toBe(true);

    const byName = new Map<string, SequenceComparison>(
      report.sequences.map((sequence) => [sequence.name, sequence])
    );
    const sequence = (name: string): SequenceComparison => {
      const found = byName.get(name);
      if (!found) throw new Error(`missing oracle sequence ${name}`);
      return found;
    };

    // Non-vacuity: sequential-1 published all six alternating renames in
    // BOTH arms (a sequence of failures comparing equal would be vacuous).
    const sequential1 = sequence("sequential-1");
    for (const arm of [sequential1.oneShot, sequential1.persistent]) {
      expect(arm.mutationCount).toBe(6);
      expect(arm.publishedCount).toBe(6);
      expect(arm.finalTreeDigest).toMatch(/^[0-9a-f]{64}$/);
    }

    // Non-vacuity: sequential-2 exercised the add_parameter intent surface
    // and published every step.
    const sequential2 = sequence("sequential-2");
    for (const arm of [sequential2.oneShot, sequential2.persistent]) {
      expect(arm.addParameterPublishedCount).toBeGreaterThanOrEqual(2);
      expect(arm.publishedCount).toBe(arm.mutationCount);
      expect(arm.mutationCount).toBe(6);
    }

    // Non-vacuity: the concurrent sequence overlapped two change sets and
    // both published, converging on the same final tree in both arms.
    const concurrent = sequence("concurrent");
    for (const arm of [concurrent.oneShot, concurrent.persistent]) {
      expect(arm.publishedCount).toBe(2);
      expect(arm.finalGeneration).toBe("2");
    }

    // Non-vacuity: the failpoint sequence really drove a publication failure
    // mid-sequence — the stale change set terminated needs_decision in BOTH
    // arms and the fresh decision then published.
    const failpoint = sequence("failpoint");
    for (const arm of [failpoint.oneShot, failpoint.persistent]) {
      expect(arm.terminalStates["stale-add-parameter"]).toBe("needs_decision");
      expect(arm.terminalStates["fresh-decision-add-parameter"]).toBe("published");
      expect(arm.terminalStates["rename-displayUser"]).toBe("published");
    }

    // Lifecycle corroboration (recorded, not part of the semantic diff):
    // the persistent arm served sequential-1 from ONE worker child with
    // every trip snapshot-free and no hydrate stage; the one-shot arm
    // spawned a child per trip.
    const persistentRuns = sequential1.persistent.corroboration;
    expect(persistentRuns.workerStartsTotalLast).toBe(1);
    expect(persistentRuns.workerRunCount).toBeGreaterThan(0);
    expect(persistentRuns.snapshotFreeRunCount).toBe(persistentRuns.workerRunCount);
    expect(persistentRuns.hydrateStageRunCount).toBe(0);
    const oneShotRuns = sequential1.oneShot.corroboration;
    expect(oneShotRuns.workerStartsTotalLast).toBe(oneShotRuns.workerRunCount);
  }, 1_800_000);
});
