// Bridge-persistence slice, Task 5 (B-as-scaffold): the daemon can route its
// analyzeIntent / buildValidateCandidate bridge trips through ONE persistent
// Node worker (`--persistent-bridge`, default OFF) while still sending the
// full snapshot per request. This test proves the two transports are
// semantically identical on a real corpus and that the persistent transport
// really is one child process for the whole mutation:
//
//   (a) one rename mutation on examples/medium with the flag ON produces the
//       same published operation content (affected node ids, rename
//       transitions) and the same re-inspected renamed declaration payload as
//       the identical run with the flag OFF;
//   (b) exactly ONE worker child served every bridge trip: the daemon's
//       spawn-anchored `workerStartsTotal` counter stays at 1 after the full
//       mutation (vs one spawn per trip one-shot), and metrics parity holds —
//       the same number of workerRun records per mutation (6: 5 analyze + 1
//       candidate on this corpus), each with outcome "ok" (no silent one-shot
//       fallback) and the worker's self-reported stage metrics present.
//
// Modeled on gate1Parity.test.ts / the step-0 driver; key-free, no model
// calls. See docs/superpowers/plans/2026-07-23-bridge-persistence-slice.md.
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
  NEW_NAME,
  OLD_NAME,
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
import { startKernelService } from "../src/service.js";
import { ensureBuilt } from "./serviceHarness.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const corpusRoot = resolve(repoRoot, "examples/medium");

const cleanup: string[] = [];
afterAll(() => cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

interface RenameRunOutcome {
  /** Sorted affected node ids of the published operation. */
  affectedNodeIds: string[];
  /** Rename transitions recorded on the operation, canonicalized. */
  renames: { fromName: string; toName: string }[];
  /** The renamed declaration's payload, re-inspected AFTER publication. */
  inspectedPayload: string;
  /** Daemon-lifetime spawn counter after the full mutation. */
  workerStartsTotal: number;
  /** All workerRun records the mutation emitted (submit + advance window). */
  workerRuns: WorkerRunRecord[];
}

/**
 * One full key-free rename mutation (User -> Account) against a fresh daemon
 * over examples/medium, with `--metrics` always on so workerRun records and
 * the spawn counter are observable. `persistent` toggles `--persistent-bridge`
 * — the ONLY difference between the two runs this test compares.
 */
async function runRenameMutation(persistent: boolean): Promise<RenameRunOutcome> {
  const directory = mkdtempSync(join(tmpdir(), "strata-persistent-bridge-"));
  const metricsPath = join(directory, "metrics.jsonl");
  const service = await startKernelService(corpusRoot, {
    binaryPath: kernelServiceBinary(),
    env: credentialFreeEnv(),
    directory,
    extraArgs: ["--metrics", metricsPath, ...(persistent ? ["--persistent-bridge"] : [])]
  });
  try {
    const client = new CoordinationClient({
      socketPath: service.socketPath,
      clientId: `persistent-bridge-test:${randomUUID()}`
    });
    await client.hello(DISCOVERY_DEADLINE_MS);
    const discovery = expectResult(
      await client.findDeclarations(OLD_NAME, "interface", DISCOVERY_DEADLINE_MS),
      "declarations"
    );
    expect(discovery.declarations.length).toBe(1);
    const declarationId = discovery.declarations[0]!.nodeId;

    // Everything emitted so far (recovery/hello/discovery) is pre-window;
    // the mutation's workerRun records are bound by offset, exactly as the
    // step-0 driver binds its windows.
    const recordsBefore = parseMetricsJsonl(readFileSync(metricsPath, "utf8")).length;

    const begun = expectResult(await client.beginChangeSet(TASK_PROMPT, SUBMIT_DEADLINE_MS), "change_set");
    const changeSetId = begun.changeSetId;
    expectResult(
      await client.addIntent(
        changeSetId,
        { type: "rename_symbol", declarationId, newName: NEW_NAME },
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
      throw new Error(`rename did not publish within ${MAX_ADVANCE_ATTEMPTS} advances`);
    }

    // Mutation window captured BEFORE the post-publication reads below, so the
    // workerRun count is exactly the mutation's (reads spawn no workers, but
    // keeping the window tight makes that irrelevant).
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
        .map(({ fromName, toName }) => ({ fromName, toName }))
        .sort((a, b) => a.fromName.localeCompare(b.fromName)),
      inspectedPayload: inspected.nodes[0]!.payload,
      workerStartsTotal: requestRecords.at(-1)!.workerStartsTotal,
      workerRuns: mutationRecords.filter(
        (record): record is WorkerRunRecord => record.kind === "workerRun"
      )
    };
  } finally {
    await service.stop({ preserveDirectory: true });
    cleanup.push(directory);
  }
}

describe("persistent bridge scaffold (--persistent-bridge, full snapshot per request)", () => {
  beforeAll(() => ensureBuilt(), 600_000);

  it("publishes the identical rename through ONE persistent worker", async () => {
    const oneShot = await runRenameMutation(false);
    const persistent = await runRenameMutation(true);

    // (a) Semantics bit-identical: published operation content, affected set,
    // and the re-inspected renamed payload all equal the one-shot run's.
    expect(persistent.affectedNodeIds).toEqual(oneShot.affectedNodeIds);
    expect(persistent.affectedNodeIds.length).toBeGreaterThan(0);
    expect(persistent.renames).toEqual(oneShot.renames);
    expect(persistent.inspectedPayload).toBe(oneShot.inspectedPayload);
    expect(persistent.inspectedPayload).toContain(NEW_NAME);

    // (b) Exactly one worker child served every bridge trip: the daemon's
    // spawn-anchored counter is 1 after the whole mutation, while the one-shot
    // transport spawned one child per trip (6 on this corpus).
    expect(persistent.workerStartsTotal).toBe(1);
    expect(oneShot.workerStartsTotal).toBe(oneShot.workerRuns.length);
    expect(oneShot.workerStartsTotal).toBeGreaterThanOrEqual(6);

    // Metrics parity: same record count per mutation (the gate-3 step-0 driver
    // binds 6 workerRun records per mutation), every persistent trip "ok" (no
    // silent one-shot fallback), and full field parity — daemon-side stage
    // timings populated and worker self-metrics parsed from the response.
    expect(persistent.workerRuns.length).toBe(oneShot.workerRuns.length);
    expect(persistent.workerRuns.length).toBe(6);
    for (const run of persistent.workerRuns) {
      expect(run.outcome).toBe("ok");
      expect(run.bridgeWallNs).toBeGreaterThan(0);
      expect(run.snapshotBuildNs).toBeGreaterThan(0);
      expect(run.requestSerializeNs).toBeGreaterThan(0);
      expect(run.snapshotBytes).toBeGreaterThan(0);
      expect(run.totalRequestBytes).toBeGreaterThan(0);
      expect(run.responseBytes).toBeGreaterThan(0);
      expect(run.worker).not.toBeNull();
      expect(run.worker!.totalNs).toBeGreaterThan(0);
    }
    expect(persistent.workerRuns.map((run) => run.requestKind).sort()).toEqual(
      oneShot.workerRuns.map((run) => run.requestKind).sort()
    );
  }, 600_000);
});
