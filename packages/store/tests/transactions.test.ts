import { describe, expect, it } from "vitest";
import { openDb } from "../src/schema";
import {
  begin,
  commitWithoutValidate,
  getOverlay,
  queueIdentifierUpdate,
  queuePendingOp,
  rollback,
  startupRecoverOpenTransactions
} from "../src/transactions";

describe("transactions", () => {
  it("opens a transaction and persists an open row", () => {
    const db = openDb(":memory:");
    const tx = begin(db, "test-actor");

    const row = db
      .prepare("SELECT tx_id, status, actor FROM transactions WHERE tx_id = ?")
      .get(tx.id);

    expect(row).toEqual({ tx_id: tx.id, status: "open", actor: "test-actor" });
  });

  it("rolls back: marks rolled_back and drops the overlay", () => {
    const db = openDb(":memory:");
    const tx = begin(db, "test");

    queueIdentifierUpdate(tx, "id-1", "NewText");
    rollback(db, tx);

    const row = db
      .prepare("SELECT status FROM transactions WHERE tx_id = ?")
      .get(tx.id);
    expect(row).toEqual({ status: "rolled_back" });
    expect(() => getOverlay(tx)).toThrow();
  });

  it("commitWithoutValidate marks committed and flushes overlay rows", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO nodes (id, kind, parent_id, child_index, payload)
       VALUES ('i-1', 'Identifier', 'stmt-1', 0, '{"text":"Old","offset":0}')`
    ).run();
    const tx = begin(db, "test");

    queueIdentifierUpdate(tx, "i-1", "New");
    queuePendingOp(tx, {
      kind: "RenameSymbol",
      paramsJson: JSON.stringify({ new_name: "New" }),
      affectedNodeIdsJson: JSON.stringify(["i-1"]),
      reasoning: null
    });
    commitWithoutValidate(db, tx);

    const row = db
      .prepare("SELECT payload FROM nodes WHERE id = ?")
      .get("i-1") as { payload: string };
    expect(JSON.parse(row.payload)).toEqual({ text: "New", offset: 0 });

    const ops = db
      .prepare("SELECT kind FROM operations WHERE tx_id = ?")
      .all(tx.id);
    expect(ops).toEqual([{ kind: "RenameSymbol" }]);

    const txRow = db
      .prepare("SELECT status FROM transactions WHERE tx_id = ?")
      .get(tx.id);
    expect(txRow).toEqual({ status: "committed" });
  });

  it("startupRecoverOpenTransactions marks orphans as rolled_back", () => {
    const db = openDb(":memory:");
    db.prepare(
      `INSERT INTO transactions (tx_id, started_at, status, actor)
       VALUES ('orphan', 0, 'open', 'crashed-process')`
    ).run();

    startupRecoverOpenTransactions(db);

    const row = db
      .prepare("SELECT status, committed_at FROM transactions WHERE tx_id = 'orphan'")
      .get() as { status: string; committed_at: number };
    expect(row.status).toEqual("rolled_back");
    expect(row.committed_at).toBeGreaterThan(0);
  });

  it("re-committing a committed transaction throws", () => {
    const db = openDb(":memory:");
    const tx = begin(db, "test");

    commitWithoutValidate(db, tx);

    expect(() => commitWithoutValidate(db, tx)).toThrow(/no overlay|not open/);
  });
});
