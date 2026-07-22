#!/usr/bin/env node
// Gate 3 (unkeyed noninferiority), Task 2: the SQLite-arm isolated-child
// mutation worker. Ingests the corpus into ":memory:" once (matching
// runSqliteArm in gate1.ts), then times ONLY validate(db,tx,root) +
// commit(db,tx,root) per mutation via hrtime.bigint — begin/rename_symbol
// are draft steps and are executed but not timed, exactly the symmetric
// window the gate-3 plan specifies against the kernel arm's
// submit_change_set + advance_change_set.
//
// No `--metrics` sink exists in the SQLite arm to begin with; this file's
// half of "metrics OFF, both arms" is trivially satisfied. See
// kernel-child.ts for the daemon side, where it is a real constraint (no
// `--metrics` extraArg).
import { resolve } from "node:path";
import { ingestBatch } from "@strata-code/ingest";
import {
  begin,
  find_declarations,
  insertNodes,
  insertReferences,
  modulePathOf,
  openDb,
  rename_symbol,
  rollback,
  type Db,
  type NodeRow
} from "@strata-code/store";
import { commit, validate } from "@strata-code/verify";
import { SQLITE_ARM_ACTOR, TASK_PROMPT, buildCorpusInputs } from "../gate1.js";
import {
  childMaxRssBytes,
  openChildLineSource,
  readChildRequest,
  readChildStepRequest,
  writeChildMessage,
  type ChildLineSource,
  type ChildRenameTarget
} from "./child-protocol.js";

/** Wraps a call, pushing its label onto `lifecycle` at the call site — the trace is the real sequence, not a literal. */
function wrapStep<T>(lifecycle: string[], label: string, fn: () => T): T {
  lifecycle.push(label);
  return fn();
}

/** Find the interface named `name` inside `target.modulePath`, filtering out same-named declarations in other (replicated-corpus) copies. */
function resolveTargetDeclaration(db: Db, target: ChildRenameTarget, name: string): NodeRow {
  const candidates = find_declarations(db, { name, kind: "interface" });
  const match = candidates.find((candidate) => modulePathOf(db, candidate.id) === target.modulePath);
  if (!match) {
    throw new Error(
      `sqlite-child: no interface named ${JSON.stringify(name)} found in module ${target.modulePath}`
    );
  }
  return match;
}

/** True iff `declarationId` is currently resolvable under `name` (a fresh, independent re-query — not the mutation call's own return value). */
function isCurrentlyNamed(db: Db, declarationId: string, name: string): boolean {
  return find_declarations(db, { name, kind: "interface" }).some((candidate) => candidate.id === declarationId);
}

interface MutationOutcome {
  callerWallNs: number;
  lifecycle: string[];
}

/** Run one rename, timing ONLY validate+commit. Draft (begin/rename_symbol) and post-commit verification are outside the timed window. */
function runOneMutation(db: Db, corpusRoot: string, declarationId: string, newName: string): MutationOutcome {
  const lifecycle: string[] = [];

  const tx = wrapStep(lifecycle, "begin", () => begin(db, SQLITE_ARM_ACTOR, TASK_PROMPT));
  wrapStep(lifecycle, "rename_symbol", () => rename_symbol(db, tx, declarationId, newName));

  const startNs = process.hrtime.bigint();
  const diagnostics = wrapStep(lifecycle, "validate", () => validate(db, tx, corpusRoot));
  if (diagnostics.length > 0) {
    rollback(db, tx);
    throw new Error(`sqlite-child: pre-commit validate not clean: ${JSON.stringify(diagnostics)}`);
  }
  const commitResult = wrapStep(lifecycle, "commit", () => commit(db, tx, corpusRoot));
  const endNs = process.hrtime.bigint();
  if (!commitResult.ok) {
    throw new Error(`sqlite-child: commit failed: ${JSON.stringify(commitResult.diagnostics)}`);
  }

  return { callerWallNs: Number(endNs - startNs), lifecycle };
}

async function main(): Promise<void> {
  const source: ChildLineSource = openChildLineSource();
  const request = await readChildRequest(source);
  const resolvedRoot = resolve(request.corpusRoot);
  const iterations = request.mode === "cold" ? 1 : request.iterations;
  const stepped = request.mode === "warm" && request.stepped === true;

  const batch = ingestBatch(buildCorpusInputs(resolvedRoot));
  const db = openDb(":memory:");
  try {
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    const declaration = resolveTargetDeclaration(db, request.target, request.target.declarationName);
    const declarationId = declaration.id;

    let expectedCurrentName = request.target.declarationName;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      if (stepped) await readChildStepRequest(source);
      const nextName = iteration % 2 === 0 ? request.target.newName : request.target.declarationName;

      // Sanity: the declaration must still be where our own alternation
      // bookkeeping thinks it is before we rename it again.
      if (!isCurrentlyNamed(db, declarationId, expectedCurrentName)) {
        throw new Error(
          `sqlite-child: iteration ${iteration} expected ${declarationId} to be named ${JSON.stringify(expectedCurrentName)} before mutating`
        );
      }

      const { callerWallNs, lifecycle } = runOneMutation(db, resolvedRoot, declarationId, nextName);

      // Independent re-query verification: a no-op (mutation that did not
      // actually change the graph) must not be able to score callerWallNs.
      const renamedForward = isCurrentlyNamed(db, declarationId, nextName);
      const stillOldName = isCurrentlyNamed(db, declarationId, expectedCurrentName);
      if (!renamedForward || (nextName !== expectedCurrentName && stillOldName)) {
        throw new Error(
          `sqlite-child: iteration ${iteration} did not actually rename ${declarationId} from ${JSON.stringify(expectedCurrentName)} to ${JSON.stringify(nextName)}`
        );
      }
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
    db.close();
  }

  source.close();
  writeChildMessage({ done: true });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
