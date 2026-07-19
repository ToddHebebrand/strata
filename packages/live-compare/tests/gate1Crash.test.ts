// Gate 1 crash-injection suite (iteration 6 slice A). Nine durable-boundary
// crashes are driven through the T03 coordination surface — the five journal
// stages of a mutating request (`--test-failpoint`, coordination-test-api) at
// the advance, and the four redb publication boundaries
// (`--test-publish-failpoint`, redb-spike-api) — each followed by a full
// atomic-state oracle: the graph landed exactly complete-old XOR complete-new,
// the offline atomic-state projection matches the corresponding reference, and
// the exact idempotent replay of the advance yields the committed response.
//
// Choreography (the failpoints are global per-mutating-request, so the T03 prep
// must be failpoint-free):
//   1. runKernelArmT03(corpus, { stopAfterSubmit, preserveDirectory }) — begin/
//      add/submit committed to durable state, daemon stopped cleanly, redb kept.
//   2. Restart the SAME directory with the failpoint flag (redb-spike-api build).
//   3. Issue ONLY advance_change_set with a recorded idempotencyKey; the daemon
//      aborts (client throws; the child exits abnormally, SIGABRT).
//   4. Reopen the store OFFLINE (export-snapshot) and run the oracle; then
//      restart clean and replay the advance with the SAME idempotency identity.
//
// No model calls, no API keys, no persisted SQLite. See
// docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md (Task 7).
import { randomUUID } from "node:crypto";
import { spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CoordinationClient, CoordinationClientError, type CoordinationResult } from "../src/client.js";
import { exportKernelSnapshot, runKernelArmT03, type KernelArmOutcome } from "../src/gate1.js";
import { startKernelService, type RunningKernelService } from "../src/service.js";
import { credentialFreeEnv, ensureBuilt } from "./serviceHarness.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const corpus = resolve(repoRoot, "examples/medium");

// This suite spins up ~4 daemon lifecycles per case across 9 cases plus real
// tsc publications for the reference captures. Measured wall time is ~45 s
// (plus a one-time cached redb-spike-api build), well under the ~15-minute
// budget, so it runs unconditionally inside the `gate1` vitest filter — no env
// gate. If future growth pushes it past budget, gate the describe behind
// STRATA_GATE1_CRASH=1 and set that env in the kernel:gate1:test script.
const ADVANCE_DEADLINE_MS = 180_000;

// A single fixed actor for the references AND every crash prep. The change-set
// actor (and therefore the operation actor) is the clientId that ran
// begin_change_set, so sharing it makes `actor` a genuinely-equal compared
// field across the reference and each crash capture rather than a
// varies-by-construction one. Ownership still holds: the crash advance and its
// replay run from this same actor.
const CRASH_ACTOR = "gate1-crash-actor";

const cleanupDirs: string[] = [];
afterAll(() => cleanupDirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

// ---------------------------------------------------------------------------
// Binaries. The crash arm needs the redb-spike-api build (accepts both test
// flags because redb-spike-api implies coordination-test-api). The negative
// "default rejects the flag" assertion needs a genuine default build; that is
// what ensureBuilt() places at target/debug.
// ---------------------------------------------------------------------------
let crashBinary = "";
let defaultBinary = "";

function buildCrashBinary(): string {
  const targetDir = join(repoRoot, "target/gate1-crash");
  const result = spawnSync(
    "cargo",
    [
      "build",
      "-p",
      "strata-kernel",
      "--bin",
      "strata-kernel-service",
      "--features",
      "coordination-test-api redb-spike-api",
      "--target-dir",
      targetDir
    ],
    { cwd: repoRoot, env: credentialFreeEnv(), encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`redb-spike-api crash binary build failed\n${result.stdout}\n${result.stderr}`);
  }
  return join(targetDir, "debug/strata-kernel-service");
}

// ---------------------------------------------------------------------------
// Deterministic, key-order-independent JSON for byte-equality assertions.
// ---------------------------------------------------------------------------
function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, normalize((input as Record<string, unknown>)[key])])
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

interface ExportedGraph {
  snapshot: { nodes: unknown; references: unknown };
  generation: string;
}

/** Graph identity: generation + canonical nodes + canonical references. */
function graphKey(exported: ExportedGraph): string {
  return canonicalJson({
    generation: exported.generation,
    nodes: exported.snapshot.nodes,
    references: exported.snapshot.references
  });
}

/** Offline export of a preserved redb: canonical graph + atomic-state projection. */
function reopenAndExport(directory: string): { graph: ExportedGraph; state: unknown } {
  const statePath = join(mkdtempSync(join(tmpdir(), "strata-gate1-crash-state-")), "state.json");
  cleanupDirs.push(statePath);
  const exported = exportKernelSnapshot(directory, { stateOut: statePath });
  return {
    graph: { snapshot: exported.snapshot, generation: exported.generation },
    state: JSON.parse(readFileSync(statePath, "utf8"))
  };
}

// ---------------------------------------------------------------------------
// Atomic-state projection normalization.
//
// The reference captures and each crash capture reach the SAME logical outcome
// but through a different number of open/recovery cycles and with fresh random
// coordination IDs, so two things must happen before comparison:
//
//  (A) Strip the fields that legitimately vary with the recovery-cycle count.
//      Everything NOT stripped compares byte-for-byte after ID mapping: graph,
//      graphDigest, graphCounts, operations (full canonical history), deltas,
//      generationDigests, graphEvents, changeSets (incl. state), intents,
//      idempotencyGenerations, tickets, graphTickets, publicationAttempts,
//      fenceStates, resource clocks, and the stable coordinationCounts.
//
//        serviceEpoch        — monotonic per-open recovery counter; reference
//                              and crashed store are reopened a different number
//                              of times.
//        schedulerRevisions  — bumped on every recovery/reconsider cycle.
//        recoveryMetadata    — its sequence/revision counters churn with those
//                              same recovery cycles (nextQueueSequence,
//                              currentEventSequence, schedulerRevision,
//                              latestLifecycleRevision, ...).
//        coordinationCounts.events / eventIds / eventCursors — each recovery
//                              emits a service-epoch transition event, so the
//                              coordination event COUNT tracks recovery cycles.
//
//  (B) Map random IDs to ordinal placeholders (mirrors normalize_crash_state in
//      tests/full_key_free_acceptance.rs): change-set / intent / ticket /
//      operation / graph-event / ready-offer / claim / attempt IDs and the
//      per-change-set idempotency commit key. Deterministic because our N=1
//      scenario has at most one of each and history is generation-ordered.
// ---------------------------------------------------------------------------
const STRIPPED_TOP_LEVEL = ["serviceEpoch", "schedulerRevisions", "recoveryMetadata"] as const;
const STRIPPED_COORDINATION_COUNTS = ["events", "eventIds", "eventCursors"] as const;

function buildReplacements(projection: any): Map<string, string> {
  const replacements = new Map<string, string>();
  const add = (id: unknown, placeholder: string): void => {
    if (typeof id === "string" && id.length > 0 && !replacements.has(id)) {
      replacements.set(id, placeholder);
    }
  };
  const changeSets: any[] = projection.changeSets ?? [];
  changeSets.forEach((changeSet, index) => {
    add(changeSet.changeSetId, `<change-set:${index}>`);
    // The submission idempotency key is a fresh random key per begin request,
    // so it varies run-to-run even with a fixed actor — map it like any other
    // random identity.
    add(changeSet.submissionIdempotencyKey, `<submission-key:${index}>`);
    (changeSet.intentIds ?? []).forEach((intentId: string, position: number) =>
      add(intentId, `<intent:${index}:${position}>`)
    );
  });
  (projection.tickets ?? []).forEach((ticket: any, index: number) =>
    add(ticket.ticketId, `<ticket:${index}>`)
  );
  (projection.operations ?? []).forEach((operation: any, index: number) =>
    add(operation.operationId, `<operation:${index}>`)
  );
  (projection.graphEvents ?? []).forEach((event: any, index: number) =>
    add(event.eventId, `<graph-event:${index}>`)
  );
  (projection.readyOffers ?? []).forEach((offer: any, index: number) => {
    add(offer.offerId, `<offer:${index}>`);
    add(offer.claimToken, `<claim-token:${index}>`);
  });
  (projection.activeClaims ?? []).forEach((claim: any, index: number) => {
    add(claim.claimId, `<claim:${index}>`);
    add(claim.offerId, `<claim-offer:${index}>`);
    add(claim.attemptId, `<attempt:${index}>`);
  });
  Object.keys(projection.publicationAttempts ?? {}).forEach((key, index) =>
    add(key, `<attempt-key:${index}>`)
  );
  Object.keys(projection.idempotencyGenerations ?? {}).forEach((key, index) =>
    add(key, `<commit-key:${index}>`)
  );
  return replacements;
}

function normalizeValue(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === "string") {
    const mapped = replacements.get(value);
    if (mapped !== undefined) return mapped;
    // Recurse into embedded JSON payloads (e.g. serialized event/operation
    // parameters) so IDs nested inside string fields normalize too.
    if ((value.startsWith("{") || value.startsWith("[")) && value.length > 1) {
      try {
        return normalizeValue(JSON.parse(value), replacements);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, replacements));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      // Rekey maps keyed by a random ID (idempotencyGenerations, graphTickets,
      // intentsByChangeSet) as well as revaluing.
      out[replacements.get(key) ?? key] = normalizeValue(nested, replacements);
    }
    return out;
  }
  return value;
}

function normalizeProjection(input: unknown): unknown {
  const projection = structuredClone(input) as any;
  for (const field of STRIPPED_TOP_LEVEL) delete projection[field];
  if (projection.coordinationCounts) {
    for (const field of STRIPPED_COORDINATION_COUNTS) delete projection.coordinationCounts[field];
  }
  return normalizeValue(projection, buildReplacements(projection));
}

// ---------------------------------------------------------------------------
// Crashed-child lifecycle.
// ---------------------------------------------------------------------------
async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("crashed daemon did not exit")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

function childCrashed(child: ChildProcess): boolean {
  return child.signalCode !== null || (child.exitCode !== null && child.exitCode !== 0);
}

function asChangeSet(result: CoordinationResult): { state: string; operationId: string | null } {
  const value = result as { type: string; state?: string; operationId?: string | null };
  if (value.type !== "change_set") throw new Error(`expected change_set result; got ${value.type}`);
  return { state: value.state ?? "", operationId: value.operationId ?? null };
}

// ---------------------------------------------------------------------------
// References: an uninjected prep-only run (change set queued after recovery,
// graph gen 0) and an uninjected completed run (graph gen 1, one committed
// operation). Captured once per suite on separate directories.
// ---------------------------------------------------------------------------
interface Reference {
  graph: ExportedGraph;
  state: unknown;
}
let prepReference: Reference;
let completedReference: Reference;

async function captureReference(full: boolean): Promise<Reference> {
  const outcome = full
    ? await runKernelArmT03(corpus, { preserveDirectory: true, clientId: CRASH_ACTOR })
    : await runKernelArmT03(corpus, {
        stopAfterSubmit: true,
        preserveDirectory: true,
        clientId: CRASH_ACTOR
      });
  const directory = outcome.directory;
  try {
    const exported = reopenAndExport(directory);
    return { graph: exported.graph, state: exported.state };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// One crash case.
// ---------------------------------------------------------------------------
async function runCrashCase(input: { flag: string; value: string; expectCommitted: boolean }): Promise<void> {
  const clientId = CRASH_ACTOR;

  // 1. Failpoint-free prep on a fresh directory; stop cleanly, keep the redb.
  const prep = (await runKernelArmT03(corpus, {
    stopAfterSubmit: true,
    preserveDirectory: true,
    clientId
  })) as KernelArmOutcome & { declarationId: string };
  const directory = prep.directory;
  const changeSetId = prep.changeSetId;
  cleanupDirs.push(directory);

  // 2. Restart the SAME directory with the failpoint armed.
  const crashService = await startKernelService(corpus, {
    directory,
    extraArgs: [input.flag, input.value],
    binaryPath: crashBinary,
    env: credentialFreeEnv()
  });
  const crashClient = new CoordinationClient({ socketPath: crashService.socketPath, clientId });
  const idempotencyKey = randomUUID();

  // 3. Issue ONLY the advance (genuinely the first mutating request; the prior
  //    reads and hello are non-mutating). The daemon aborts at the boundary.
  let threw = false;
  try {
    await crashClient.request(
      { type: "advance_change_set", changeSetId },
      ADVANCE_DEADLINE_MS,
      { idempotencyKey }
    );
  } catch (error) {
    threw = true;
    expect(error).toBeInstanceOf(CoordinationClientError);
  }
  expect(threw, `${input.value}: advance must fail against the aborting daemon`).toBe(true);
  await waitForExit(crashService.child, 30_000);
  expect(childCrashed(crashService.child), `${input.value}: daemon must exit abnormally`).toBe(true);

  // 4a. Reopen OFFLINE (no journal reconciliation) and run the oracle. This
  //     must precede any clean restart, which would recover-and-publish an OLD
  //     store before we can observe that it landed old.
  const after = reopenAndExport(directory);
  const afterKey = graphKey(after.graph);
  expect(
    [graphKey(prepReference.graph), graphKey(completedReference.graph)],
    `${input.value}: graph must be exactly complete-old XOR complete-new`
  ).toContain(afterKey);
  const landedOld = afterKey === graphKey(prepReference.graph);
  expect(landedOld, `${input.value}: expected to land ${input.expectCommitted ? "new" : "old"}`).toBe(
    !input.expectCommitted
  );

  // Atomic-state projection equals the reference for whichever side it landed.
  const expectedState = landedOld ? prepReference.state : completedReference.state;
  expect(normalizeProjection(after.state), `${input.value}: atomic-state projection`).toEqual(
    normalizeProjection(expectedState)
  );

  const committedOperationId = landedOld
    ? null
    : ((after.state as any).operations?.[0]?.operationId as string | undefined) ?? null;
  if (!landedOld) {
    expect(committedOperationId, `${input.value}: committed store must carry one operation`).toBeTruthy();
  }

  // 4b. Exact idempotent replay: restart clean (no failpoint) and re-send the
  //     advance with the SAME idempotency identity (same clientId + key).
  const replayService = await startKernelService(corpus, {
    directory,
    binaryPath: crashBinary,
    env: credentialFreeEnv()
  });
  try {
    const replayClient = new CoordinationClient({ socketPath: replayService.socketPath, clientId });
    const replay = asChangeSet(
      await replayClient.request(
        { type: "advance_change_set", changeSetId },
        ADVANCE_DEADLINE_MS,
        { idempotencyKey }
      )
    );
    expect(replay.state, `${input.value}: replay must be published`).toBe("published");
    expect(replay.operationId, `${input.value}: replay must carry an operation id`).toBeTruthy();
    if (!landedOld) {
      // Landed NEW: the journal returns the cached committed response — the same
      // operationId the durable store already holds.
      expect(replay.operationId, `${input.value}: replay must return the cached operation`).toBe(
        committedOperationId
      );
    }
  } finally {
    await replayService.stop({ preserveDirectory: true });
  }

  // Landed OLD: recovery + replay complete the advance; landed NEW: it was
  // already complete. Either way the final graph equals the completed reference
  // byte-for-byte.
  const final = reopenAndExport(directory);
  expect(graphKey(final.graph), `${input.value}: final graph equals complete-new`).toBe(
    graphKey(completedReference.graph)
  );

  rmSync(directory, { recursive: true, force: true });
  cleanupDirs.splice(cleanupDirs.indexOf(directory), 1);
}

// ---------------------------------------------------------------------------
// Per-boundary OLD/NEW determination (documented in the Task 7 report):
//   Journal stages (`--test-failpoint`) trip on the advance request:
//     after_pending   — aborts BEFORE execute_pending runs the publication → OLD
//     after_effect    — aborts AFTER the advance published durably             → NEW
//     after_prepared  — journal write after publication                        → NEW
//     after_follow_up — after apply_follow_up (a no-op for a clean publish)     → NEW
//     after_completed — after the completed journal write                      → NEW
//   Publication boundaries (`--test-publish-failpoint`, expects_committed_state):
//     beforeRedbTransaction              — abort before begin_write             → OLD
//     insideRedbTransaction              — abort inside the txn, pre-commit      → OLD
//     afterRedbCommitBeforeMemoryPublish — abort after redb commit              → NEW
//     afterMemoryPublish                 — abort after in-memory publish        → NEW
// ---------------------------------------------------------------------------
const JOURNAL_STAGES: { value: string; expectCommitted: boolean }[] = [
  { value: "after_pending", expectCommitted: false },
  { value: "after_effect", expectCommitted: true },
  { value: "after_prepared", expectCommitted: true },
  { value: "after_follow_up", expectCommitted: true },
  { value: "after_completed", expectCommitted: true }
];
const PUBLISH_BOUNDARIES: { value: string; expectCommitted: boolean }[] = [
  { value: "beforeRedbTransaction", expectCommitted: false },
  { value: "insideRedbTransaction", expectCommitted: false },
  { value: "afterRedbCommitBeforeMemoryPublish", expectCommitted: true },
  { value: "afterMemoryPublish", expectCommitted: true }
];

describe("gate 1: crash injection at the advance publication", () => {
  beforeAll(async () => {
    ensureBuilt();
    defaultBinary = join(repoRoot, "target/debug/strata-kernel-service");
    crashBinary = buildCrashBinary();
    process.env.STRATA_KERNEL_SERVICE_BIN = crashBinary;
    prepReference = await captureReference(false);
    completedReference = await captureReference(true);
    // References must differ (gen 0 queued vs gen 1 committed) or the XOR oracle
    // would be trivially satisfiable.
    expect(graphKey(prepReference.graph)).not.toBe(graphKey(completedReference.graph));
  }, 600_000);

  afterAll(() => {
    delete process.env.STRATA_KERNEL_SERVICE_BIN;
  });

  test("default-features daemon rejects --test-publish-failpoint", () => {
    const result = spawnSync(
      defaultBinary,
      [
        "serve",
        "--db",
        join(tmpdir(), "gate1-reject.redb"),
        "--snapshot",
        join(tmpdir(), "gate1-reject.json"),
        "--bridge-worker",
        join(tmpdir(), "gate1-reject-worker.js"),
        "--source-root",
        tmpdir(),
        "--corpus-root",
        tmpdir(),
        "--audit",
        join(tmpdir(), "gate1-reject-audit.jsonl"),
        "--socket-token",
        "reject-token",
        "--test-publish-failpoint",
        "beforeRedbTransaction"
      ],
      { cwd: repoRoot, env: credentialFreeEnv(), encoding: "utf8" }
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}`).toContain("unknown option --test-publish-failpoint");
  });

  for (const stage of JOURNAL_STAGES) {
    test(
      `journal ${stage.value} at advance recovers complete-${stage.expectCommitted ? "new" : "old"}`,
      () => runCrashCase({ flag: "--test-failpoint", ...stage }),
      600_000
    );
  }
  for (const boundary of PUBLISH_BOUNDARIES) {
    test(
      `publish ${boundary.value} recovers complete-${boundary.expectCommitted ? "new" : "old"}`,
      () => runCrashCase({ flag: "--test-publish-failpoint", ...boundary }),
      600_000
    );
  }
});
