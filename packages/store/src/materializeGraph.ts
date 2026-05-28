import ts from "typescript";
import { findNodeById, modulePathOf, insertNodes } from "./nodes";
import type { NodeRow } from "./nodes";
import type { Db } from "./schema";
import type { TxOverlay } from "./transactions";
import { trackInsertedNode, type TxHandle } from "./transactions";
import { emitIdentifiers } from "./emitIdentifiers";

export interface MaterializationPlan {
  dirtyModulePaths: string[];
  /** Newly-inserted top-level nodes (create_function, add_import). Class-1. */
  insertedNodeIds: string[];
  /**
   * Top-level statement node IDs whose internal identifier set/order changed
   * (text-span splices that insert/delete identifiers). Class-2.
   */
  reDerivedStatementIds: string[];
}

/**
 * Build the materialization plan from the overlay. MUST run before
 * materializeStatementPayloads clears overlay.textSpanMutations.
 *
 * EndOfFileTrivia inserts (the EOF-shift in create_function/add_import) are
 * excluded — they carry no identifiers and are not real structure.
 */
export function planMaterialization(db: Db, overlay: TxOverlay): MaterializationPlan {
  const dirty = new Set<string>();
  const insertedNodeIds: string[] = [];
  const reDerivedStatementIds: string[] = [];

  for (const id of overlay.insertedNodeIds) {
    const node = findNodeById(db, id);
    if (!node || node.kind === "EndOfFileTrivia") continue;
    insertedNodeIds.push(id);
    dirty.add(modulePathOf(db, id));
  }

  for (const statementId of overlay.textSpanMutations.keys()) {
    reDerivedStatementIds.push(statementId);
    dirty.add(modulePathOf(db, statementId));
  }

  return {
    dirtyModulePaths: [...dirty],
    insertedNodeIds,
    reDerivedStatementIds
  };
}

export function isNoop(plan: MaterializationPlan): boolean {
  return plan.insertedNodeIds.length === 0 && plan.reDerivedStatementIds.length === 0;
}

/**
 * Class-1: for each inserted top-level node, parse its payload and emit its
 * Identifier children. The node's childIndex is its statement index N (post
 * the EOF fix), so emitted identifier IDs match what a re-ingest produces.
 * Emitted identifiers are tracked for rollback.
 */
export function emitIdentifiersForInserted(
  db: Db,
  tx: TxHandle,
  plan: MaterializationPlan
): void {
  for (const insertedId of plan.insertedNodeIds) {
    const node = findNodeById(db, insertedId);
    if (!node || node.childIndex === null) continue;
    const modulePath = modulePathOf(db, insertedId);
    const sf = ts.createSourceFile(
      modulePath,
      node.payload.replace(/^\n+/, ""),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const stmt = sf.statements[0];
    if (!stmt) continue;
    const identifiers = emitIdentifiers(sf, stmt, modulePath, [node.childIndex]);
    if (identifiers.length === 0) continue;
    insertNodes(db, identifiers);
    for (const ident of identifiers) trackInsertedNode(tx, ident.id);
  }
}
