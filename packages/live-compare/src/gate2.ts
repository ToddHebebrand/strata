// Gate 2 of the iteration-6 slice-A convergence frame: key-free per-stage
// observability. Drives the same kernel-arm T03 flow gate 1 proved
// semantically parity-correct (see gate1.ts), twice — a cold start and a
// restart — with the daemon's opt-in `--metrics` JSONL sink enabled, then
// parses and aggregates the two files into one machine-checked profile.
//
// No model calls. No API keys. No persisted SQLite (this module never opens
// one). Attribution is by tag (`changeSetId` + `phase`), never by drain
// adjacency — a `workerRun` record does NOT "belong to" the `request` record
// it happens to precede in the file; see
// docs/superpowers/plans/2026-07-19-iteration6-slice-a-gate2.md.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { CoordinationClient } from "./client.js";
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
} from "./gate1.js";
import { startKernelService } from "./service.js";

// ---------------------------------------------------------------------------
// Metrics JSONL record schemas (Shared vocabulary — camelCase on disk).
// ---------------------------------------------------------------------------

const nonNegInt = z.number().int().nonnegative();

/**
 * The worker's self-report — `RunPhase`-tagged per-stage nanoseconds + peak RSS.
 *
 * Per-stage fields are `.nullish()`, not `.optional()`: the daemon's Rust
 * `WorkerSelfMetrics` (bridge/protocol.rs) serializes each stage as
 * `Option<u64>` with NO `skip_serializing_if`, so a stage a run never entered
 * (e.g. `validateNs`/`exportNs` on an analyze-only run) is emitted as explicit
 * `null` in the `--metrics` JSONL — not omitted. The tolerant `.nullish()`
 * superset accepts both the daemon's `null` and a hand-omitted field (as in the
 * unit fixture), matching the authoritative producer format either way.
 */
const workerSelfMetricsSchema = z
  .object({
    hydrateNs: nonNegInt.nullish(),
    analyzeNs: nonNegInt.nullish(),
    mutateNs: nonNegInt.nullish(),
    validateNs: nonNegInt.nullish(),
    exportNs: nonNegInt.nullish(),
    totalNs: nonNegInt,
    peakRssBytes: nonNegInt
  })
  .strict();

const runPhaseSchema = z.enum([
  "submitAnalysis",
  "claimAnalysis",
  "preCandidateAnalysis",
  "postCandidateAnalysis",
  "candidate",
  "unattributed"
]);

const recoveryRecordSchema = z
  .object({
    kind: z.literal("recovery"),
    recovered: z.boolean(),
    openNs: nonNegInt,
    replayNs: nonNegInt,
    seedNs: nonNegInt,
    replayedOperations: nonNegInt,
    snapshotGeneration: nonNegInt,
    generation: nonNegInt,
    snapshotBytes: nonNegInt,
    seq: nonNegInt
  })
  .strict();

const workerRunRecordSchema = z
  .object({
    kind: z.literal("workerRun"),
    requestKind: z.enum(["analyzeIntent", "buildValidateCandidate"]),
    changeSetId: z.string().min(1),
    phase: runPhaseSchema,
    outcome: z.string().min(1),
    bridgeWallNs: nonNegInt,
    snapshotBytes: nonNegInt,
    totalRequestBytes: nonNegInt,
    snapshotBuildNs: nonNegInt,
    requestSerializeNs: nonNegInt,
    responseBytes: nonNegInt,
    worker: workerSelfMetricsSchema.nullable(),
    seq: nonNegInt
  })
  .strict();

/** Non-null only on the publishing advance; carried via `ExecutedEffect`. */
const publicationRecordSchema = z
  .object({
    generation: nonNegInt,
    preCandidateAnalysisNs: nonNegInt,
    postCandidateAnalysisNs: nonNegInt,
    candidateNs: nonNegInt,
    persistenceNs: nonNegInt,
    memoryPublishNs: nonNegInt,
    coreGraphRecordValueBytes: nonNegInt,
    alreadyPublished: z.boolean()
  })
  .strict();

const requestRecordSchema = z
  .object({
    kind: z.literal("request"),
    action: z.string().min(1),
    wallNs: nonNegInt,
    daemonPeakRssBytes: nonNegInt,
    // Monotonic daemon-lifetime count of worker children the node bridge has
    // spawned, as of this request. Spawn-anchored, so it counts a spawned child
    // even if that child produced no terminal `workerRun` record — the basis for
    // the per-leg cross-check in `buildGate2Profile`.
    workerStartsTotal: nonNegInt,
    publication: publicationRecordSchema.nullable(),
    seq: nonNegInt
  })
  .strict();

const metricsRecordSchema = z.discriminatedUnion("kind", [
  recoveryRecordSchema,
  workerRunRecordSchema,
  requestRecordSchema
]);

export type RecoveryRecord = z.infer<typeof recoveryRecordSchema>;
export type WorkerRunRecord = z.infer<typeof workerRunRecordSchema>;
export type RequestRecord = z.infer<typeof requestRecordSchema>;
export type MetricsRecord = z.infer<typeof metricsRecordSchema>;

/**
 * Parse a `--metrics` JSONL file's text into typed, zod-validated records.
 * Blank lines are skipped; any other malformed line (invalid JSON or an
 * unrecognized/mis-shaped record, including an unknown `kind`) throws.
 */
export function parseMetricsJsonl(text: string): MetricsRecord[] {
  const records: MetricsRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    records.push(metricsRecordSchema.parse(JSON.parse(line)));
  }
  return records;
}

// ---------------------------------------------------------------------------
// Gate2Profile — pure aggregation over parsed records.
// ---------------------------------------------------------------------------

export interface RecoveryLeg {
  recovered: boolean;
  openNs: number;
  replayNs: number;
  seedNs: number;
  replayedOperations: number;
  snapshotBytes: number;
}

export interface Gate2Profile {
  seed: { snapshotBytes: number; seedNs: number };
  requests: Array<{ action: string; wallNs: number; daemonPeakRssBytes: number }>;
  workerRuns: Array<{
    requestKind: "analyzeIntent" | "buildValidateCandidate";
    changeSetId: string;
    phase: string;
    outcome: string;
    bridgeWallNs: number;
    snapshotBytes: number;
    totalRequestBytes: number;
    snapshotBuildNs: number;
    requestSerializeNs: number;
    responseBytes: number;
    worker: {
      // Per-stage fields are `number | null` (present-but-null for a stage the
      // run never entered) to mirror the daemon's explicit-`null` JSONL
      // emission; see `workerSelfMetricsSchema`.
      hydrateNs?: number | null;
      analyzeNs?: number | null;
      mutateNs?: number | null;
      validateNs?: number | null;
      exportNs?: number | null;
      totalNs: number;
      peakRssBytes: number;
    } | null;
  }>;
  publication: {
    generation: number;
    preCandidateAnalysisNs: number;
    postCandidateAnalysisNs: number;
    candidateNs: number;
    persistenceNs: number;
    memoryPublishNs: number;
    coreGraphRecordValueBytes: number;
  };
  recovery: { cold: RecoveryLeg; restart: RecoveryLeg };
  totals: { workerStarts: number; daemonPeakRssBytes: number; maxWorkerPeakRssBytes: number };
}

/**
 * The spawn-anchored worker-start count for one daemon leg, cross-checked
 * against that leg's terminal-record count.
 *
 * `workerStartsTotal` is a monotonic daemon-lifetime counter; it resets per
 * daemon process, so each leg (cold, restart) carries its own. We take the
 * leg's FINAL request record's value and require it to equal the number of
 * `workerRun` records in the same leg: a mismatch means a spawned child
 * produced no terminal record (a silently lost run), which is exactly the hole
 * this check closes. A leg with no request record contributes 0 and must then
 * have no worker runs either.
 */
function legWorkerStarts(legRecords: MetricsRecord[], legName: string): number {
  const requestRecords = legRecords.filter(
    (record): record is RequestRecord => record.kind === "request"
  );
  const workerRunCount = legRecords.filter((record) => record.kind === "workerRun").length;
  const finalRequest = requestRecords.at(-1);
  const workerStartsTotal = finalRequest?.workerStartsTotal ?? 0;
  if (workerStartsTotal !== workerRunCount) {
    throw new Error(
      `gate-2 profile: ${legName} leg spawn/terminal mismatch — final request ` +
        `workerStartsTotal=${workerStartsTotal} but ${workerRunCount} workerRun record(s); ` +
        `a spawned worker produced no terminal record`
    );
  }
  return workerStartsTotal;
}

/**
 * Max `daemonPeakRssBytes` across `requestRecords`, 0 if empty. Shared by
 * this module's own profile aggregation (below) and gate 3's metrics-on
 * characterization (`gate3/characterize.ts`) — reused rather than
 * duplicated (both consume the same `RequestRecord` shape this module
 * defines).
 */
export function maxDaemonPeakRssBytes(requestRecords: readonly RequestRecord[]): number {
  return requestRecords.reduce((max, record) => Math.max(max, record.daemonPeakRssBytes), 0);
}

/** Max `worker.peakRssBytes` across `workerRunRecords` (a `null` worker counts as 0), 0 if empty. Shared the same way as `maxDaemonPeakRssBytes`. */
export function maxWorkerPeakRssBytes(workerRunRecords: readonly WorkerRunRecord[]): number {
  return workerRunRecords.reduce((max, record) => Math.max(max, record.worker?.peakRssBytes ?? 0), 0);
}

function toRecoveryLeg(record: RecoveryRecord): RecoveryLeg {
  return {
    recovered: record.recovered,
    openNs: record.openNs,
    replayNs: record.replayNs,
    seedNs: record.seedNs,
    replayedOperations: record.replayedOperations,
    snapshotBytes: record.snapshotBytes
  };
}

/**
 * Pure aggregation: parsed records in, one `Gate2Profile` out. Attribution is
 * strictly by each record's own tagged fields (`changeSetId` + `phase` for
 * worker runs; a record's own `publication` for the publishing advance) —
 * never by position in the array.
 */
export function buildGate2Profile(records: MetricsRecord[]): Gate2Profile {
  const recoveries = records.filter((record): record is RecoveryRecord => record.kind === "recovery");
  const cold = recoveries.find((record) => !record.recovered);
  const restart = recoveries.find((record) => record.recovered);
  if (!cold) {
    throw new Error("gate-2 profile requires one cold (non-recovered) recovery record; found none");
  }
  if (!restart) {
    throw new Error("gate-2 profile requires one restart (recovered) recovery record; found none");
  }

  // Split the concatenated cold+restart stream into its two daemon legs. The
  // restart leg begins at the (single) recovery record with `recovered: true`;
  // records are ordered per-leg and the cold leg's records all precede it. seq
  // resets per daemon, so it is NOT a cross-leg ordering key — the recovery
  // boundary is. This lets each leg's monotonic `workerStartsTotal` be checked
  // against its own worker-run count.
  const restartBoundary = records.findIndex(
    (record) => record.kind === "recovery" && record.recovered
  );
  const coldLegRecords = records.slice(0, restartBoundary);
  const restartLegRecords = records.slice(restartBoundary);
  const coldWorkerStarts = legWorkerStarts(coldLegRecords, "cold");
  const restartWorkerStarts = legWorkerStarts(restartLegRecords, "restart");

  const workerRunRecords = records.filter(
    (record): record is WorkerRunRecord => record.kind === "workerRun"
  );
  const failed = workerRunRecords.find((record) => record.outcome !== "ok");
  if (failed) {
    throw new Error(
      `gate-2 profile found a non-ok worker run: outcome=${failed.outcome} phase=${failed.phase} changeSetId=${failed.changeSetId}`
    );
  }

  const requestRecords = records.filter(
    (record): record is RequestRecord => record.kind === "request"
  );
  const publicationEntries = requestRecords.filter((record) => record.publication !== null);
  if (publicationEntries.length !== 1) {
    throw new Error(
      `gate-2 profile requires exactly one publication; found ${publicationEntries.length}`
    );
  }
  const publicationRecord = publicationEntries[0]!.publication!;

  return {
    seed: { snapshotBytes: cold.snapshotBytes, seedNs: cold.seedNs },
    requests: requestRecords.map((record) => ({
      action: record.action,
      wallNs: record.wallNs,
      daemonPeakRssBytes: record.daemonPeakRssBytes
    })),
    workerRuns: workerRunRecords.map((record) => ({
      requestKind: record.requestKind,
      changeSetId: record.changeSetId,
      phase: record.phase,
      outcome: record.outcome,
      bridgeWallNs: record.bridgeWallNs,
      snapshotBytes: record.snapshotBytes,
      totalRequestBytes: record.totalRequestBytes,
      snapshotBuildNs: record.snapshotBuildNs,
      requestSerializeNs: record.requestSerializeNs,
      responseBytes: record.responseBytes,
      worker: record.worker
    })),
    publication: {
      generation: publicationRecord.generation,
      preCandidateAnalysisNs: publicationRecord.preCandidateAnalysisNs,
      postCandidateAnalysisNs: publicationRecord.postCandidateAnalysisNs,
      candidateNs: publicationRecord.candidateNs,
      persistenceNs: publicationRecord.persistenceNs,
      memoryPublishNs: publicationRecord.memoryPublishNs,
      coreGraphRecordValueBytes: publicationRecord.coreGraphRecordValueBytes
    },
    recovery: { cold: toRecoveryLeg(cold), restart: toRecoveryLeg(restart) },
    totals: {
      // Sum of each leg's final spawn-anchored counter, each cross-checked
      // against that leg's worker-run count above. This is the real
      // spawn-counter total, not the drain-derived record count — a spawn that
      // produced no terminal record would have thrown in `legWorkerStarts`.
      workerStarts: coldWorkerStarts + restartWorkerStarts,
      daemonPeakRssBytes: maxDaemonPeakRssBytes(requestRecords),
      maxWorkerPeakRssBytes: maxWorkerPeakRssBytes(workerRunRecords)
    }
  };
}

// ---------------------------------------------------------------------------
// Kernel-arm T03 flow, twice (cold + restart), with metrics enabled.
// ---------------------------------------------------------------------------

/**
 * Poll `advance_change_set` until the change set reaches `published`
 * (uncontested single-change-set T03 has no concurrent claims to wait out, so
 * this ordinarily resolves on the first call — the loop is defensive, not
 * load-bearing).
 */
async function advanceUntilPublished(
  client: CoordinationClient,
  changeSetId: string
): Promise<string> {
  for (let attempt = 0; attempt < MAX_ADVANCE_ATTEMPTS; attempt += 1) {
    const advanced = expectResult(
      await client.advanceChangeSet(changeSetId, ADVANCE_DEADLINE_MS),
      "change_set"
    );
    if (advanced.state === "published" && advanced.operationId !== null) {
      return advanced.operationId;
    }
  }
  throw new Error(
    `gate-2 flow: change set ${changeSetId} did not reach 'published' within ${MAX_ADVANCE_ATTEMPTS} advance attempts`
  );
}

/** Cold leg: fresh seed, full T03 rename lifecycle, clean stop preserving the redb. */
async function runColdLeg(corpusRoot: string, directory: string, metricsPath: string): Promise<void> {
  const service = await startKernelService(corpusRoot, {
    binaryPath: kernelServiceBinary(),
    env: credentialFreeEnv(),
    directory,
    extraArgs: ["--metrics", metricsPath]
  });
  const client = new CoordinationClient({
    socketPath: service.socketPath,
    clientId: `gate2-kernel-flow-cold:${randomUUID()}`
  });
  try {
    await client.hello(DISCOVERY_DEADLINE_MS);

    const discovery = expectResult(
      await client.findDeclarations(OLD_NAME, "interface", DISCOVERY_DEADLINE_MS),
      "declarations"
    );
    if (discovery.declarations.length !== 1) {
      throw new Error(
        `gate-2 flow expected exactly one interface named ${OLD_NAME}; got ${discovery.declarations.length}`
      );
    }
    const declarationId = discovery.declarations[0]!.nodeId;

    const begun = expectResult(
      await client.beginChangeSet(TASK_PROMPT, SUBMIT_DEADLINE_MS),
      "change_set"
    );
    const changeSetId = begun.changeSetId;

    await client.addIntent(
      changeSetId,
      { type: "rename_symbol", declarationId, newName: NEW_NAME },
      SUBMIT_DEADLINE_MS
    );

    expectResult(await client.submitChangeSet(changeSetId, SUBMIT_DEADLINE_MS), "change_set");

    const operationId = await advanceUntilPublished(client, changeSetId);

    expectResult(await client.readOperation(operationId, DISCOVERY_DEADLINE_MS), "operation");
  } finally {
    await service.stop({ preserveDirectory: true });
  }
}

/** Restart leg: reopen the same durable store (recovery/replay branch), then stop. */
async function runRestartLeg(corpusRoot: string, directory: string, metricsPath: string): Promise<void> {
  const service = await startKernelService(corpusRoot, {
    binaryPath: kernelServiceBinary(),
    env: credentialFreeEnv(),
    directory,
    extraArgs: ["--metrics", metricsPath]
  });
  const client = new CoordinationClient({
    socketPath: service.socketPath,
    clientId: `gate2-kernel-flow-restart:${randomUUID()}`
  });
  try {
    await client.hello(DISCOVERY_DEADLINE_MS);
  } finally {
    await service.stop({ preserveDirectory: true });
  }
}

/**
 * Drive the kernel-arm T03 flow twice — a fresh-seed cold start through
 * publish, then a restart on the same durable store — with the daemon's
 * `--metrics` sink enabled on both legs, and aggregate the concatenated
 * cold+restart JSONL into one profile.
 */
export async function runGate2KernelFlow(
  corpusRoot: string
): Promise<{ records: MetricsRecord[]; profile: Gate2Profile }> {
  const resolved = resolve(corpusRoot);
  const directory = mkdtempSync(join(tmpdir(), "strata-gate2-service-"));
  const coldPath = join(directory, "metrics-cold.jsonl");
  const restartPath = join(directory, "metrics-restart.jsonl");
  try {
    await runColdLeg(resolved, directory, coldPath);
    await runRestartLeg(resolved, directory, restartPath);

    const text = `${readFileSync(coldPath, "utf8")}${readFileSync(restartPath, "utf8")}`;
    const records = parseMetricsJsonl(text);
    const profile = buildGate2Profile(records);
    return { records, profile };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Artifacts.
// ---------------------------------------------------------------------------

function formatNs(value: number): string {
  return `${value.toLocaleString("en-US")} ns`;
}

function formatBytes(value: number): string {
  return `${value.toLocaleString("en-US")} B`;
}

/**
 * One row per gate-2 review category (per-stage wall time, peak memory,
 * serialized snapshot bytes, worker starts, hydration time, validation time,
 * redb publication time, restart replay time), with the source JSONL record
 * kind each measurement came from. `coreGraphRecordValueBytes` is footnoted:
 * it is the four graph-record (operation+delta+ticket+event) value bytes
 * only, never total transaction or physical redb bytes.
 */
function renderMarkdown(profile: Gate2Profile): string {
  const submit = profile.requests.find((request) => request.action === "submit_change_set");
  const advances = profile.requests.filter((request) => request.action === "advance_change_set");
  const candidate = profile.workerRuns.find((run) => run.phase === "candidate");
  const analysis = profile.workerRuns.find((run) => run.phase === "submitAnalysis");

  const rows: Array<[string, string, string]> = [
    [
      "Per-stage wall time (submit)",
      submit ? formatNs(submit.wallNs) : "n/a",
      "`request` (action=submit_change_set)"
    ],
    [
      "Per-stage wall time (advance, max)",
      advances.length > 0
        ? formatNs(Math.max(...advances.map((request) => request.wallNs)))
        : "n/a",
      "`request` (action=advance_change_set)"
    ],
    [
      "Peak memory — daemon",
      formatBytes(profile.totals.daemonPeakRssBytes),
      "`request` (daemonPeakRssBytes, max across requests)"
    ],
    [
      "Peak memory — worker (max)",
      formatBytes(profile.totals.maxWorkerPeakRssBytes),
      "`workerRun` (worker.peakRssBytes, max across runs)"
    ],
    ["Serialized snapshot bytes — seed", formatBytes(profile.seed.snapshotBytes), "`recovery` (cold)"],
    [
      "Serialized snapshot bytes — worker request (analysis run)",
      analysis ? formatBytes(analysis.snapshotBytes) : "n/a",
      "`workerRun`"
    ],
    [
      "Serialized snapshot bytes — restart recovery",
      formatBytes(profile.recovery.restart.snapshotBytes),
      "`recovery` (restart)"
    ],
    ["Node-worker starts", String(profile.totals.workerStarts), "`workerRun` (record count)"],
    [
      "SQLite hydration time (inside the worker, max)",
      profile.workerRuns.length > 0
        ? formatNs(Math.max(...profile.workerRuns.map((run) => run.worker?.hydrateNs ?? 0)))
        : "n/a",
      "`workerRun` (worker.hydrateNs)"
    ],
    [
      "Validation time (candidate tsc gate)",
      candidate?.worker?.validateNs != null ? formatNs(candidate.worker.validateNs) : "n/a",
      "`workerRun` (phase=candidate, worker.validateNs)"
    ],
    [
      "redb publication time (persistence)",
      formatNs(profile.publication.persistenceNs),
      "`request` (publication.persistenceNs)"
    ],
    [
      "redb publication — core graph record value bytes*",
      formatBytes(profile.publication.coreGraphRecordValueBytes),
      "`request` (publication.coreGraphRecordValueBytes)"
    ],
    [
      "Restart replay time",
      formatNs(profile.recovery.restart.replayNs),
      "`recovery` (restart)"
    ]
  ];

  const header = "| Category | Measured value | Source record |\n| --- | --- | --- |";
  const body = rows.map(([category, value, source]) => `| ${category} | ${value} | ${source} |`).join("\n");

  return [
    "# Gate 2 — per-stage observability profile (kernel arm, T03, key-free)",
    "",
    header,
    body,
    "",
    "\\* `coreGraphRecordValueBytes` is the encoded value bytes of exactly the four",
    "core graph records (operation + delta + ticket + event) written by the",
    "publishing advance. It is NOT total transaction bytes and NOT physical redb",
    "bytes on disk — see decisions.md / the gate-2 plan for the full-transaction",
    "byte-accounting residual."
  ].join("\n");
}

/**
 * Write the JSON (full profile + raw records) and Markdown (review-category
 * table) artifacts. Default names are timestamped for local gitignored
 * reruns (`packages/live-compare/results/`); `deterministicName: true` yields
 * the fixed name a later task commits under `docs/spikes/`.
 */
export function writeGate2Artifacts(
  profile: Gate2Profile,
  records: MetricsRecord[],
  outDir: string,
  options?: { deterministicName?: boolean }
): { jsonPath: string; markdownPath: string } {
  mkdirSync(outDir, { recursive: true });
  const base = options?.deterministicName
    ? "gate2-observability-profile"
    : `gate2-profile-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const jsonPath = join(outDir, `${base}.json`);
  const markdownPath = join(outDir, `${base}.md`);
  writeFileSync(jsonPath, `${JSON.stringify({ profile, records }, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, `${renderMarkdown(profile)}\n`, "utf8");
  return { jsonPath, markdownPath };
}
