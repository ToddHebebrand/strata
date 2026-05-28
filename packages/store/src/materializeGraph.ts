import { findNodeById, modulePathOf } from "./nodes";
import type { Db } from "./schema";
import type { TxOverlay } from "./transactions";

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
