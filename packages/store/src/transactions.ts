import { randomUUID } from "node:crypto";
import { appendOperations, type OperationRow } from "./operations";
import type { Db } from "./schema";
import type { NodeRow } from "./nodes";
import type { Reference } from "./references";

export interface TxHandle {
  readonly id: string;
  readonly actor: string;
}

export interface PendingOp {
  kind: string;
  paramsJson: string;
  affectedNodeIdsJson: string;
  reasoning: string | null;
}

export interface TextSpanEdit {
  start: number;
  end: number;
  oldText: string;
  newText: string;
}

export interface TxOverlay {
  identifierMutations: Map<string, { text: string }>;
  textSpanMutations: Map<string, TextSpanEdit[]>;
  /**
   * IDs of nodes inserted during this transaction. Unlike identifier and
   * text-span edits (which are overlay-only until commit), node inserts go
   * straight into the nodes table so validate() sees them within the same
   * transaction. Rollback deletes these rows; commit leaves them alone.
   */
  insertedNodeIds: string[];
  /**
   * Full node rows deleted (or about to be replaced) during this transaction
   * that must be re-inserted verbatim on rollback. Used by the EOF-shift in
   * create_function/add_import and by class-2 identifier re-derivation, which
   * delete existing rows the plain insertedNodeIds rollback cannot restore.
   */
  deletedNodesToRestore: NodeRow[];
  /**
   * Reference edges deleted during this transaction (e.g. by move_declaration's
   * source-declaration removal, which drops the decl + its Identifier children
   * AND their reference edges at apply time) that must be re-inserted verbatim
   * on rollback. The overlay otherwise tracks only nodes, so an edge delete is
   * unrestorable — resurrecting the nodes on rollback would leave the graph
   * edge-inconsistent (get_references on the restored decl would return nothing)
   * without this.
   */
  deletedEdgesToRestore: Reference[];
  pendingOps: PendingOp[];
  status: "open" | "committed" | "rolled_back";
}

const overlays = new Map<string, TxOverlay>();

export function begin(
  db: Db,
  actor: string,
  triggeringPrompt?: string
): TxHandle {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO transactions (tx_id, started_at, status, actor, triggering_prompt)
     VALUES (?, ?, 'open', ?, ?)`
  ).run(id, Date.now(), actor, triggeringPrompt ?? null);
  overlays.set(id, {
    identifierMutations: new Map(),
    textSpanMutations: new Map(),
    insertedNodeIds: [],
    deletedNodesToRestore: [],
    deletedEdgesToRestore: [],
    pendingOps: [],
    status: "open"
  });
  return { id, actor };
}

export function trackInsertedNode(tx: TxHandle, nodeId: string): void {
  getOverlay(tx).insertedNodeIds.push(nodeId);
}

export function trackDeletedNodeForRestore(tx: TxHandle, node: NodeRow): void {
  const overlay = getOverlay(tx);
  // First-seen-wins: if this id was already INSERTED earlier in this same
  // transaction (and not previously seen as a pre-tx deletion), the row being
  // deleted now is an EPHEMERAL this-tx row, not pre-tx state — restoring it on
  // rollback would resurrect a node that never existed before the tx. (Concrete
  // case: move_declaration inserts a re-indexed EOF row, then the conditional
  // back-import's appendChildStatement shifts that very row and calls this.)
  // It is safe to skip the restore: rollback's phase-1 deletes all inserted ids.
  const insertedFirst =
    overlay.insertedNodeIds.includes(node.id) &&
    !overlay.deletedNodesToRestore.some((n) => n.id === node.id);
  if (insertedFirst) return;
  overlay.deletedNodesToRestore.push(node);
}

export function trackDeletedEdgeForRestore(
  tx: TxHandle,
  edges: Reference[]
): void {
  const overlay = getOverlay(tx);
  for (const edge of edges) {
    overlay.deletedEdgesToRestore.push(edge);
  }
}

export function getOverlay(tx: TxHandle): TxOverlay {
  const overlay = overlays.get(tx.id);
  if (!overlay) {
    throw new Error(`Transaction ${tx.id} has no overlay`);
  }
  if (overlay.status !== "open") {
    throw new Error(`Transaction ${tx.id} is ${overlay.status}, not open`);
  }
  return overlay;
}

export function queueIdentifierUpdate(
  tx: TxHandle,
  identifierId: string,
  newText: string
): void {
  getOverlay(tx).identifierMutations.set(identifierId, { text: newText });
}

export function queueTextSpanEdit(
  tx: TxHandle,
  statementId: string,
  edit: TextSpanEdit
): void {
  const overlay = getOverlay(tx);
  const list = overlay.textSpanMutations.get(statementId) ?? [];
  list.push(edit);
  overlay.textSpanMutations.set(statementId, list);
}

export function queuePendingOp(tx: TxHandle, op: PendingOp): void {
  getOverlay(tx).pendingOps.push(op);
}

export function rollback(db: Db, tx: TxHandle): void {
  const overlay = overlays.get(tx.id);
  if (!overlay) {
    throw new Error(`Unknown transaction ${tx.id}`);
  }
  if (overlay.status !== "open") {
    throw new Error(`Transaction ${tx.id} not open`);
  }

  if (
    overlay.insertedNodeIds.length > 0 ||
    overlay.deletedNodesToRestore.length > 0 ||
    overlay.deletedEdgesToRestore.length > 0
  ) {
    const deleteNode = db.prepare(`DELETE FROM nodes WHERE id = ?`);
    // INSERT OR REPLACE (not plain INSERT): a throwing commit `finalize()`
    // transaction may have already restored some of these rows via SAVEPOINT
    // revert while they remain tracked here, so the restore must be idempotent.
    // The stored row IS the pre-tx state, so overwriting with it is always correct.
    const insertNode = db.prepare(
      `INSERT OR REPLACE INTO nodes (id, kind, parent_id, child_index, payload)
       VALUES (@id, @kind, @parentId, @childIndex, @payload)`
    );
    // Direct prepared INSERT OR REPLACE (not insertReferences) because
    // insertReferences opens its own db.transaction; running the edge restore
    // inside this `undo` transaction mirrors how nodes are restored and avoids
    // nesting. INSERT OR REPLACE for the same idempotency rationale as nodes.
    const insertEdge = db.prepare(
      `INSERT OR REPLACE INTO node_references (from_node_id, to_node_id, kind)
       VALUES (@fromNodeId, @toNodeId, @kind)`
    );
    const undo = db.transaction(() => {
      for (const id of overlay.insertedNodeIds) {
        deleteNode.run(id);
      }
      // Restore nodes FIRST, then edges: node_references has FOREIGN KEY
      // constraints on both endpoints, so the endpoint nodes must exist.
      for (const node of overlay.deletedNodesToRestore) {
        insertNode.run(node);
      }
      for (const edge of overlay.deletedEdgesToRestore) {
        insertEdge.run(edge);
      }
    });
    undo();
  }

  db.prepare(
    `UPDATE transactions
       SET status = 'rolled_back', committed_at = ?
     WHERE tx_id = ?`
  ).run(Date.now(), tx.id);
  overlay.status = "rolled_back";
  overlays.delete(tx.id);
}

export function commitWithoutValidate(db: Db, tx: TxHandle): void {
  const overlay = getOverlay(tx);

  const flush = db.transaction(() => {
    const readIdentifier = db.prepare(`SELECT payload FROM nodes WHERE id = ?`);
    const updateIdentifier = db.prepare(`UPDATE nodes SET payload = ? WHERE id = ?`);

    for (const [identifierId, mutation] of overlay.identifierMutations) {
      const row = readIdentifier.get(identifierId) as
        | { payload: string }
        | undefined;
      if (!row) {
        continue;
      }

      const current = JSON.parse(row.payload) as {
        text: string;
        offset: number;
      };
      updateIdentifier.run(
        JSON.stringify({ text: mutation.text, offset: current.offset }),
        identifierId
      );
    }

    for (const [statementId, edits] of overlay.textSpanMutations) {
      const row = readIdentifier.get(statementId) as
        | { payload: string }
        | undefined;
      if (!row) {
        continue;
      }

      const sorted = [...edits].sort((left, right) => right.start - left.start);
      let payload = row.payload;
      for (const edit of sorted) {
        const actual = payload.slice(edit.start, edit.start + edit.oldText.length);
        if (
          actual !== edit.oldText ||
          edit.end !== edit.start + edit.oldText.length
        ) {
          throw new Error(
            `commit text-span oldText mismatch on ${statementId} at ` +
              `[${edit.start},${edit.end})`
          );
        }
        payload =
          payload.slice(0, edit.start) + edit.newText + payload.slice(edit.end);
      }
      updateIdentifier.run(payload, statementId);
    }

    const ts = Date.now();
    const opRows: OperationRow[] = overlay.pendingOps.map((op) => ({
      opId: randomUUID(),
      txId: tx.id,
      kind: op.kind,
      paramsJson: op.paramsJson,
      affectedNodeIdsJson: op.affectedNodeIdsJson,
      actor: tx.actor,
      ts,
      reasoning: op.reasoning
    }));
    if (opRows.length > 0) {
      appendOperations(db, opRows);
    }

    db.prepare(
      `UPDATE transactions
         SET status = 'committed', committed_at = ?
       WHERE tx_id = ?`
    ).run(Date.now(), tx.id);
  });

  flush();
  overlay.status = "committed";
  overlays.delete(tx.id);
}

export function startupRecoverOpenTransactions(db: Db): void {
  db.prepare(
    `UPDATE transactions
       SET status = 'rolled_back', committed_at = ?
     WHERE status = 'open'`
  ).run(Date.now());
}
