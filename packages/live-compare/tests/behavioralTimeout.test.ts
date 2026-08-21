// Timeout / savepoint recovery gate — KERNEL path (item-B2 Task 9, spec B-2
// gate d). ACCEPTANCE gate (not failing-first TDD) against Tasks 1-7's
// already-landed behavior: release-and-requeue (Task 4), process-group-bounded
// vitest with kill-before-resolve (Task 6), and the seed-green startup gate
// (Task 7). Reuses behavioralGate.test.ts's (Task 8) corpus-copy / manifest /
// client-wrapper patterns verbatim; only the fixture, timeouts, and daemon
// flags differ.
//
// THE LEVER (task-9-brief.md, review-validated): a namespace-import fixture
// that sleeps (FIXTURE_SLEEP_MS below) only when its target export is missing:
//
//   import * as mod from "../../src/users/greet.ts";
//   if (!("greet" in mod)) { writeFileSync(pidfile, pid); await sleep(FIXTURE_SLEEP_MS); }
//
// Generation zero: `greet` exists -> no sleep -> seed-green (which reuses the
// SAME manifest timeouts) passes fast. After renaming `greet` -> `welcomeUser`,
// the namespace import still loads (no compile error under
// strictSrcOnlyTscScope) but `"greet" in mod` goes false -> the fixture writes
// its pid then sleeps -> `vitestTimeoutMs` (see VITEST_TIMEOUT_MS below) times
// out deterministically, well inside the sleep window.
//
// DISCOVERED DISCREPANCY #1 (see task-9-report.md "worker_starts_total"
// section): the brief assumed the daemon-wide `worker_starts_total` wire
// counter sits at exactly 1 for the whole scenario (the persistent bridge's
// eager hydration). In fact `ServiceSession::worker_starts_total()` (crates/
// strata-kernel/src/kernel.rs) sums the persistent router's spawns AND the
// one-shot client's spawns, and Task 7's seed-green baseline
// (`validate_baseline()`) is documented as "deliberately one-shot and
// mirror-free" — it spawns its own throwaway one-shot worker BEFORE the
// persistent bridge is eagerly hydrated. So by the time the daemon is ready
// and this test issues its first request, the observed baseline is the
// one-shot seed-green spawn PLUS the persistent eager-hydration spawn, not
// literally 1 (empirically 2 — see the metrics sink's first "request" record).
// The discriminating claim survives intact: this test asserts the value is
// IDENTICAL across every metrics "request" record for the rest of the
// scenario (delta zero from the first client-observable request onward) — no
// respawn, no per-attempt one-shot fallback across two operational timeouts,
// a cancel, and a clean publish — and separately reports the concrete
// observed baseline.
//
// DISCOVERED DISCREPANCY #2: the metrics sink's internally-tagged `kind`
// field is `#[serde(rename_all = "camelCase")]`-derived from the Rust enum
// variant names (`Recovery`, `WorkerRun`, `Request`), which camelCase to
// "recovery", "workerRun", and "request" on the wire — NOT PascalCase. This
// gate filters on those literal lowercase-leading values.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CoordinationClient, CoordinationClientError } from "../src/client.js";
import { startKernelService, type RunningKernelService } from "../src/service.js";
import { advanceUntilTerminal, credentialFreeEnv, ensureBuilt } from "./serviceHarness.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const corpusSourceRoot = resolve(repoRoot, "examples/medium");

const FIXTURE_REL_PATH = "tests/behavioral/timeout-contract.test.ts";
// `.ts`-extension namespace import: Task 8 discovered `allowImportingTsExtensions`
// in examples/medium's tsconfig requires the literal `.ts` suffix on relative
// specifiers. `import * as mod` (rather than a named `import { greet }`) is
// load-bearing: a named import of a renamed export would be a COMPILE error
// under a non-strict tsc scope, which is not the outcome under test here —
// the namespace form always loads; only the runtime `"greet" in mod` check
// observes the rename.
const FIXTURE_BODY =
  'import { writeFileSync } from "node:fs";\n' +
  'import { describe, expect, it } from "vitest";\n' +
  'import * as mod from "../../src/users/greet.ts";\n' +
  "\n" +
  'describe("greet timeout contract", () => {\n' +
  '  it("contract", async () => {\n' +
  '    if (!("greet" in mod)) {\n' +
  "      writeFileSync(\n" +
  '        process.env.STRATA_TEST_PID_FILE ?? "/dev/null",\n' +
  "        String(process.pid)\n" +
  "      );\n" +
  "      await new Promise((resolveSleep) => setTimeout(resolveSleep, 10_000));\n" +
  "    }\n" +
  "    expect(true).toBe(true);\n" +
  "  });\n" +
  "});\n";

/**
 * Deterministic budget: the fixture sleeps 10s when triggered. The brief's
 * proposed 2_000ms proved too tight empirically — a cold vitest process
 * (config load, esbuild transform, thread-pool spin-up) for this single
 * trivial fixture measured 0.5s-2.4s on this machine on its own, with no
 * sleep at all, and flaked seed-green in a live run (see task-9-report.md).
 * 7_000ms keeps ~3x headroom over the observed cold-start ceiling while still
 * leaving 3s of clearance below the 10s sleep, so the EXTERNAL
 * (process-group-kill) timeout fires well before the sleep would ever
 * complete on its own.
 *
 * DISCOVERED DISCREPANCY #3: vitest's own internal default `testTimeout` is
 * 5_000ms — a SEPARATE, in-process watchdog that fails an individual test
 * (a SEMANTIC `validation_failed`/behavioralFailed verdict, vitest exiting
 * normally with a failing status) well before an external
 * `vitestTimeoutMs` budget above 5_000ms ever gets a chance to fire. At
 * 7_000ms this raced and lost to vitest's own 5s watchdog in a live run (see
 * task-9-report.md), turning the intended OPERATIONAL timeout into a semantic
 * rejection. `TEST_CORPUS_VITEST_INTERNAL_TIMEOUT_MS` below raises vitest's
 * own per-test timeout in the corpus's `vitest.config.ts` well past both the
 * external budget and the sleep, so the EXTERNAL kill is the only clock that
 * can fire.
 */
const VITEST_TIMEOUT_MS = 7_000;
const TEST_CORPUS_VITEST_INTERNAL_TIMEOUT_MS = 60_000;

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function buildTimeoutCorpus(): { corpusRoot: string; manifestPath: string } {
  const corpusRoot = mkdtempSync(join(tmpdir(), "strata-bgate-timeout-"));
  cleanups.push(() => rmSync(corpusRoot, { recursive: true, force: true }));
  cpSync(corpusSourceRoot, corpusRoot, {
    recursive: true,
    filter: (source) => basename(source) !== "node_modules"
  });
  mkdirSync(join(corpusRoot, "tests", "behavioral"), { recursive: true });
  writeFileSync(join(corpusRoot, FIXTURE_REL_PATH), FIXTURE_BODY, "utf8");
  // Override the corpus's vitest.config.ts (materializeAcceptanceTree copies
  // it verbatim into the acceptance scratch tree) so vitest's own internal
  // per-test timeout cannot preempt the EXTERNAL boundedProcessRun kill this
  // gate depends on — see DISCOVERED DISCREPANCY #3 above.
  writeFileSync(
    join(corpusRoot, "vitest.config.ts"),
    'import { defineConfig } from "vitest/config";\n' +
      "\n" +
      "export default defineConfig({\n" +
      "  test: {\n" +
      '    include: ["tests/**/*.test.ts"],\n' +
      `    testTimeout: ${TEST_CORPUS_VITEST_INTERNAL_TIMEOUT_MS}\n` +
      "  }\n" +
      "});\n",
    "utf8"
  );
  const sha256 = createHash("sha256")
    .update(readFileSync(join(corpusRoot, FIXTURE_REL_PATH)))
    .digest("hex");
  const manifestPath = join(corpusRoot, "validation-manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "behavioral",
      strictSrcOnlyTscScope: true,
      tscTimeoutMs: 60_000,
      vitestTimeoutMs: VITEST_TIMEOUT_MS,
      fixtures: [{ path: FIXTURE_REL_PATH, sha256 }]
    }),
    "utf8"
  );
  return { corpusRoot, manifestPath };
}

async function startTimeoutGatedService(
  pidFilePath: string,
  metricsPath: string
): Promise<{ service: RunningKernelService; client: CoordinationClient }> {
  ensureBuilt();
  const { corpusRoot, manifestPath } = buildTimeoutCorpus();
  const service = await startKernelService(corpusRoot, {
    env: { ...credentialFreeEnv(), STRATA_TEST_PID_FILE: pidFilePath },
    validationManifestPath: manifestPath,
    // --persistent-bridge: one eagerly-hydrated worker for the whole session
    // (Task 6). --metrics: the JSONL observability sink this gate parses for
    // assertion 4/6's same-worker-health proof.
    extraArgs: ["--persistent-bridge", "--metrics", metricsPath]
  });
  cleanups.push(() => service.stop());
  const client = new CoordinationClient({ socketPath: service.socketPath, clientId: "bgate:timeout" });
  return { service, client };
}

function readMetrics(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function readAuditEvents(path: string): any[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line).event);
}

/** Bounded wait for `process.kill(pid, 0)` to report ESRCH (assertion 5). */
async function waitForProcessDeath(pid: number, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`process ${pid} did not die within ${timeoutMs}ms`);
    }
    await new Promise((wake) => setTimeout(wake, 25));
  }
}

/**
 * Drives `advance_change_set` until either it throws the operational
 * CoordinationClientError (returned) or the change set reaches an unexpected
 * terminal state (thrown, so a wrong assumption fails loudly rather than
 * silently passing). Non-terminal, non-throwing responses (e.g. a
 * `ready`/`claimed` readiness step before the candidate actually executes)
 * are advanced again, bounded exactly like serviceHarness's advanceUntilTerminal.
 */
async function advanceUntilOperationalFailure(
  client: CoordinationClient,
  changeSetId: string
): Promise<CoordinationClientError> {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const result = (await client.advanceChangeSet(changeSetId)) as any;
      if (["published", "validation_failed", "needs_decision", "failed", "cancelled"].includes(result.state)) {
        throw new Error(
          `expected an operational candidate_execution_failed error but the change set ` +
            `reached terminal state ${result.state}: ${JSON.stringify(result)}`
        );
      }
      // Non-terminal (e.g. "ready"/"claimed"/"queued") — advance again.
    } catch (error) {
      if (error instanceof CoordinationClientError) return error;
      throw error;
    }
  }
  throw new Error(`change set ${changeSetId} never hit the operational failure within 8 advances`);
}

describe("behavioral timeout / savepoint recovery gate — kernel path (spec B-2 gate d)", () => {
  it(
    "requeues an operational vitest timeout, re-drives it on a fresh advance, and stays healthy for a clean publish",
    async () => {
      const scratchDir = mkdtempSync(join(tmpdir(), "strata-timeout-scratch-"));
      cleanups.push(() => rmSync(scratchDir, { recursive: true, force: true }));
      const pidFilePath = join(scratchDir, "sleepy-vitest.pid");
      const metricsPath = join(scratchDir, "metrics.jsonl");

      const { service, client } = await startTimeoutGatedService(pidFilePath, metricsPath);
      // Reaching this line already proves the conditional-sleep lever: a
      // fixture that always slept would have blown the (also VITEST_TIMEOUT_MS)
      // seed-green vitest budget and the daemon would never have bound its
      // socket at all (startKernelService would have rejected on a non-JSON
      // readiness line / process exit).

      const before = (await client.findDeclarations("greet", { kind: "function" })) as any;
      expect(before.type).toBe("declarations");
      expect(before.declarations.length).toBe(1);
      const declarationId: string = before.declarations[0].nodeId;
      const baselineGeneration: string = before.graphGeneration;

      // Baseline worker_starts_total: captured off the FIRST client-observable
      // metrics Request record (this find_declarations read). See the file
      // header's "DISCOVERED DISCREPANCY" note — this is the one-shot
      // seed-green spawn plus the persistent eager-hydration spawn, not
      // literally 1.
      const metricsAfterFirstRead = readMetrics(metricsPath).filter((record) => record.kind === "request");
      expect(metricsAfterFirstRead.length).toBeGreaterThan(0);
      const baselineWorkerStarts = metricsAfterFirstRead[0].workerStartsTotal;
      expect(Number.isInteger(baselineWorkerStarts)).toBe(true);

      // ---- Attempt 1: the sleepy rename ----
      const begun = (await client.beginChangeSet("timeout gate: rename greet -> welcomeUser")) as any;
      await client.addIntent(begun.changeSetId, {
        type: "rename_symbol",
        declarationId,
        newName: "welcomeUser"
      });
      await client.submitChangeSet(begun.changeSetId);

      const metricsBeforeAttempt1 = readMetrics(metricsPath).length;
      const firstError = await advanceUntilOperationalFailure(client, begun.changeSetId);

      // Assertion 1: ok:false (thrown), candidate_execution_failed, retryable true.
      expect(firstError.code).toBe("candidate_execution_failed");
      expect(firstError.retryable).toBe(true);

      // Assertion 2: generation unchanged (wire-derived, before/after).
      const afterAttempt1 = (await client.findDeclarations("greet", { kind: "function" })) as any;
      expect(afterAttempt1.graphGeneration).toBe(baselineGeneration);
      expect(afterAttempt1.declarations.length).toBe(1);
      expect(afterAttempt1.declarations[0].nodeId).toBe(declarationId);

      // Assertion 5: group-kill proof. boundedProcessRun's ordering contract
      // (packages/verify/src/boundedRun.ts) guarantees the process group is
      // already gone by the time the timeout error resolves, so this should
      // already be true; the bounded wait is a tolerance, not a race we rely on.
      const firstPid = Number(readFileSync(pidFilePath, "utf8"));
      expect(Number.isInteger(firstPid)).toBe(true);
      await waitForProcessDeath(firstPid);

      // Observed post-requeue state string (informational; see task-9-report.md).
      const auditAfterAttempt1 = readAuditEvents(service.auditPath).filter(
        (event) => event.kind === "candidate_execution_failed"
      );
      expect(auditAfterAttempt1.length).toBeGreaterThan(0);
      const observedRequeueState = auditAfterAttempt1.at(-1).state;
      expect(["ready", "queued"]).toContain(observedRequeueState);

      // ---- Assertion 3: REQUEUE + RE-DRIVE ----
      // A SECOND advance of the SAME change set. client.advanceChangeSet ->
      // client.request() defaults `idempotencyKey` to a FRESH randomUUID()
      // per top-level call (packages/live-compare/src/client.ts) whenever the
      // caller does not pass one explicitly, which is the case here — so this
      // is guaranteed not to replay attempt 1's journaled response (Task 4's
      // review Blocker: a reused key would just return the cached error).
      const secondError = await advanceUntilOperationalFailure(client, begun.changeSetId);
      expect(secondError.code).toBe("candidate_execution_failed");
      expect(secondError.retryable).toBe(true);

      // Proof the re-drive actually RE-EXECUTED (not a replayed response):
      // fresh metrics records for changeSetId appended strictly after attempt
      // 1's records. A cached/replayed response never reaches emit_request_metrics
      // (session.rs's replay branches return before the journal-completed +
      // metrics-emission boundary), so this could only be produced by a real
      // second worker round trip.
      const metricsAfterAttempt2 = readMetrics(metricsPath);
      expect(metricsAfterAttempt2.length).toBeGreaterThan(metricsBeforeAttempt1);
      const freshRecords = metricsAfterAttempt2.slice(metricsBeforeAttempt1);
      const freshWorkerRunForThisChangeSet = freshRecords.filter(
        (record) => record.kind === "workerRun" && record.changeSetId === begun.changeSetId
      );
      // Two attempts, each a real candidate build+validate round trip against
      // the mirror -> two WorkerRun records attributable to this change set.
      expect(freshWorkerRunForThisChangeSet.length).toBeGreaterThanOrEqual(2);

      // A different pid in the pidfile is further (non-required) proof of a
      // genuinely new vitest process for the second attempt.
      const secondPid = Number(readFileSync(pidFilePath, "utf8"));
      expect(secondPid).not.toBe(firstPid);
      await waitForProcessDeath(secondPid);

      // cancel_change_set succeeds.
      const cancelled = (await client.cancelChangeSet(begun.changeSetId)) as any;
      expect(cancelled.changeSetId).toBe(begun.changeSetId);

      // A DIFFERENT clean rename (Task 8's pattern: User -> Account) publishes
      // on the SAME daemon.
      const beforeAccount = (await client.findDeclarations("User", { kind: "interface" })) as any;
      expect(beforeAccount.declarations.length).toBe(1);
      const accountDeclarationId: string = beforeAccount.declarations[0].nodeId;

      const cleanBegun = (await client.beginChangeSet("timeout gate: rename User -> Account")) as any;
      await client.addIntent(cleanBegun.changeSetId, {
        type: "rename_symbol",
        declarationId: accountDeclarationId,
        newName: "Account"
      });
      await client.submitChangeSet(cleanBegun.changeSetId);
      const cleanTerminal = await advanceUntilTerminal(client, cleanBegun.changeSetId);

      // Assertion 6: savepoint/fingerprint. The clean publish succeeding on
      // the SAME daemon after two aborted candidates + a cancellation proves
      // the savepoint rolled back cleanly both times and the mirror
      // fingerprint stayed healthy (a poisoned mirror refuses ALL further
      // work per buildValidateCandidateOnMirror's contract).
      expect(cleanTerminal.result.state).toBe("published");
      expect(cleanTerminal.result.diagnostics).toEqual([]);
      expect(cleanTerminal.result.publicationDigest).toMatch(/^[0-9a-f]{64}$/);

      // Assertion 4: same-worker health. Every metrics Request record for the
      // WHOLE scenario (both timeouts, the cancel, and the clean publish)
      // reports the identical worker_starts_total observed at the very first
      // request — i.e. zero delta from that baseline. A respawn (mirror
      // poisoned -> host kills+respawns+rehydrates) or a per-attempt one-shot
      // fallback (persistent router NotRouted) would each show up here as an
      // increment; neither happened.
      const allRequestRecords = readMetrics(metricsPath).filter((record) => record.kind === "request");
      expect(allRequestRecords.length).toBeGreaterThan(metricsAfterFirstRead.length);
      for (const record of allRequestRecords) {
        expect(record.workerStartsTotal).toBe(baselineWorkerStarts);
      }

      // Assertion 4b (B-2 Task 10): the same health claim, stated positively by
      // the cost-disclosure counters rather than inferred from a spawn count.
      // Only behavioral advances disclose, so the advances are the records that
      // carry these keys at all.
      const advanceRecords = allRequestRecords.filter(
        (record) => record.action === "advance_change_set"
      );
      expect(advanceRecords.length).toBeGreaterThanOrEqual(3);
      for (const record of advanceRecords) {
        // Nothing fell back and nothing re-hydrated: the two failure modes
        // assertion 4 rules out are each named here, as zero rather than as an
        // absent increment.
        expect(record.oneShotFallbacksTotal).toBe(0);
        expect(record.rehydrationsTotal).toBe(0);
        expect(typeof record.validationTimeoutsTotal).toBe("number");
      }
      // The counter is monotonic across the scenario and ends having counted
      // BOTH killed validations — the discriminating half: a gate that killed
      // one subprocess and reported the other some other way would fail here.
      const timeoutCounts = advanceRecords.map((record) => record.validationTimeoutsTotal);
      for (let index = 1; index < timeoutCounts.length; index += 1) {
        expect(timeoutCounts[index]).toBeGreaterThanOrEqual(timeoutCounts[index - 1]!);
      }
      expect(timeoutCounts.at(-1)! - timeoutCounts[0]! + 1).toBeGreaterThanOrEqual(2);
      // The clean publish disclosed a real validation wall; a disclosure that
      // silently omitted the measurement would leave this undefined.
      const publishRecord = advanceRecords.at(-1)!;
      expect(typeof publishRecord.validationWallMs).toBe("number");
      expect(publishRecord.validationWallMs).toBeGreaterThan(0);
      expect(typeof publishRecord.queueWaitMs).toBe("number");
    },
    240_000
  );
});
