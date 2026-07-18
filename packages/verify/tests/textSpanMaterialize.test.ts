import { tmpdir } from "node:os";
import path from "node:path";
import { ingest } from "@strata-code/ingest";
import {
  begin,
  insertNodes,
  openDb,
  queueIdentifierUpdate,
  queuePendingOp,
  queueTextSpanEdit
} from "@strata-code/store";
import { describe, expect, it } from "vitest";
import { commit } from "../src/validate";

describe("text-span materialization", () => {
  it("shifts identifier offsets when a statement has text-span and identifier edits", () => {
    const ingested = ingest(
      "export function f(a: number): number {\n  return a;\n}\n",
      path.join(tmpdir(), "strata-span-materialize.ts")
    );
    const db = openDb(":memory:");
    insertNodes(db, [ingested.module, ...ingested.children]);
    const statement = ingested.children.find(
      (node) => node.kind === "FunctionDeclaration"
    );
    if (!statement) {
      throw new Error("missing function declaration");
    }

    const aIdentifiers = ingested.children.filter((node) => {
      if (node.kind !== "Identifier" || node.parentId !== statement.id) {
        return false;
      }
      const payload = JSON.parse(node.payload) as { text: string };
      return payload.text === "a";
    });
    expect(aIdentifiers).toHaveLength(2);

    const tx = begin(db, "test");
    const insertAt = statement.payload.indexOf("): number");
    queueTextSpanEdit(tx, statement.id, {
      start: insertAt,
      end: insertAt,
      oldText: "",
      newText: ", tz: string"
    });
    for (const identifier of aIdentifiers) {
      queueIdentifierUpdate(tx, identifier.id, "value");
    }
    queuePendingOp(tx, {
      kind: "TestTextSpanAndRename",
      paramsJson: "{}",
      affectedNodeIdsJson: JSON.stringify([
        statement.id,
        ...aIdentifiers.map((node) => node.id)
      ]),
      reasoning: null
    });

    expect(commit(db, tx)).toEqual({ ok: true });

    const updatedStatement = db
      .prepare(`SELECT payload FROM nodes WHERE id = ?`)
      .get(statement.id) as { payload: string };
    expect(updatedStatement.payload).toBe(
      "export function f(value: number, tz: string): number {\n  return value;\n}"
    );

    const identifiers = db
      .prepare(
        `SELECT payload FROM nodes WHERE parent_id = ? AND kind = 'Identifier'`
      )
      .all(statement.id) as Array<{ payload: string }>;
    for (const row of identifiers) {
      const payload = JSON.parse(row.payload) as {
        text: string;
        offset: number;
      };
      expect(
        updatedStatement.payload.slice(
          payload.offset,
          payload.offset + payload.text.length
        )
      ).toBe(payload.text);
    }

    db.close();
  });
});
