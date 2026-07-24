// Bridge-persistence slice, Task 6 (published-only attested delta sync):
// with `--persistent-bridge` the daemon eagerly hydrates ONE persistent
// worker's `:memory:` mirror at startup and keeps it exact via attested,
// published-only delta sync — so analyzeIntent trips carry NO snapshot at
// all (the step-0-measured hydrate + snapshot build/serialize cost is gone),
// while buildValidateCandidate still rides the Task-5 full-snapshot scaffold
// until Task 7's savepoint isolation lands.
//
// End-to-end gates proven here on examples/medium (key-free, no model
// calls):
//
//   (a) N=3 sequential renames with the flag ON produce, mutation by
//       mutation, the same published operation content (affected node ids,
//       rename transitions) and re-inspected payloads as the identical
//       sequence with the flag OFF;
//   (b) EVERY analyzeIntent trip of every mutation is served from the synced
//       mirror: metrics record snapshotBytes == 0 and snapshotBuildNs == 0,
//       outcome "ok" (no silent one-shot fallback), and the worker
//       self-metrics show an analyze stage with NO hydrate stage; the
//       candidate trip still records an in-band snapshot (Task-7 boundary);
//   (c) exactly ONE worker child serves the whole sequence
//       (workerStartsTotal stays 1 across all three mutations);
//   (d) epoch reset (gate h, end-to-end): restarting the daemon on the same
//       store (recovery → NEW service epoch; the old daemon's worker dies
//       with it) eagerly re-hydrates a fresh mirror — the post-restart
//       mutation again runs snapshot-free analyzes with workerStartsTotal 1
//       and results identical to the one-shot arm's.
//
// Modeled on gate1Parity.test.ts / the step-0 driver. See
// docs/superpowers/plans/2026-07-23-bridge-persistence-slice.md, Task 6.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CoordinationClient } from "../src/client.js";
import {
  ADVANCE_DEADLINE_MS,
  DISCOVERY_DEADLINE_MS,
  MAX_ADVANCE_ATTEMPTS,
  SUBMIT_DEADLINE_MS,
  TASK_PROMPT,
  credentialFreeEnv,
  expectResult,
  kernelServiceBinary
} from "../src/gate1.js";
import {
  parseMetricsJsonl,
  type RequestRecord,
  type WorkerRunRecord
} from "../src/gate2.js";
import { startKernelService, type RunningKernelService } from "../src/service.js";
import { ensureBuilt } from "./serviceHarness.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const corpusRoot = resolve(repoRoot, "examples/medium");

/** Three sequential renames ending back at the original name, plus the
 * post-restart rename, so both arms traverse identical graph histories. */
const RENAME_CHAIN: readonly [string, string][] = [
  ["User", "Account"],
  ["Account", "Profile"],
  ["Profile", "User"]
];
const POST_RESTART_RENAME: readonly [string, string] = ["User", "Account"];

const cleanup: string[] = [];
afterAll(() => cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

interface MutationOutcome {
  /** Sorted affected node ids of the published operation. */
  affectedNodeIds: string[];
  /** Rename transitions recorded on the operation, canonicalized. */
  renames: { fromName: string; toName: string }[];
  /** The renamed declaration's payload, re-inspected AFTER publication. */
  inspectedPayload: string;
  /** Daemon-lifetime spawn counter after this mutation. */
  workerStartsTotal: number;
  /** All workerRun records this mutation emitted. */
  workerRuns: WorkerRunRecord[];
}

interface SequenceOutcome {
  mutations: MutationOutcome[];
  postRestart: MutationOutcome;
}

async function runMutation(
  client: CoordinationClient,
  metricsPath: string,
  fromName: string,
  toName: string
): Promise<MutationOutcome> {
  const discovery = expectResult(
    await client.findDeclarations(fromName, "interface", DISCOVERY_DEADLINE_MS),
    "declarations"
  );
  expect(discovery.declarations.length).toBe(1);
  const declarationId = discovery.declarations[0]!.nodeId;

  // Everything emitted so far is pre-window; the mutation's workerRun
  // records are bound by offset, exactly as the step-0 driver binds windows.
  const recordsBefore = parseMetricsJsonl(readFileSync(metricsPath, "utf8")).length;

  const begun = expectResult(await client.beginChangeSet(TASK_PROMPT, SUBMIT_DEADLINE_MS), "change_set");
  const changeSetId = begun.changeSetId;
  expectResult(
    await client.addIntent(
      changeSetId,
      { type: "rename_symbol", declarationId, newName: toName },
      SUBMIT_DEADLINE_MS
    ),
    "change_set"
  );
  expectResult(await client.submitChangeSet(changeSetId, SUBMIT_DEADLINE_MS), "change_set");

  let operationId: string | null = null;
  for (let attempt = 0; attempt < MAX_ADVANCE_ATTEMPTS && operationId === null; attempt += 1) {
    const advanced = expectResult(
      await client.advanceChangeSet(changeSetId, ADVANCE_DEADLINE_MS),
      "change_set"
    );
    if (advanced.state === "published" && advanced.operationId !== null) {
      operationId = advanced.operationId;
    }
  }
  if (operationId === null) {
    throw new Error(`rename ${fromName}->${toName} did not publish within ${MAX_ADVANCE_ATTEMPTS} advances`);
  }

  // Mutation window captured BEFORE the post-publication reads below.
  const mutationRecords = parseMetricsJsonl(readFileSync(metricsPath, "utf8")).slice(recordsBefore);

  const operation = expectResult(
    await client.readOperation(operationId, DISCOVERY_DEADLINE_MS),
    "operation"
  );
  const inspected = expectResult(
    await client.inspectNodes([declarationId], DISCOVERY_DEADLINE_MS),
    "nodes"
  );
  expect(inspected.nodes.length).toBe(1);

  const requestRecords = mutationRecords.filter(
    (record): record is RequestRecord => record.kind === "request"
  );
  expect(requestRecords.length).toBeGreaterThan(0);
  return {
    affectedNodeIds: [...operation.affectedNodeIds].sort(),
    renames: operation.renames
      .map(({ fromName: from, toName: to }) => ({ fromName: from, toName: to }))
      .sort((a, b) => a.fromName.localeCompare(b.fromName)),
    inspectedPayload: inspected.nodes[0]!.payload,
    workerStartsTotal: requestRecords.at(-1)!.workerStartsTotal,
    workerRuns: mutationRecords.filter(
      (record): record is WorkerRunRecord => record.kind === "workerRun"
    )
  };
}

/**
 * The full sequence against fresh daemons over ONE store directory:
 * three renames, a daemon restart on the same store (recovery → new service
 * epoch; the Task-6 epoch contract kills the old worker with the old daemon
 * and eagerly re-hydrates a fresh one), then one more rename. `--metrics`
 * is always on; `persistent` toggles `--persistent-bridge` — the ONLY
 * difference between the two arms.
 */
async function runRenameSequence(persistent: boolean): Promise<SequenceOutcome> {
  const directory = mkdtempSync(join(tmpdir(), "strata-persistent-bridge-"));
  const metricsPath = join(directory, "metrics.jsonl");
  const serviceOptions = {
    binaryPath: kernelServiceBinary(),
    env: credentialFreeEnv(),
    directory,
    extraArgs: ["--metrics", metricsPath, ...(persistent ? ["--persistent-bridge"] : [])]
  };
  let service: RunningKernelService = await startKernelService(corpusRoot, serviceOptions);
  const mutations: MutationOutcome[] = [];
  try {
    const client = new CoordinationClient({
      socketPath: service.socketPath,
      clientId: `persistent-bridge-test:${randomUUID()}`
    });
    await client.hello(DISCOVERY_DEADLINE_MS);
    for (const [fromName, toName] of RENAME_CHAIN) {
      mutations.push(await runMutation(client, metricsPath, fromName, toName));
    }
    await service.stop({ preserveDirectory: true });

    // Restart against the same store: recovery branch, NEW service epoch.
    service = await startKernelService(corpusRoot, serviceOptions);
    const restartedClient = new CoordinationClient({
      socketPath: service.socketPath,
      clientId: `persistent-bridge-test:${randomUUID()}`
    });
    await restartedClient.hello(DISCOVERY_DEADLINE_MS);
    const postRestart = await runMutation(
      restartedClient,
      metricsPath,
      POST_RESTART_RENAME[0],
      POST_RESTART_RENAME[1]
    );
    return { mutations, postRestart };
  } finally {
    await service.stop({ preserveDirectory: true });
    cleanup.push(directory);
  }
}

function analyzeRuns(outcome: MutationOutcome): WorkerRunRecord[] {
  return outcome.workerRuns.filter((run) => run.requestKind === "analyzeIntent");
}

function candidateRuns(outcome: MutationOutcome): WorkerRunRecord[] {
  return outcome.workerRuns.filter((run) => run.requestKind === "buildValidateCandidate");
}

/** Gate (l)'s per-mutation persistent-arm assertions. */
function expectMirrorServedMutation(outcome: MutationOutcome): void {
  // Exactly one worker child has served the daemon's whole lifetime so far.
  expect(outcome.workerStartsTotal).toBe(1);
  expect(outcome.workerRuns.length).toBe(6);

  const analyzes = analyzeRuns(outcome);
  expect(analyzes.length).toBe(5);
  for (const run of analyzes) {
    // Served from the synced mirror: no fallback, no snapshot bytes, no
    // snapshot build, and the worker itself ran no hydrate stage.
    expect(run.outcome).toBe("ok");
    expect(run.snapshotBytes).toBe(0);
    expect(run.snapshotBuildNs).toBe(0);
    expect(run.bridgeWallNs).toBeGreaterThan(0);
    expect(run.totalRequestBytes).toBeGreaterThan(0);
    expect(run.responseBytes).toBeGreaterThan(0);
    expect(run.worker).not.toBeNull();
    expect(run.worker!.analyzeNs).toBeGreaterThan(0);
    expect(run.worker!.hydrateNs ?? null).toBeNull();
  }

  // The candidate trip is still the Task-5 full-snapshot scaffold (Task 7
  // migrates it): snapshot present and worker-side hydration real.
  const candidates = candidateRuns(outcome);
  expect(candidates.length).toBe(1);
  expect(candidates[0]!.outcome).toBe("ok");
  expect(candidates[0]!.snapshotBytes).toBeGreaterThan(0);
  expect(candidates[0]!.snapshotBuildNs).toBeGreaterThan(0);
  expect(candidates[0]!.worker).not.toBeNull();
  expect(candidates[0]!.worker!.hydrateNs).toBeGreaterThan(0);
}

describe("persistent bridge delta sync (--persistent-bridge, snapshot-free analyzes)", () => {
  beforeAll(() => ensureBuilt(), 600_000);

  it("serves N=3 renames + a post-restart rename from ONE attested mirror, identical to one-shot", async () => {
    const oneShot = await runRenameSequence(false);
    const persistent = await runRenameSequence(true);

    // (a) Semantics bit-identical, mutation by mutation, including after the
    // daemon restart.
    const pairs: [MutationOutcome, MutationOutcome][] = [
      ...oneShot.mutations.map(
        (mutation, index) => [mutation, persistent.mutations[index]!] as [MutationOutcome, MutationOutcome]
      ),
      [oneShot.postRestart, persistent.postRestart]
    ];
    for (const [reference, mirrored] of pairs) {
      expect(mirrored.affectedNodeIds).toEqual(reference.affectedNodeIds);
      expect(mirrored.affectedNodeIds.length).toBeGreaterThan(0);
      expect(mirrored.renames).toEqual(reference.renames);
      expect(mirrored.inspectedPayload).toBe(reference.inspectedPayload);
      expect(mirrored.workerRuns.map((run) => run.requestKind).sort()).toEqual(
        reference.workerRuns.map((run) => run.requestKind).sort()
      );
    }
    expect(persistent.postRestart.inspectedPayload).toContain(POST_RESTART_RENAME[1]);

    // (b)+(c): every mutation of the sequence is mirror-served — snapshot-free
    // analyzes from the FIRST trip (eager hydration), one worker child total.
    for (const mutation of persistent.mutations) {
      expectMirrorServedMutation(mutation);
    }

    // (d) Epoch reset end-to-end: the restarted daemon (new service epoch,
    // fresh eagerly-hydrated worker) serves the next mutation snapshot-free
    // with its own single worker child.
    expectMirrorServedMutation(persistent.postRestart);

    // One-shot arm sanity: spawn-per-trip remains its lifecycle (the counter
    // grows with every trip instead of staying at 1).
    const lastOneShot = oneShot.postRestart;
    expect(lastOneShot.workerStartsTotal).toBe(lastOneShot.workerRuns.length);
    for (const mutation of oneShot.mutations) {
      expect(mutation.workerRuns.length).toBe(6);
      for (const run of analyzeRuns(mutation)) {
        expect(run.snapshotBytes).toBeGreaterThan(0);
      }
    }
  }, 900_000);
});
