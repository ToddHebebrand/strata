import { describe, expect, it } from "vitest";
import { openDb } from "../src/schema";
import { insertNodes } from "../src/nodes";
import {
  begin,
  commitWithoutValidate,
  getOverlay,
  queueTextSpanEdit
} from "../src/transactions";

describe("textSpanMutations overlay", () => {
  it("queues text-span edits keyed by statement id on an open tx", () => {
    const db = openDb(":memory:");
    const tx = begin(db, "test");
    queueTextSpanEdit(tx, "stmt-1", {
      start: 3,
      end: 3,
      oldText: "",
      newText: ", tz: string"
    });
    queueTextSpanEdit(tx, "stmt-1", {
      start: 10,
      end: 16,
      oldText: "string",
      newText: "Role"
    });
    const overlay = getOverlay(tx);
    expect(overlay.textSpanMutations.get("stmt-1")).toHaveLength(2);
    db.close();
  });

  it("throws when queueing on a non-open transaction", () => {
    const db = openDb(":memory:");
    const tx = begin(db, "test");
    getOverlay(tx).status = "rolled_back";
    expect(() =>
      queueTextSpanEdit(tx, "s", { start: 0, end: 0, oldText: "", newText: "x" })
    ).toThrow();
    db.close();
  });

  it("materializes text-span edits on commitWithoutValidate", () => {
    const db = openDb(":memory:");
    const payload = "export function f(a: number): string { return a; }\n";
    insertNodes(db, [
      {
        id: "m",
        kind: "Module",
        parentId: null,
        childIndex: null,
        payload: "sample.ts"
      },
      {
        id: "stmt-1",
        kind: "FunctionDeclaration",
        parentId: "m",
        childIndex: 0,
        payload
      }
    ]);
    const tx = begin(db, "test");
    const start = payload.indexOf("string");
    queueTextSpanEdit(tx, "stmt-1", {
      start,
      end: start + "string".length,
      oldText: "string",
      newText: "number"
    });

    commitWithoutValidate(db, tx);

    const row = db
      .prepare(`SELECT payload FROM nodes WHERE id = ?`)
      .get("stmt-1") as { payload: string };
    expect(row.payload).toBe(
      "export function f(a: number): number { return a; }\n"
    );
    db.close();
  });
});
