import { randomUUID } from "node:crypto";
import { appendOperations, type OperationRow } from "./operations";
import type { Db } from "./schema";

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

export interface TxOverlay {
  identifierMutations: Map<string, { text: string }>;
  pendingOps: PendingOp[];
  status: "open" | "committed" | "rolled_back";
}

const overlays = new Map<string, TxOverlay>();

export function begin(db: Db, actor: string): TxHandle {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO transactions (tx_id, started_at, status, actor)
     VALUES (?, ?, 'open', ?)`
  ).run(id, Date.now(), actor);
  overlays.set(id, {
    identifierMutations: new Map(),
    pendingOps: [],
    status: "open"
  });
  return { id, actor };
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
