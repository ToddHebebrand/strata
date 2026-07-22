// Gate 3 (unkeyed noninferiority), Task 5 (half b): metrics-on kernel-server
// characterization.
//
// B1 (plan, Global Constraints): timing (the noninferiority ratio) is always
// metrics-OFF for both arms — `kernel-child.ts` (Task 2) never passes
// `--metrics`, on purpose, and stays that way. This module is the SEPARATE
// metrics-ON kernel run the plan carves out to characterize server-side
// per-stage wall + memory: it feeds the gate-3 REPORT, never the wall
// verdict.
//
// Driver choice: an in-file client loop (mirroring gate1's/gate2's own
// `beginChangeSet`/`addIntent`/`submitChangeSet`/`advanceChangeSet` flow)
// rather than the Task-2 kernel-child. Two reasons: (1) kernel-child starts
// its daemon metrics-OFF BY DESIGN (see its module doc) — that default must
// not move for timed runs, and driving it in metrics-on mode here would mean
// either forking its behavior via a new opt-in field (extra wire-protocol
// surface for a single-arm, non-timed characterization run) or reaching past
// its process boundary; (2) the per-iteration JSONL-offset binding this
// module's binding constraint (Major 7) requires reading the metrics file
// between iterations, which is trivial to interleave into a same-process
// loop and awkward to coordinate across a spawned child's stdio protocol.
// The gate-2 JSONL schema/parser (`parseMetricsJsonl`, `RequestRecord`,
// `WorkerRunRecord`) IS reused as-is, unmodified — only the per-iteration
// binding logic here is new.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoordinationClient } from "../client.js";
import {
  ADVANCE_DEADLINE_MS,
  DISCOVERY_DEADLINE_MS,
  SUBMIT_DEADLINE_MS,
  TASK_PROMPT,
  credentialFreeEnv,
  expectResult,
  kernelServiceBinary
} from "../gate1.js";
import {
  maxDaemonPeakRssBytes,
  maxWorkerPeakRssBytes,
  parseMetricsJsonl,
  type MetricsRecord,
  type RequestRecord,
  type WorkerRunRecord
} from "../gate2.js";
import { startKernelService } from "../service.js";
import type { RunnerCorpus } from "./runners.js";
import { nearestRankDistribution, type WallDistribution } from "./stats.js";

const MAX_ADVANCE_ATTEMPTS = 10;

export interface CharacterizeKernelServerOptions {
  n: number;
  seed: number;
}

/** `{ submit, advance, daemonRss, workerRss }` — the metrics-on kernel-server characterization over `n` mutations. */
export interface KernelServerCharacterization {
  submit: WallDistribution;
  advance: WallDistribution;
  /** Per-iteration daemon peak-RSS high-water mark, maxed across the run. */
  daemonRss: number;
  /** Per-iteration worker peak-RSS high-water mark, maxed across the run. */
  workerRss: number;
}

/**
 * Resolve the interface named `name` inside `target.modulePath`, filtering
 * out same-named declarations in other (replicated-corpus) copies.
 *
 * Deliberately duplicated from `kernel-child.ts`'s identical private helper
 * rather than imported: `kernel-child.ts` is a `#!/usr/bin/env node` script
 * entrypoint whose module body unconditionally invokes `main()` (reads
 * stdin, spawns a daemon) — importing it here for one helper function would
 * run that entrypoint as a side effect of loading this module. See
 * `kernel-child.ts`'s own module doc.
 */
async function resolveTargetDeclarationId(
  client: CoordinationClient,
  target: RunnerCorpus["target"],
  name: string
): Promise<string> {
  // See kernel-child.ts's identical helper for the full rationale: the kernel
  // graph's Module nodes carry no path payload, so the kernel arm cannot select
  // a replicated copy by `target.modulePath`. Every copy is structurally
  // identical and validation covers the whole corpus, so a deterministic pick
  // (smallest nodeId) is a measurement-equivalent, reproducible choice.
  void target;
  const discovery = expectResult(
    await client.findDeclarations(name, "interface", DISCOVERY_DEADLINE_MS),
    "declarations"
  );
  if (discovery.declarations.length === 0) {
    throw new Error(`characterizeKernelServer: no interface named ${JSON.stringify(name)} found`);
  }
  return [...discovery.declarations].sort((a, b) => a.nodeId.localeCompare(b.nodeId))[0]!.nodeId;
}

/** Read and fully re-parse the metrics JSONL sink. Simple and robust (whole-file re-parse each call) — the file is small for `n` in the tens, and every record is guaranteed flushed before the daemon's response reaches us (see `metrics.rs`: `emit_request_metrics` runs synchronously before the mutation's response is returned, and `MetricsSink::emit` flushes every record). */
function readAllMetricsRecords(metricsPath: string): MetricsRecord[] {
  return parseMetricsJsonl(readFileSync(metricsPath, "utf8"));
}

/** One iteration's validated window binding — see `bindIterationWindow`. */
export interface IterationWindowBinding {
  submitRecord: RequestRecord;
  advanceRecord: RequestRecord;
  /** All records newly appended in this iteration's window (request + workerRun alike), for RSS aggregation. */
  newRecords: MetricsRecord[];
  /** `records.length` as of this binding — the `priorOffset` the NEXT iteration's `bindIterationWindow` call must pass. */
  newOffset: number;
}

/**
 * Validates and binds one iteration's window of newly-appended metrics
 * records to that iteration (plan Major 7): `records` is the FULL,
 * currently-parsed metrics record array; `priorOffset` is the record count
 * observed before this iteration ran (the previous call's `newOffset`, or 0
 * for the first iteration). Only `records.slice(priorOffset)` — the records
 * appended DURING this iteration — are inspected; older records (from a
 * prior iteration, or from resolving the target before the loop started)
 * are never re-examined, which is what prevents cross-iteration bleed.
 *
 * Requires exactly one new `submit_change_set` request record and exactly
 * one new PUBLISHING (`publication !== null`) `advance_change_set` request
 * record in that window — a non-publishing `advance_change_set` (still
 * polling) is expected and ignored, but the count of *publishing* advances
 * must be exactly 1. Any other count throws loudly, with the offset window
 * in the message: a silent cross-iteration mix would corrupt the reported
 * wall distributions.
 *
 * Pure and synchronous — no I/O, no daemon — so it is unit-testable
 * directly against synthetic record arrays (see
 * `tests/gate3Characterize.test.ts`'s `bindIterationWindow` suite).
 */
export function bindIterationWindow(
  records: readonly MetricsRecord[],
  priorOffset: number,
  iteration: number
): IterationWindowBinding {
  const newRecords = records.slice(priorOffset);
  const newOffset = records.length;

  const newRequestRecords = newRecords.filter(
    (record): record is RequestRecord => record.kind === "request"
  );
  const submitRecords = newRequestRecords.filter((record) => record.action === "submit_change_set");
  const publishingAdvanceRecords = newRequestRecords.filter(
    (record) => record.action === "advance_change_set" && record.publication !== null
  );

  if (submitRecords.length !== 1) {
    throw new Error(
      `characterizeKernelServer: iteration ${iteration} bound ${submitRecords.length} ` +
        `submit_change_set metrics record(s) (expected exactly 1) — cross-iteration bleed in the ` +
        `metrics JSONL (offset window [${priorOffset}, ${newOffset}))`
    );
  }
  if (publishingAdvanceRecords.length !== 1) {
    throw new Error(
      `characterizeKernelServer: iteration ${iteration} bound ${publishingAdvanceRecords.length} ` +
        `publishing advance_change_set metrics record(s) (expected exactly 1) — cross-iteration bleed ` +
        `in the metrics JSONL (offset window [${priorOffset}, ${newOffset}))`
    );
  }

  return {
    submitRecord: submitRecords[0]!,
    advanceRecord: publishingAdvanceRecords[0]!,
    newRecords: [...newRecords],
    newOffset
  };
}

/**
 * Drive `n` renames against a metrics-ON kernel daemon, alternating direction
 * each iteration (mirrors `kernel-child.ts`'s own alternation), and bind each
 * iteration's submit + publishing-advance `request.wallNs` to that iteration
 * by JSONL record-count offset (Major 7): before iteration `i` runs, record
 * how many records the sink has emitted so far; after it completes, parse
 * only the records appended since — never sum/filter by action across the
 * whole accumulating file. Exactly one new `submit_change_set` record and
 * exactly one new publishing (`publication !== null`) `advance_change_set`
 * record are required per iteration; any other count throws loudly (a
 * silent cross-iteration mix would corrupt the reported distributions).
 *
 * `daemonRss`/`workerRss` are each iteration's own high-water mark (the max
 * `daemonPeakRssBytes`/`worker.peakRssBytes` seen among that iteration's new
 * records), then maxed again across all iterations for the single number
 * this function returns — RSS is a monotonic high-water statistic, so this
 * is equivalent to (and computed alongside) the whole run's peak.
 */
export async function characterizeKernelServer(
  corpus: RunnerCorpus,
  options: CharacterizeKernelServerOptions
): Promise<KernelServerCharacterization> {
  const { n, seed } = options;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`characterizeKernelServer: n must be a positive integer, got ${n}`);
  }

  const directory = mkdtempSync(join(tmpdir(), "strata-gate3-characterize-"));
  const metricsPath = join(directory, "metrics.jsonl");
  const service = await startKernelService(resolve(corpus.corpusRoot), {
    binaryPath: kernelServiceBinary(),
    env: credentialFreeEnv(),
    directory,
    extraArgs: ["--metrics", metricsPath]
  });
  const client = new CoordinationClient({
    socketPath: service.socketPath,
    // The seed carries no randomization role here (characterization runs a
    // deterministic alternating sequence, not a balanced-paired schedule) —
    // it is threaded into the client id purely so a characterization run is
    // traceable back to the options it was invoked with.
    clientId: `gate3-characterize:seed-${seed}:${randomUUID()}`
  });

  try {
    await client.hello(DISCOVERY_DEADLINE_MS);
    const declarationId = await resolveTargetDeclarationId(client, corpus.target, corpus.target.declarationName);

    const submitSamples: number[] = [];
    const advanceSamples: number[] = [];
    const daemonRssPerIteration: number[] = [];
    const workerRssPerIteration: number[] = [];

    let recordsSoFar = readAllMetricsRecords(metricsPath).length;

    for (let iteration = 0; iteration < n; iteration += 1) {
      const nextName = iteration % 2 === 0 ? corpus.target.newName : corpus.target.declarationName;

      const begun = expectResult(await client.beginChangeSet(TASK_PROMPT, SUBMIT_DEADLINE_MS), "change_set");
      const changeSetId = begun.changeSetId;
      expectResult(
        await client.addIntent(
          changeSetId,
          { type: "rename_symbol", declarationId, newName: nextName },
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
        throw new Error(
          `characterizeKernelServer: iteration ${iteration} (change set ${changeSetId}) did not reach ` +
            `'published' within ${MAX_ADVANCE_ATTEMPTS} advance attempts`
        );
      }

      const allRecords = readAllMetricsRecords(metricsPath);
      const { submitRecord, advanceRecord, newRecords, newOffset } = bindIterationWindow(
        allRecords,
        recordsSoFar,
        iteration
      );
      recordsSoFar = newOffset;

      submitSamples.push(submitRecord.wallNs);
      advanceSamples.push(advanceRecord.wallNs);

      const newRequestRecords = newRecords.filter(
        (record): record is RequestRecord => record.kind === "request"
      );
      const newWorkerRunRecords = newRecords.filter(
        (record): record is WorkerRunRecord => record.kind === "workerRun"
      );
      daemonRssPerIteration.push(maxDaemonPeakRssBytes(newRequestRecords));
      workerRssPerIteration.push(maxWorkerPeakRssBytes(newWorkerRunRecords));
    }

    return {
      submit: nearestRankDistribution(submitSamples),
      advance: nearestRankDistribution(advanceSamples),
      daemonRss: Math.max(...daemonRssPerIteration),
      workerRss: Math.max(...workerRssPerIteration)
    };
  } finally {
    await service.stop();
  }
}
