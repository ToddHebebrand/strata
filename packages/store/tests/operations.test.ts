import { describe, expect, it } from "vitest";
import {
  appendOperations,
  listOperationsByTx,
  type OperationRow
} from "../src/operations";
import { openDb } from "../src/schema";

describe("operations", () => {
  it("appends and reads back operation rows by transaction", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO transactions (tx_id, started_at, status, actor)
       VALUES ('tx-1', 0, 'open', 'test')`
    ).run();

    const op: OperationRow = {
      opId: "op-1",
      txId: "tx-1",
      kind: "RenameSymbol",
      paramsJson: JSON.stringify({ declaration_id: "d", new_name: "X" }),
      affectedNodeIdsJson: JSON.stringify(["d", "r1"]),
      actor: "test",
      ts: 12345,
      reasoning: null
    };
    appendOperations(db, [op]);

    expect(listOperationsByTx(db, "tx-1")).toEqual([op]);
  });
});
