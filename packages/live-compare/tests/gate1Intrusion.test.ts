// Gate 1, Task 8: second-client intrusion with stage-specific FIFO oracles.
//
// A single Rust coordination daemon is driven by TWO distinct
// CoordinationClients (A = the User->Account T03 flow; B = an intruding actor
// with its own clientId). Each case asserts the DETERMINISTIC FIFO contract —
// never an "either-order" acceptance. No model calls, no API keys, no persisted
// SQLite (the kernel arm never opens SQLite at all).
//
// Oracle note (corrected 2026-07-18 after the probe falsified the review's
// pre-submit mechanism claim; see decisions.md top entry and design D8): the
// kernel pins scope at SUBMIT (coordinator.rs:225-264), so a change set
// submitted AFTER a conflicting commit re-analyzes fresh and publishes directly
// rather than taking a needs_decision round-trip. At the pre-submit stages A
// therefore publishes deterministically as a SECOND sequential operation on the
// SAME stable declaration — B User->Client @gen N, A Client->Account @gen N+1 —
// which is a strong no-silent-overwrite oracle, not a weakened one. needs_decision
// is engaged only for a change set submitted BEFORE the conflicting commit
// (the after_submit and concurrent cases).
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { evaluateT03TextCriteria } from "@strata-code/verify";
import { CoordinationClient, CoordinationClientError, type CoordinationResult } from "../src/client.js";
import {
  TASK_PROMPT,
  exportKernelSnapshot,
  renderSnapshotToTree,
  runKernelArmT03,
  tscAndVitestGreen
} from "../src/gate1.js";
import { startKernelService, type RunningKernelService } from "../src/service.js";
import { credentialFreeEnv, ensureBuilt } from "./serviceHarness.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const corpus = resolve(repoRoot, "examples/medium");

const OLD_NAME = "User"; // the T03 interface declaration, src/types/user.ts
const MIDDLE_NAME = "Client"; // B's intruding rename target
const FINAL_NAME = "Account"; // A's rename target
// Pre-registered disjoint target: a named function declaration living in a
// DIFFERENT module than `User` (grep-confirmed: src/lib/format.ts). Recorded as
// a constant per the brief; never discovered dynamically for the choice itself.
const DISJOINT_OLD = "formatTimestamp";
const DISJOINT_NEW = "formatTimestampAudit";

const SUBMIT_MS = 120_000; // >= 30.1 s budget for submit_change_set
const ADVANCE_MS = 180_000; // >= 60.1 s budget for advance_change_set
const READ_MS = 120_000;

const PRE_SUBMIT_STAGES = ["after_discovery", "after_begin", "after_add_intent"] as const;
const ALL_STAGES = ["after_discovery", "after_begin", "after_add_intent", "after_submit"] as const;

const TERMINAL = ["published", "needs_decision", "validation_failed", "failed", "cancelled"];

const cleanup: string[] = [];
afterAll(() => cleanup.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

// --- Result narrowing ------------------------------------------------------

function expectType<T extends CoordinationResult["type"]>(
  result: CoordinationResult,
  type: T
): Extract<CoordinationResult, { type: T }> {
  if (result.type !== type) throw new Error(`expected ${type} coordination result; got ${result.type}`);
  return result as Extract<CoordinationResult, { type: T }>;
}
const asChangeSet = (r: CoordinationResult) => expectType(r, "change_set");
const asOperation = (r: CoordinationResult) => expectType(r, "operation");
const asDeclarations = (r: CoordinationResult) => expectType(r, "declarations");

// --- Kernel choreography helpers ------------------------------------------

/**
 * A single-shot stop guard. `service.stop` awaits `child.once("exit")`
 * unconditionally, so a second call after the child already exited would hang
 * forever; this ensures the daemon is stopped exactly once whether the body
 * stopped it (to preserve the redb for export) or the finally has to.
 */
function makeStop(service: RunningKernelService): (opts?: { preserveDirectory?: boolean }) => Promise<void> {
  let stopped = false;
  return async (opts) => {
    if (stopped) return;
    stopped = true;
    await service.stop(opts);
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `advance_change_set` to a terminal state. `advance` returns immediately
 * with a non-terminal state (e.g. `queued`) while a ticket is held behind an
 * older overlapping ticket, so we poll on a wall-clock budget rather than a
 * fixed count: under concurrent advances the loser may stay queued until the
 * winner's daemon-side tsc validation publishes, which takes several seconds.
 */
async function advanceUntilTerminal(
  client: CoordinationClient,
  changeSetId: string
): Promise<Extract<CoordinationResult, { type: "change_set" }>> {
  const deadline = Date.now() + 120_000;
  let result: Extract<CoordinationResult, { type: "change_set" }> | undefined;
  while (Date.now() < deadline) {
    result = asChangeSet(await client.advanceChangeSet(changeSetId, ADVANCE_MS));
    if (TERMINAL.includes(result.state)) return result;
    await sleep(250);
  }
  throw new Error(`change set ${changeSetId} did not terminate: ${JSON.stringify(result)}`);
}

/** B renames the given stable declaration and drives to a published commit. */
async function commitIntruder(
  socketPath: string,
  declarationId: string,
  newName: string,
  reasoning: string
): Promise<{ changeSetId: string; operationId: string; generation: string; submitState: string }> {
  const b = new CoordinationClient({ socketPath, clientId: `intrusion-B:${randomUUID()}` });
  const begun = asChangeSet(await b.beginChangeSet(reasoning, SUBMIT_MS));
  await b.addIntent(begun.changeSetId, { type: "rename_symbol", declarationId, newName }, SUBMIT_MS);
  const submit = asChangeSet(await b.submitChangeSet(begun.changeSetId, SUBMIT_MS));
  const terminal = await advanceUntilTerminal(b, begun.changeSetId);
  if (terminal.state !== "published" || terminal.operationId === null) {
    throw new Error(`intruder commit did not publish: ${JSON.stringify(terminal)}`);
  }
  return {
    changeSetId: begun.changeSetId,
    operationId: terminal.operationId,
    generation: terminal.graphGeneration,
    submitState: submit.state
  };
}

/** The RenameSymbol intent's stable declarationId, as recorded in the operation. */
function operationDeclarationId(operation: Extract<CoordinationResult, { type: "operation" }>): string {
  const intent = operation.intents.find((entry) => entry.kind === "RenameSymbol");
  if (!intent) throw new Error(`operation carried no RenameSymbol intent: ${operation.operationId}`);
  return (JSON.parse(intent.parametersJson) as { declarationId: string }).declarationId;
}

function hasRename(
  operation: Extract<CoordinationResult, { type: "operation" }>,
  fromName: string,
  toName: string
): boolean {
  return operation.renames.some((rename) => rename.fromName === fromName && rename.toName === toName);
}

// --- Rendered-tree oracle --------------------------------------------------

const ALL_TRUE = {
  importRenamed: true,
  typeAnnotationRenamed: true,
  genericPromiseRenamed: true,
  namespaceImportRenamed: true,
  auditLiteralUntouched: true,
  auditLiteralOnlyRemainingUser: true,
  indexReExportRenamed: true,
  jsdocReferencesRenamed: true
};

function readModuleMap(treeRoot: string): Map<string, string> {
  const src = join(treeRoot, "src");
  const modules = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) modules.set(relative(src, abs).split("\\").join("/"), readFileSync(abs, "utf8"));
    }
  };
  walk(src);
  return modules;
}

/**
 * Stop the daemon preserving its redb, run the offline export oracle, render the
 * canonical snapshot to a scratch tree, and check tsc+vitest green and the T03
 * text criteria. Returns the stdout publication digest for the digest cross-check.
 */
async function exportRenderVerify(
  directory: string
): Promise<{ digest: string; green: boolean; criteria: Record<string, boolean> }> {
  const { snapshot, digest } = exportKernelSnapshot(directory);
  const rendered = renderSnapshotToTree(snapshot, corpus, mkdtempSync(join(tmpdir(), "strata-gate1-intr-")));
  cleanup.push(rendered);
  const green = await tscAndVitestGreen(rendered);
  const criteria = evaluateT03TextCriteria(readModuleMap(rendered)) as unknown as Record<string, boolean>;
  return { digest, green, criteria };
}

// ===========================================================================

describe("gate 1: second-client intrusion — stage-specific FIFO oracles", () => {
  beforeAll(() => ensureBuilt(), 600_000);

  // -------------------------------------------------------------------------
  // Case 1: pre-submit overlap. B commits User->Client FIRST; A (not yet
  // submitted) then publishes Client->Account as a second sequential operation.
  // Corrected direct-publish oracle: A -> published, renamedSymbols empty, two
  // sequential operations on the SAME declaration, never a silent overwrite.
  // -------------------------------------------------------------------------
  for (const stage of PRE_SUBMIT_STAGES) {
    test(
      `pre-submit overlap at ${stage}: A publishes as sequential N+1 op, no needs_decision`,
      async () => {
        const service = await startKernelService(corpus, { env: credentialFreeEnv() });
        const stop = makeStop(service);
        try {
          const a = new CoordinationClient({ socketPath: service.socketPath, clientId: `intrusion-A:${stage}` });
          const discovery = asDeclarations(await a.findDeclarations(OLD_NAME, "interface", READ_MS));
          expect(discovery.declarations).toHaveLength(1);
          const declarationId = discovery.declarations[0]!.nodeId;

          let intruder: Awaited<ReturnType<typeof commitIntruder>> | undefined;
          const commitB = async (): Promise<void> => {
            intruder = await commitIntruder(service.socketPath, declarationId, MIDDLE_NAME, "B renames User to Client");
          };

          // A drives begin/add/submit; B commits at exactly `stage`.
          if (stage === "after_discovery") await commitB();
          const begun = asChangeSet(await a.beginChangeSet(TASK_PROMPT, SUBMIT_MS));
          if (stage === "after_begin") await commitB();
          await a.addIntent(begun.changeSetId, { type: "rename_symbol", declarationId, newName: FINAL_NAME }, SUBMIT_MS);
          if (stage === "after_add_intent") await commitB();
          await a.submitChangeSet(begun.changeSetId, SUBMIT_MS);
          const aTerminal = await advanceUntilTerminal(a, begun.changeSetId);

          // A publishes directly — NO needs_decision round-trip.
          expect(aTerminal.state).toBe("published");
          expect(aTerminal.renamedSymbols).toEqual([]);
          expect(aTerminal.operationId).not.toBeNull();

          // Two-operation sequential history, both auditable, both on the SAME
          // stable declaration; B at generation N, A at N+1.
          const bOperation = asOperation(await a.readOperation(intruder!.operationId, READ_MS));
          const aOperation = asOperation(await a.readOperation(aTerminal.operationId!, READ_MS));
          expect(operationDeclarationId(bOperation)).toBe(declarationId);
          expect(operationDeclarationId(aOperation)).toBe(declarationId);
          expect(hasRename(bOperation, OLD_NAME, MIDDLE_NAME)).toBe(true);
          expect(hasRename(aOperation, MIDDLE_NAME, FINAL_NAME)).toBe(true);
          expect(BigInt(aOperation.graphGeneration)).toBe(BigInt(bOperation.graphGeneration) + 1n);

          // Final: green tree, T03 criteria pass, final name Account, digest cross-check.
          await stop({ preserveDirectory: true });
          const verified = await exportRenderVerify(service.directory);
          expect(verified.green).toBe(true);
          expect(verified.criteria).toMatchObject(ALL_TRUE);
          expect(aOperation.publicationDigest).toBe(verified.digest);
        } finally {
          await stop();
          rmSync(service.directory, { recursive: true, force: true });
        }
      },
      600_000
    );
  }

  // -------------------------------------------------------------------------
  // Case 2: after_submit overlap (A queued/ready first). FIFO older-overlap
  // holds B behind A: A commits, B's advance yields needs_decision naming the
  // fresh User->Account state; B never publishes, never overwrites.
  // -------------------------------------------------------------------------
  test(
    "after_submit overlap: A commits first; B yields needs_decision naming User->Account",
    async () => {
      const service = await startKernelService(corpus, { env: credentialFreeEnv() });
      const stop = makeStop(service);
      try {
        const a = new CoordinationClient({ socketPath: service.socketPath, clientId: `intrusion-A:after_submit` });
        const discovery = asDeclarations(await a.findDeclarations(OLD_NAME, "interface", READ_MS));
        const declarationId = discovery.declarations[0]!.nodeId;

        // A submits FIRST (older overlap).
        const aBegun = asChangeSet(await a.beginChangeSet(TASK_PROMPT, SUBMIT_MS));
        await a.addIntent(aBegun.changeSetId, { type: "rename_symbol", declarationId, newName: FINAL_NAME }, SUBMIT_MS);
        await a.submitChangeSet(aBegun.changeSetId, SUBMIT_MS);

        // B submits an overlapping rename AFTER A: it is held queued behind A.
        const b = new CoordinationClient({ socketPath: service.socketPath, clientId: `intrusion-B:${randomUUID()}` });
        const bBegun = asChangeSet(await b.beginChangeSet("B renames User to Client (after A submit)", SUBMIT_MS));
        await b.addIntent(bBegun.changeSetId, { type: "rename_symbol", declarationId, newName: MIDDLE_NAME }, SUBMIT_MS);
        const bSubmit = asChangeSet(await b.submitChangeSet(bBegun.changeSetId, SUBMIT_MS));
        expect(bSubmit.state).toBe("queued");

        // A advances first -> published; B then -> needs_decision (no overwrite).
        const aTerminal = await advanceUntilTerminal(a, aBegun.changeSetId);
        expect(aTerminal.state).toBe("published");
        expect(aTerminal.operationId).not.toBeNull();

        const bTerminal = await advanceUntilTerminal(b, bBegun.changeSetId);
        expect(bTerminal.state).toBe("needs_decision");
        expect(bTerminal.operationId).toBeNull(); // B produced no operation -> never overwrote
        expect(bTerminal.renamedSymbols).toEqual([
          { nodeId: declarationId, previousName: OLD_NAME, currentName: FINAL_NAME }
        ]);

        // A's operation is the sole committed operation on this declaration.
        const aOperation = asOperation(await a.readOperation(aTerminal.operationId!, READ_MS));
        expect(operationDeclarationId(aOperation)).toBe(declarationId);
        expect(hasRename(aOperation, OLD_NAME, FINAL_NAME)).toBe(true);

        // Final graph reflects A's commit only (B's needs_decision did not commit).
        await stop({ preserveDirectory: true });
        const verified = await exportRenderVerify(service.directory);
        expect(verified.green).toBe(true);
        expect(verified.criteria).toMatchObject(ALL_TRUE);
        expect(aOperation.publicationDigest).toBe(verified.digest);
      } finally {
        await stop();
        rmSync(service.directory, { recursive: true, force: true });
      }
    },
    600_000
  );

  // -------------------------------------------------------------------------
  // Case 3: disjoint intrusion at EVERY stage. B renames formatTimestamp (a
  // function in a different module than User) while A runs the canonical
  // User->Account flow via runKernelArmT03. Both land independently; the final
  // export contains both renames; tree green. Uses the onStage socketPath hook.
  // -------------------------------------------------------------------------
  for (const stage of ALL_STAGES) {
    test(
      `disjoint intrusion at ${stage}: both renames land independently, tree green`,
      async () => {
        let intruderOperationId: string | undefined;
        let intruderGeneration: string | undefined;
        let userModuleId: string | undefined;
        let formatModuleId: string | undefined;

        const outcome = await runKernelArmT03(corpus, {
          onStage: async (observed, ctx) => {
            if (observed !== stage) return;
            const b = new CoordinationClient({ socketPath: ctx.socketPath, clientId: `intrusion-Bdisjoint:${randomUUID()}` });
            const formatDecl = asDeclarations(await b.findDeclarations(DISJOINT_OLD, "function", READ_MS));
            expect(formatDecl.declarations).toHaveLength(1);
            formatModuleId = formatDecl.declarations[0]!.moduleId;
            const userDecl = asDeclarations(await b.findDeclarations(OLD_NAME, "interface", READ_MS));
            userModuleId = userDecl.declarations[0]!.moduleId;
            const committed = await commitIntruder(
              ctx.socketPath,
              formatDecl.declarations[0]!.nodeId,
              DISJOINT_NEW,
              "B renames formatTimestamp to formatTimestampAudit"
            );
            intruderOperationId = committed.operationId;
            intruderGeneration = committed.generation;
          }
        });
        cleanup.push(outcome.renderedRoot, outcome.directory);

        // A published (runKernelArmT03 returns only on a published commit), and
        // B's disjoint rename committed against a DIFFERENT module — a real
        // committed operation, not just a defined submit response.
        expect(typeof intruderOperationId).toBe("string");
        expect(intruderOperationId!.length).toBeGreaterThan(0);
        expect(typeof intruderGeneration).toBe("string");
        expect(userModuleId).toBeDefined();
        expect(formatModuleId).toBeDefined();
        expect(userModuleId).not.toBe(formatModuleId);

        // Final rendered tree carries BOTH renames and is green.
        expect(await tscAndVitestGreen(outcome.renderedRoot)).toBe(true);
        const modules = readModuleMap(outcome.renderedRoot);
        expect(evaluateT03TextCriteria(modules)).toMatchObject(ALL_TRUE);
        const blob = [...modules.values()].join("\n");
        expect(blob).toContain(DISJOINT_NEW); // B's rename landed
        expect(blob).toContain(FINAL_NAME); // A's rename landed
        expect(blob).not.toMatch(/\bformatTimestamp\b/); // old disjoint name fully propagated
      },
      600_000
    );
  }

  // -------------------------------------------------------------------------
  // Case 4: concurrent advances. A and B both submit overlapping renames (A
  // first => older), then both advance via Promise.allSettled. The brief oracle
  // says the durable queue order REQUIRES A to win; B must yield needs_decision.
  //
  // The required winner derives from durable submit order: A submitted first
  // (older), so A wins the claim and B yields needs_decision. This exact case
  // used to expose a poll-driven starvation defect — blocked-ticket age bumps
  // churned the scheduler revision until the older claim's optimistic
  // publication retries exhausted, mislabeled as candidate_validation_failed —
  // fixed in 502a43e (planner age-only reconsideration idempotence + daemon
  // OptimisticRetryExhausted taxonomy). See decisions.md 2026-07-19.
  // -------------------------------------------------------------------------
  test(
    "concurrent advances: durable-queue order forces A to win, B yields needs_decision",
    async () => {
      const service = await startKernelService(corpus, { env: credentialFreeEnv() });
      const stop = makeStop(service);
      try {
        const a = new CoordinationClient({ socketPath: service.socketPath, clientId: `intrusion-A:concurrent` });
        const b = new CoordinationClient({ socketPath: service.socketPath, clientId: `intrusion-B:concurrent:${randomUUID()}` });
        const discovery = asDeclarations(await a.findDeclarations(OLD_NAME, "interface", READ_MS));
        const declarationId = discovery.declarations[0]!.nodeId;

        // A submits first (older), B submits after (younger); both overlapping.
        const aBegun = asChangeSet(await a.beginChangeSet(TASK_PROMPT, SUBMIT_MS));
        await a.addIntent(aBegun.changeSetId, { type: "rename_symbol", declarationId, newName: FINAL_NAME }, SUBMIT_MS);
        await a.submitChangeSet(aBegun.changeSetId, SUBMIT_MS);

        const bBegun = asChangeSet(await b.beginChangeSet("B renames User to Client (concurrent)", SUBMIT_MS));
        await b.addIntent(bBegun.changeSetId, { type: "rename_symbol", declarationId, newName: MIDDLE_NAME }, SUBMIT_MS);
        await b.submitChangeSet(bBegun.changeSetId, SUBMIT_MS);

        // Fire both advances concurrently.
        const [aSettled, bSettled] = await Promise.allSettled([
          advanceUntilTerminal(a, aBegun.changeSetId),
          advanceUntilTerminal(b, bBegun.changeSetId)
        ]);
        if (aSettled.status !== "fulfilled") throw aSettled.reason;
        if (bSettled.status !== "fulfilled") throw bSettled.reason;

        // Required winner is A (older in the durable queue) — deterministic.
        expect(aSettled.value.state).toBe("published");
        expect(aSettled.value.operationId).not.toBeNull();
        expect(bSettled.value.state).toBe("needs_decision");
        expect(bSettled.value.operationId).toBeNull(); // B never committed / overwrote
        expect(bSettled.value.renamedSymbols).toEqual([
          { nodeId: declarationId, previousName: OLD_NAME, currentName: FINAL_NAME }
        ]);

        const aOperation = asOperation(await a.readOperation(aSettled.value.operationId!, READ_MS));
        expect(operationDeclarationId(aOperation)).toBe(declarationId);
        expect(hasRename(aOperation, OLD_NAME, FINAL_NAME)).toBe(true);

        await stop({ preserveDirectory: true });
        const verified = await exportRenderVerify(service.directory);
        expect(verified.green).toBe(true);
        expect(verified.criteria).toMatchObject(ALL_TRUE);
        expect(aOperation.publicationDigest).toBe(verified.digest);
      } finally {
        await stop();
        rmSync(service.directory, { recursive: true, force: true });
      }
    },
    600_000
  );

  // -------------------------------------------------------------------------
  // Case 5: ownership. B (foreign actor) calling advance/cancel on A's change
  // set is rejected with an authorization error; A's change set is untouched
  // and still publishes. Uses the onStage socketPath hook.
  // -------------------------------------------------------------------------
  test(
    "ownership: B's advance/cancel on A's change set is rejected; A's change set is untouched",
    async () => {
      let advanceErrorCode: string | undefined;
      let cancelErrorCode: string | undefined;

      const outcome = await runKernelArmT03(corpus, {
        onStage: async (observed, ctx) => {
          if (observed !== "after_submit") return;
          const b = new CoordinationClient({ socketPath: ctx.socketPath, clientId: `intrusion-Bowner:${randomUUID()}` });
          try {
            await b.advanceChangeSet(ctx.changeSetId!, ADVANCE_MS);
          } catch (error) {
            if (!(error instanceof CoordinationClientError)) throw error;
            advanceErrorCode = error.code;
          }
          try {
            await b.cancelChangeSet(ctx.changeSetId!, SUBMIT_MS);
          } catch (error) {
            if (!(error instanceof CoordinationClientError)) throw error;
            cancelErrorCode = error.code;
          }
        }
      });
      cleanup.push(outcome.renderedRoot, outcome.directory);

      // Both foreign mutations were rejected (authorization error). The daemon
      // redacts the specific rejection reason and reports the generic
      // "request_failed" code by design — the wire deliberately does not leak
      // why an unauthorized request was denied. "request_failed" is therefore
      // the strongest signal assertable from this side; the positive control
      // that ownership was actually enforced (rather than the request merely
      // failing for some other reason) is that A's change set below still
      // publishes and the tree comes out green.
      expect(advanceErrorCode).toBe("request_failed");
      expect(cancelErrorCode).toBe("request_failed");

      // A's change set was untouched: runKernelArmT03 published it and the tree
      // is green with the final name Account.
      expect(await tscAndVitestGreen(outcome.renderedRoot)).toBe(true);
      expect(evaluateT03TextCriteria(readModuleMap(outcome.renderedRoot))).toMatchObject(ALL_TRUE);
    },
    600_000
  );
});
