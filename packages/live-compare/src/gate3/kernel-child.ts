#!/usr/bin/env node
// Gate 3 (unkeyed noninferiority), Task 2: the kernel-arm isolated-child
// mutation worker. Starts a `strata-kernel-service` daemon with `--metrics`
// deliberately OMITTED (metrics OFF — see `startKernelService`, which only
// adds `--metrics` when the caller passes it via extraArgs, which this file
// never does), then times ONLY submit_change_set + advance-until-published
// per mutation via hrtime.bigint — begin_change_set/add_intent are draft
// steps and are executed but not timed, the symmetric counterpart to the
// SQLite arm's validate+commit window.
//
// `childMaxRssBytes` here is THIS harness process's maxRSS, not the daemon's
// (the daemon's RSS is captured separately by the metrics-on run, Task 7).
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  ADVANCE_DEADLINE_MS,
  DISCOVERY_DEADLINE_MS,
  SUBMIT_DEADLINE_MS,
  TASK_PROMPT,
  credentialFreeEnv,
  expectResult,
  kernelServiceBinary
} from "../gate1.js";
import { CoordinationClient } from "../client.js";
import { startKernelService } from "../service.js";
import {
  childMaxRssBytes,
  openChildLineSource,
  readChildRequest,
  readChildStepRequest,
  writeChildMessage,
  type ChildLineSource,
  type ChildRenameTarget
} from "./child-protocol.js";

const MAX_ADVANCE_ATTEMPTS = 10;

/**
 * Resolve the interface `declarationId` to rename.
 *
 * The single-copy case (`examples/medium`) has exactly one match and returns it
 * directly. In a REPLICATED corpus (gate-3 big1k) the same interface name
 * exists once per `src/copyNN` — so `find_declarations` returns many. Unlike the
 * SQLite arm (which selects the specific `target.modulePath` via
 * `modulePathOf`), the kernel arm has NO module-path information to select by:
 * the kernel graph's `Module` nodes carry an EMPTY `payload` (verified by
 * probing the live daemon's `inspect_nodes` — a Module's payload is `""`), so
 * there is nothing to match `target.modulePath` against. That is a genuine
 * asymmetry in the daemon's node model, not something this harness can recover
 * per-call.
 *
 * It does not need to: every `src/copyNN` copy is a verbatim, self-contained
 * replica (identical source text, identical INTRA-copy reference count — imports
 * are copy-relative), and validation tsc-checks the WHOLE corpus regardless of
 * which copy is mutated. So renaming ANY single one of the equally-shaped
 * matches is a measurement-equivalent timed mutation. We pick deterministically
 * (lexicographically-smallest `nodeId`) so a seeded run is fully reproducible.
 * `target.modulePath` is retained in the wire contract for the SQLite arm's
 * precise selection and for provenance; the kernel arm simply cannot honor it.
 */
async function resolveTargetDeclarationId(
  client: CoordinationClient,
  target: ChildRenameTarget,
  name: string
): Promise<string> {
  void target;
  const discovery = expectResult(
    await client.findDeclarations(name, "interface", DISCOVERY_DEADLINE_MS),
    "declarations"
  );
  if (discovery.declarations.length === 0) {
    throw new Error(`kernel-child: no interface named ${JSON.stringify(name)} found`);
  }
  const chosen = [...discovery.declarations].sort((a, b) => a.nodeId.localeCompare(b.nodeId))[0]!;
  return chosen.nodeId;
}

interface MutationOutcome {
  callerWallNs: number;
  lifecycle: string[];
  operationId: string;
}

/**
 * Run one rename, timing ONLY submit_change_set + advance-until-published.
 * `advance_change_set` is polled defensively (matching gate2's
 * advanceUntilPublished) — an uncontested single-change-set rename ordinarily
 * publishes on the first call, so `lifecycle` will typically carry exactly
 * one "advance_change_set" entry, appended each time the call actually runs.
 */
async function runOneMutation(
  client: CoordinationClient,
  declarationId: string,
  newName: string
): Promise<MutationOutcome> {
  const lifecycle: string[] = [];

  lifecycle.push("begin_change_set");
  const begun = expectResult(await client.beginChangeSet(TASK_PROMPT, SUBMIT_DEADLINE_MS), "change_set");
  const changeSetId = begun.changeSetId;

  lifecycle.push("add_intent");
  expectResult(
    await client.addIntent(
      changeSetId,
      { type: "rename_symbol", declarationId, newName },
      SUBMIT_DEADLINE_MS
    ),
    "change_set"
  );

  const startNs = process.hrtime.bigint();
  lifecycle.push("submit_change_set");
  expectResult(await client.submitChangeSet(changeSetId, SUBMIT_DEADLINE_MS), "change_set");

  let operationId: string | null = null;
  for (let attempt = 0; attempt < MAX_ADVANCE_ATTEMPTS && operationId === null; attempt += 1) {
    lifecycle.push("advance_change_set");
    const advanced = expectResult(await client.advanceChangeSet(changeSetId, ADVANCE_DEADLINE_MS), "change_set");
    if (advanced.state === "published" && advanced.operationId !== null) {
      operationId = advanced.operationId;
    }
  }
  const endNs = process.hrtime.bigint();
  if (operationId === null) {
    throw new Error(
      `kernel-child: change set ${changeSetId} did not reach 'published' within ${MAX_ADVANCE_ATTEMPTS} advance attempts`
    );
  }

  return { callerWallNs: Number(endNs - startNs), lifecycle, operationId };
}

/**
 * Independent re-query verification: reads the published operation back over
 * the wire (not the mutation call's own return value) and confirms it really
 * carries the fromName -> toName transition this iteration asked for — a
 * no-op cannot fabricate this record.
 */
async function verifyRenamed(
  client: CoordinationClient,
  operationId: string,
  fromName: string,
  toName: string
): Promise<void> {
  const operation = expectResult(await client.readOperation(operationId, DISCOVERY_DEADLINE_MS), "operation");
  const rename0 = operation.renames[0];
  if (!rename0 || rename0.fromName !== fromName || rename0.toName !== toName) {
    throw new Error(
      `kernel-child: operation ${operationId} did not carry a ${JSON.stringify(fromName)} -> ${JSON.stringify(toName)} rename transition: ${JSON.stringify(operation.renames)}`
    );
  }
}

async function runPlan(
  corpusRoot: string,
  target: ChildRenameTarget,
  iterations: number,
  awaitStep?: () => Promise<void>
): Promise<void> {
  const service = await startKernelService(corpusRoot, {
    binaryPath: kernelServiceBinary(),
    env: credentialFreeEnv()
    // No extraArgs: `--metrics` is deliberately never passed, so the daemon
    // never opens a metrics sink for this timed run.
  });
  const client = new CoordinationClient({
    socketPath: service.socketPath,
    clientId: `gate3-kernel-child:${randomUUID()}`
  });
  try {
    const declarationId = await resolveTargetDeclarationId(client, target, target.declarationName);

    let expectedCurrentName = target.declarationName;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      if (awaitStep) await awaitStep();
      const nextName = iteration % 2 === 0 ? target.newName : target.declarationName;

      const { callerWallNs, lifecycle, operationId } = await runOneMutation(client, declarationId, nextName);
      await verifyRenamed(client, operationId, expectedCurrentName, nextName);
      expectedCurrentName = nextName;

      writeChildMessage({
        callerWallNs,
        childMaxRssBytes: childMaxRssBytes(),
        published: true,
        lifecycle,
        childPid: process.pid
      });
    }
  } finally {
    await service.stop();
  }
}

async function main(): Promise<void> {
  const source: ChildLineSource = openChildLineSource();
  const request = await readChildRequest(source);
  const resolvedRoot = resolve(request.corpusRoot);
  const iterations = request.mode === "cold" ? 1 : request.iterations;
  const stepped = request.mode === "warm" && request.stepped === true;

  await runPlan(
    resolvedRoot,
    request.target,
    iterations,
    stepped
      ? async () => {
          await readChildStepRequest(source);
        }
      : undefined
  );

  source.close();
  writeChildMessage({ done: true });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
