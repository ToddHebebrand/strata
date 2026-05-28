import ts from "typescript";
import { findNodeById, modulePathOf, insertNodes, listChildren } from "./nodes";
import type { Db } from "./schema";
import type { TxOverlay } from "./transactions";
import { trackInsertedNode, type TxHandle } from "./transactions";
import { emitIdentifiers } from "./emitIdentifiers";
import { resolveReferencesForModules } from "./resolveReferences";
import { insertReferences } from "./references";

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
      node.payload,
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

/**
 * Recompute reference edges for exactly the identifiers materialized this
 * commit (inserted-node identifiers + re-derived-statement identifiers).
 * `renderedByPath` must contain final rendered text for the dirty modules plus
 * any modules they import. Surviving identifiers' edges are left untouched,
 * except where a surviving identifier now references a materialized one.
 *
 * Ownership rule: this commit OWNS (may delete+insert) edges where EITHER
 * endpoint is a materialized identifier. This is necessary to capture
 * cross-statement references such as a surviving caller's `h()` call
 * resolving to a newly-inserted `h` declaration — the from-identifier belongs
 * to a surviving statement, but the to-identifier is owned (newly created).
 *
 * Safety of the from-OR-to rule:
 * - Deleting "edges where to_node_id is owned" is safe because owned
 *   to-identifiers are freshly created this commit; no pre-existing valid
 *   edge in the table could point to them. The resolver output is then the
 *   authoritative set for those targets.
 * - To guarantee no PRIMARY KEY conflict on insert (from_node_id is PK), we
 *   collect the set of fromNodeIds in toInsert and delete any surviving edge
 *   for those froms before calling insertReferences. This handles the edge case
 *   where a surviving from-identifier already has an edge (to some other target)
 *   and the resolver now routes it to an owned identifier instead.
 */
export function refreshReferenceEdges(
  db: Db,
  plan: MaterializationPlan,
  renderedByPath: Map<string, string>,
  options: ts.CompilerOptions
): void {
  if (isNoop(plan)) return;

  // Collect all identifier IDs that belong to inserted or re-derived nodes.
  const ownedIdentifierIds = new Set<string>();
  for (const parentId of [...plan.insertedNodeIds, ...plan.reDerivedStatementIds]) {
    for (const child of listChildren(db, parentId)) {
      if (child.kind === "Identifier") ownedIdentifierIds.add(child.id);
    }
  }

  // Run the resolver over the dirty modules' rendered text.
  const resolved = resolveReferencesForModules(
    renderedByPath,
    options,
    plan.dirtyModulePaths
  );

  // Filter to edges that touch an owned identifier on either endpoint.
  const toInsert = resolved.filter(
    (r) => ownedIdentifierIds.has(r.fromNodeId) || ownedIdentifierIds.has(r.toNodeId)
  );

  // Prepare a single delete statement usable for both the owned-set sweep and
  // the PK-conflict guard below.
  const del = db.prepare(
    `DELETE FROM node_references WHERE from_node_id = ? OR to_node_id = ?`
  );

  const apply = db.transaction(() => {
    // Step 1: delete all existing edges touching any owned identifier (from OR to).
    for (const id of ownedIdentifierIds) del.run(id, id);

    // Step 2: PK-conflict guard. toInsert may include edges whose fromNodeId is
    // a SURVIVING identifier (not in ownedIdentifierIds). If that surviving
    // from-identifier already has an edge pointing to a different target, the
    // Step 1 sweep above did NOT remove it (it only swept owned ids). To prevent
    // a PK collision, delete any remaining edge for each fromNodeId we are about
    // to insert, using the same OR-based statement (harmless if already deleted).
    const fromsToInsert = new Set(toInsert.map((r) => r.fromNodeId));
    for (const fromId of fromsToInsert) {
      if (!ownedIdentifierIds.has(fromId)) {
        // Only surviving from-identifiers need this guard; owned ones were
        // already cleared in Step 1.
        del.run(fromId, fromId);
      }
    }

    // Step 3: insert the fresh edges.
    if (toInsert.length > 0) insertReferences(db, toInsert);
  });
  apply();
}
