import { nodeId } from "./ids";
import { findNodeById, insertNodes, listChildren } from "./nodes";
import type { NodeRow } from "./nodes";
import type { Db } from "./schema";
import {
  trackDeletedEdgeForRestore,
  trackDeletedNodeForRestore,
  trackInsertedNode,
  type TxHandle
} from "./transactions";
import type { Reference } from "./references";

/**
 * Remove the top-level statement at `childIndex` from `moduleId`: delete that
 * node + its Identifier children + their reference edges, then re-index every
 * surviving sibling AND the EndOfFileTrivia node DOWN by one (a node's
 * childIndex is part of its id, so the survivors get re-derived ids). All
 * deleted rows + edges are captured for rollback (trackDeletedNodeForRestore /
 * trackDeletedEdgeForRestore); re-inserted survivors are tracked as inserted
 * (trackInsertedNode) so commit re-emits their identifiers + edges.
 *
 * This is the first top-level-statement *deletion* primitive
 * (appendChildStatement only shifts UP on insert; this shifts DOWN on delete).
 * Shared by move_declaration (source side) and inline_function. Lifted verbatim
 * from move_declaration's open-coded source-deletion + re-index block.
 *
 * A node's id is `nodeId(modulePath, [childIndex], kind)`, so removing the
 * statement at index K leaves a gap: surviving siblings keep stale ids at their
 * old (too-high) childIndex. A clean re-ingest of the now-shorter module would
 * place them one slot lower. Without re-indexing, (a) the EOF node's id is stale
 * → re-ingest equivalence fails, and (b) at commit, refreshReferenceEdges
 * resolves a surviving sibling at its CORRECT (lowered) index → a fresh edge
 * references an id absent from `nodes` → FOREIGN KEY constraint failed.
 */
export function removeChildStatement(
  db: Db,
  tx: TxHandle,
  moduleId: string,
  childIndex: number
): void {
  const moduleNode = findNodeById(db, moduleId);
  if (!moduleNode) {
    throw new Error(`removeChildStatement: module not found: ${moduleId}`);
  }
  if (moduleNode.kind !== "Module") {
    throw new Error(
      `removeChildStatement: node ${moduleId} is not a Module (kind=${moduleNode.kind})`
    );
  }
  const modulePath = moduleNode.payload;

  const stmt = listChildren(db, moduleId).find((c) => c.childIndex === childIndex);
  if (!stmt) {
    throw new Error(
      `removeChildStatement: no statement at module ${moduleId} child_index ${childIndex}`
    );
  }

  const deletedIndex = childIndex; // the freed slot

  const idChildren = listChildren(db, stmt.id).filter((c) => c.kind === "Identifier");
  const deletedIds = [...idChildren, stmt].map((ch) => ch.id);

  // Surviving siblings: every module child past the removed statement, ascending
  // by childIndex. This INCLUDES the EndOfFileTrivia node and any surviving
  // statements.
  const survivors = listChildren(db, moduleId)
    .filter((c) => c.childIndex !== null && c.childIndex > deletedIndex)
    .sort((a, b) => a.childIndex! - b.childIndex!);

  // Capture every reference edge touching any deleted-subtree node in a single
  // query BEFORE the delete — so rollback can re-insert them verbatim. A single
  // SELECT over the full id set (rather than per-node) naturally de-duplicates
  // edges whose BOTH endpoints are in the delete set.
  const placeholders = deletedIds.map(() => "?").join(", ");
  const capturedEdges = db
    .prepare(
      `SELECT from_node_id AS fromNodeId, to_node_id AS toNodeId, kind
       FROM node_references
       WHERE from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders})`
    )
    .all(...deletedIds, ...deletedIds) as Reference[];
  trackDeletedEdgeForRestore(tx, capturedEdges);

  const delEdges = db.prepare(
    `DELETE FROM node_references WHERE from_node_id = ? OR to_node_id = ?`
  );
  const delNode = db.prepare(`DELETE FROM nodes WHERE id = ?`);

  // Plan the re-indexed survivor rows BEFORE any deletion so we can capture each
  // survivor's old row + its Identifier children + their edges for rollback.
  interface SurvivorPlan {
    oldNode: NodeRow;
    oldIdentifiers: NodeRow[];
    newRow: NodeRow;
  }
  const survivorPlans: SurvivorPlan[] = survivors.map((s) => {
    const newChildIndex = s.childIndex! - 1;
    const newId = nodeId(modulePath, [newChildIndex], s.kind);
    const oldIdentifiers = listChildren(db, s.id).filter((c) => c.kind === "Identifier");
    return {
      oldNode: s,
      oldIdentifiers,
      newRow: {
        id: newId,
        kind: s.kind,
        parentId: moduleId,
        childIndex: newChildIndex,
        payload: s.payload // payload UNCHANGED
      }
    };
  });

  // Capture survivor edges for rollback: every edge touching a survivor node or
  // any of its Identifier children. (refreshReferenceEdges re-resolves these at
  // commit since the survivor is re-inserted as a tracked-inserted node and the
  // module is dirty; but rollback must restore the pre-removal edges.)
  const survivorEdgeIds = survivorPlans.flatMap((p) => [
    p.oldNode.id,
    ...p.oldIdentifiers.map((i) => i.id)
  ]);
  if (survivorEdgeIds.length > 0) {
    const sph = survivorEdgeIds.map(() => "?").join(", ");
    const survivorEdges = db
      .prepare(
        `SELECT from_node_id AS fromNodeId, to_node_id AS toNodeId, kind
         FROM node_references
         WHERE from_node_id IN (${sph}) OR to_node_id IN (${sph})`
      )
      .all(...survivorEdgeIds, ...survivorEdgeIds) as Reference[];
    trackDeletedEdgeForRestore(tx, survivorEdges);
  }

  // Collision-freedom: DELETE every old row first (deleted subtree + every
  // survivor node and its identifiers), THEN INSERT every re-indexed survivor
  // row. Since all old rows are gone before any new row goes in, no derived id
  // can collide with a still-present old row regardless of index order.
  const drop = db.transaction(() => {
    // 1. Delete the statement node + its Identifier children + their edges.
    for (const ch of [...idChildren, stmt]) {
      trackDeletedNodeForRestore(tx, ch);
      delEdges.run(ch.id, ch.id);
      delNode.run(ch.id);
    }
    // 2. Delete every survivor's old row + its Identifier children + their edges.
    for (const plan of survivorPlans) {
      for (const ident of plan.oldIdentifiers) {
        trackDeletedNodeForRestore(tx, ident);
        delEdges.run(ident.id, ident.id);
        delNode.run(ident.id);
      }
      trackDeletedNodeForRestore(tx, plan.oldNode);
      delEdges.run(plan.oldNode.id, plan.oldNode.id);
      delNode.run(plan.oldNode.id);
    }
    // 3. Insert every re-indexed survivor row (no Identifier children emitted
    //    here: planMaterialization + emitIdentifiersForInserted re-emit them at
    //    the corrected childIndex at commit, and refreshReferenceEdges re-resolves
    //    their edges over the now-dirty module. The EndOfFileTrivia node is
    //    skipped for identifier emission by planMaterialization — re-inserting it
    //    at the corrected index just fixes its stale id, which is all it needs).
    for (const plan of survivorPlans) {
      insertNodes(db, [plan.newRow]);
      trackInsertedNode(tx, plan.newRow.id);
    }
  });
  drop();
}
