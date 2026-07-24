#!/usr/bin/env node
// Bridge-persistence slice, Step 0: per-stage decomposition diagnostic.
//
// Chartered by docs/superpowers/specs/2026-07-22-bridge-persistence-slice-design.md
// ("Step 0 — diagnostic experiment"): ONE key-free big1k metrics-on mutation,
// PRESERVING the raw metrics JSONL. The gate-3 characterizer (characterize.ts)
// deliberately reduces workerRun records to a peak-RSS scalar; this driver is
// the separate diagnostic that keeps every per-stage timing the daemon already
// emits (workerRun: snapshotBuildNs / requestSerializeNs / worker.hydrateNs /
// analyzeNs / mutateNs / validateNs / exportNs; publishing advance:
// publication.preCandidateAnalysisNs / candidateNs / postCandidateAnalysisNs /
// persistenceNs / memoryPublishNs). No new instrumentation — this only reads
// what `--metrics` already writes.
//
// NOT part of any gate or CI suite; an operator-run spike whose artifact lands
// under docs/spikes/. Timing verdicts never come from metrics-on runs (B1);
// this feeds the bridge-persistence implementation plan, not any ratio.
//
// Usage:
//   node packages/live-compare/dist/gate3/step0-stage-decomposition.js \
//     [--copies 46] [--n 1] [--out docs/spikes/bridge-persistence-step0] \
//     [--daemon-arg --persistent-bridge]   # repeatable; appended to serve argv
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoordinationClient } from "../client.js";
import {
  ADVANCE_DEADLINE_MS,
  DISCOVERY_DEADLINE_MS,
  MAX_ADVANCE_ATTEMPTS,
  SUBMIT_DEADLINE_MS,
  TASK_PROMPT,
  credentialFreeEnv,
  expectResult,
  kernelServiceBinary
} from "../gate1.js";
import {
  parseMetricsJsonl,
  type MetricsRecord,
  type RequestRecord,
  type WorkerRunRecord
} from "../gate2.js";
import { startKernelService } from "../service.js";
import { BIG1K_COPIES, buildReplicatedCorpus } from "./corpus.js";

const packageRoot = resolve(__dirname, "..", "..");
const repoRoot = resolve(packageRoot, "..", "..");
const mediumRoot = resolve(repoRoot, "examples", "medium");

interface CliOptions {
  copies: number;
  n: number;
  outDir: string;
  /** Extra argv appended to the daemon's `serve` invocation (repeatable
   * `--daemon-arg VALUE`, added for the Task-5 persistent-bridge ablation:
   * `--daemon-arg --persistent-bridge` runs the same measurement against a
   * persistent-bridge daemon). */
  daemonArgs: string[];
}

function parseCli(argv: readonly string[]): CliOptions {
  let copies = BIG1K_COPIES;
  let n = 1;
  let outDir = resolve(repoRoot, "docs", "spikes", "bridge-persistence-step0");
  const daemonArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`step0: flag ${flag} requires a value`);
    if (flag === "--copies") copies = Number(value);
    else if (flag === "--n") n = Number(value);
    else if (flag === "--out") outDir = resolve(value);
    else if (flag === "--daemon-arg") daemonArgs.push(value);
    else throw new Error(`step0: unknown flag ${flag}`);
  }
  if (!Number.isInteger(copies) || copies < 1) throw new Error(`step0: bad --copies ${copies}`);
  if (!Number.isInteger(n) || n < 1) throw new Error(`step0: bad --n ${n}`);
  return { copies, n, outDir, daemonArgs };
}

/** One workerRun trip, decomposed. `spawnAndTransportNs` is the residual of the daemon-observed bridge wall not accounted for by snapshot build, request serialize, or the worker's self-reported stage total: child spawn + module load + stdin write + response read + worker-side non-staged overhead. */
interface TripDecomposition {
  requestKind: WorkerRunRecord["requestKind"];
  phase: WorkerRunRecord["phase"];
  outcome: string;
  bridgeWallNs: number;
  snapshotBuildNs: number;
  requestSerializeNs: number;
  spawnAndTransportNs: number;
  snapshotBytes: number;
  totalRequestBytes: number;
  responseBytes: number;
  workerHydrateNs: number | null;
  workerAnalyzeNs: number | null;
  workerMutateNs: number | null;
  workerValidateNs: number | null;
  workerExportNs: number | null;
  workerTotalNs: number | null;
  workerPeakRssBytes: number | null;
  seq: number;
}

/** One coordination request, with the worker trips the daemon ran while serving it. `coordinationResidualNs` = request wall minus the sum of its trips' bridge walls (redb reads/writes, planning, journal fsyncs, publication bookkeeping). */
interface RequestDecomposition {
  action: string;
  wallNs: number;
  publishing: boolean;
  publication: RequestRecord["publication"];
  trips: TripDecomposition[];
  tripBridgeWallSumNs: number;
  coordinationResidualNs: number;
  seq: number;
}

interface IterationDecomposition {
  iteration: number;
  requests: RequestDecomposition[];
  totalRequestWallNs: number;
  tripCount: number;
}

function decomposeTrip(record: WorkerRunRecord): TripDecomposition {
  const worker = record.worker;
  const workerTotalNs = worker?.totalNs ?? null;
  return {
    requestKind: record.requestKind,
    phase: record.phase,
    outcome: record.outcome,
    bridgeWallNs: record.bridgeWallNs,
    snapshotBuildNs: record.snapshotBuildNs,
    requestSerializeNs: record.requestSerializeNs,
    spawnAndTransportNs: Math.max(
      0,
      record.bridgeWallNs - record.snapshotBuildNs - record.requestSerializeNs - (workerTotalNs ?? 0)
    ),
    snapshotBytes: record.snapshotBytes,
    totalRequestBytes: record.totalRequestBytes,
    responseBytes: record.responseBytes,
    workerHydrateNs: worker?.hydrateNs ?? null,
    workerAnalyzeNs: worker?.analyzeNs ?? null,
    workerMutateNs: worker?.mutateNs ?? null,
    workerValidateNs: worker?.validateNs ?? null,
    workerExportNs: worker?.exportNs ?? null,
    workerTotalNs,
    workerPeakRssBytes: worker?.peakRssBytes ?? null,
    seq: record.seq
  };
}

/**
 * Bind workerRun records to the request that ran them, by emission order:
 * `emit_request_metrics` (session.rs) drains all pending workerRun records
 * and THEN emits the request record, synchronously, before the response
 * returns — so in seq order, every workerRun belongs to the next request
 * record that follows it. Callers pass only the records appended during the
 * iteration's window (offset-sliced, exactly as characterize.ts binds its
 * windows), so no seq arithmetic is needed here.
 */
function decomposeWindow(records: readonly MetricsRecord[]): RequestDecomposition[] {
  const requests: RequestDecomposition[] = [];
  let pendingTrips: TripDecomposition[] = [];
  for (const record of records) {
    if (record.kind === "recovery") continue;
    if (record.kind === "workerRun") {
      pendingTrips.push(decomposeTrip(record));
      continue;
    }
    const tripBridgeWallSumNs = pendingTrips.reduce((sum, trip) => sum + trip.bridgeWallNs, 0);
    requests.push({
      action: record.action,
      wallNs: record.wallNs,
      publishing: record.publication !== null,
      publication: record.publication,
      trips: pendingTrips,
      tripBridgeWallSumNs,
      coordinationResidualNs: Math.max(0, record.wallNs - tripBridgeWallSumNs),
      seq: record.seq
    });
    pendingTrips = [];
  }
  if (pendingTrips.length > 0) {
    throw new Error(
      `step0: ${pendingTrips.length} trailing workerRun record(s) with no subsequent request record — ` +
        `binding assumption violated`
    );
  }
  return requests;
}

const NS_PER_MS = 1_000_000;
function ms(ns: number | null): string {
  return ns === null ? "—" : (ns / NS_PER_MS).toFixed(1);
}

function printIteration(iterationDecomposition: IterationDecomposition): void {
  const { iteration, requests } = iterationDecomposition;
  console.log(`\n=== iteration ${iteration} ===`);
  for (const request of requests) {
    console.log(
      `${request.action}${request.publishing ? " (publishing)" : ""}: wall ${ms(request.wallNs)} ms — ` +
        `${request.trips.length} worker trip(s) sum ${ms(request.tripBridgeWallSumNs)} ms, ` +
        `coordination residual ${ms(request.coordinationResidualNs)} ms`
    );
    for (const trip of request.trips) {
      console.log(
        `  [${trip.phase}] ${trip.requestKind} (${trip.outcome}): bridge ${ms(trip.bridgeWallNs)} ms = ` +
          `snapshotBuild ${ms(trip.snapshotBuildNs)} + serialize ${ms(trip.requestSerializeNs)} + ` +
          `spawn/transport ${ms(trip.spawnAndTransportNs)} + workerTotal ${ms(trip.workerTotalNs)} ` +
          `(hydrate ${ms(trip.workerHydrateNs)}, analyze ${ms(trip.workerAnalyzeNs)}, ` +
          `mutate ${ms(trip.workerMutateNs)}, validate ${ms(trip.workerValidateNs)}, ` +
          `export ${ms(trip.workerExportNs)}); snapshot ${(trip.snapshotBytes / 1_048_576).toFixed(1)} MiB`
      );
    }
    if (request.publication !== null) {
      const publication = request.publication;
      console.log(
        `  publication: preCandidateAnalysis ${ms(publication.preCandidateAnalysisNs)} + ` +
          `candidate ${ms(publication.candidateNs)} + postCandidateAnalysis ${ms(publication.postCandidateAnalysisNs)} + ` +
          `persistence ${ms(publication.persistenceNs)} + memoryPublish ${ms(publication.memoryPublishNs)} ms`
      );
    }
  }
}

async function resolveTargetDeclarationId(client: CoordinationClient, name: string): Promise<string> {
  // Same deterministic smallest-nodeId pick as characterize.ts / kernel-child.ts
  // (kernel Module nodes carry no path payload; all replicated copies are
  // structurally identical, so any copy is measurement-equivalent).
  const discovery = expectResult(
    await client.findDeclarations(name, "interface", DISCOVERY_DEADLINE_MS),
    "declarations"
  );
  if (discovery.declarations.length === 0) {
    throw new Error(`step0: no interface named ${JSON.stringify(name)} found`);
  }
  return [...discovery.declarations].sort((a, b) => a.nodeId.localeCompare(b.nodeId))[0]!.nodeId;
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  mkdirSync(options.outDir, { recursive: true });

  const corpusDir = mkdtempSync(join(tmpdir(), "strata-step0-corpus-"));
  const serviceDir = mkdtempSync(join(tmpdir(), "strata-step0-service-"));
  const metricsPath = join(serviceDir, "metrics.jsonl");

  const corpusBuildStart = process.hrtime.bigint();
  const corpus = buildReplicatedCorpus(mediumRoot, corpusDir, options.copies);
  const corpusBuildNs = Number(process.hrtime.bigint() - corpusBuildStart);
  console.log(
    `corpus: ${corpus.moduleCount} modules (${corpus.copies} copies), digest ${corpus.corpusDigest.slice(0, 12)}…, ` +
      `built in ${ms(corpusBuildNs)} ms`
  );

  const serviceStart = process.hrtime.bigint();
  const service = await startKernelService(corpus.corpusRoot, {
    binaryPath: kernelServiceBinary(),
    env: credentialFreeEnv(),
    directory: serviceDir,
    extraArgs: ["--metrics", metricsPath, ...options.daemonArgs]
  });
  const serviceStartNs = Number(process.hrtime.bigint() - serviceStart);
  console.log(`daemon: ingest+seed+ready in ${ms(serviceStartNs)} ms (${kernelServiceBinary()})`);

  const iterations: IterationDecomposition[] = [];
  try {
    const client = new CoordinationClient({
      socketPath: service.socketPath,
      clientId: `bridge-persistence-step0:${randomUUID()}`
    });
    await client.hello(DISCOVERY_DEADLINE_MS);
    const declarationId = await resolveTargetDeclarationId(client, corpus.renameTarget.declarationName);

    // Everything emitted so far (hello/discovery) is pre-window; bind by offset.
    let recordsSoFar = parseMetricsJsonl(readFileSync(metricsPath, "utf8")).length;

    for (let iteration = 0; iteration < options.n; iteration += 1) {
      const nextName =
        iteration % 2 === 0 ? corpus.renameTarget.newName : corpus.renameTarget.declarationName;
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
        throw new Error(`step0: iteration ${iteration} did not publish within ${MAX_ADVANCE_ATTEMPTS} advances`);
      }

      const records = parseMetricsJsonl(readFileSync(metricsPath, "utf8"));
      const requests = decomposeWindow(records.slice(recordsSoFar));
      recordsSoFar = records.length;
      iterations.push({
        iteration,
        requests,
        totalRequestWallNs: requests.reduce((sum, request) => sum + request.wallNs, 0),
        tripCount: requests.reduce((sum, request) => sum + request.trips.length, 0)
      });
      printIteration(iterations[iterations.length - 1]!);
    }
  } finally {
    // Preserve the service dir long enough to copy the raw JSONL out, then drop it.
    await service.stop({ preserveDirectory: true });
    copyFileSync(metricsPath, join(options.outDir, "metrics.jsonl"));
    rmSync(serviceDir, { recursive: true, force: true });
    rmSync(corpusDir, { recursive: true, force: true });
  }

  const summary = {
    generatedBy: "packages/live-compare/src/gate3/step0-stage-decomposition.ts",
    options: { copies: options.copies, n: options.n, daemonArgs: options.daemonArgs },
    binaryPath: kernelServiceBinary(),
    corpus: { moduleCount: corpus.moduleCount, copies: corpus.copies, corpusDigest: corpus.corpusDigest },
    corpusBuildNs,
    serviceStartNs,
    iterations
  };
  writeFileSync(join(options.outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`\nwrote ${join(options.outDir, "summary.json")} and metrics.jsonl`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
