import type { Db } from "./schema";

export interface OperationRow {
  opId: string;
  txId: string;
  kind: string;
  paramsJson: string;
  affectedNodeIdsJson: string;
  actor: string;
  ts: number;
  reasoning: string | null;
}

export function appendOperations(db: Db, ops: OperationRow[]): void {
  const insert = db.prepare(
    `INSERT INTO operations
       (op_id, tx_id, kind, params_json, affected_node_ids_json, actor, ts, reasoning)
     VALUES
       (@opId, @txId, @kind, @paramsJson, @affectedNodeIdsJson, @actor, @ts, @reasoning)`
  );

  const insertMany = db.transaction((rows: OperationRow[]) => {
    for (const row of rows) {
      insert.run(row);
    }
  });

  insertMany(ops);
}

export function listOperationsByTx(db: Db, txId: string): OperationRow[] {
  return db
    .prepare(
      `SELECT
         op_id  AS opId,
         tx_id  AS txId,
         kind,
         params_json            AS paramsJson,
         affected_node_ids_json AS affectedNodeIdsJson,
         actor,
         ts,
         reasoning
       FROM operations
       WHERE tx_id = ?
       ORDER BY ts ASC`
    )
    .all(txId) as OperationRow[];
}
