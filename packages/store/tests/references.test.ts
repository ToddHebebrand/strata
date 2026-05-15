import { describe, expect, it } from "vitest";
import { insertNodes } from "../src/nodes";
import {
  getReferenceFrom,
  getReferencesByTo,
  insertReferences,
  type Reference
} from "../src/references";
import { openDb } from "../src/schema";

describe("node_references", () => {
  it("round-trips references with a from->to mapping and inverse lookup", () => {
    const db = openDb(":memory:");
    insertNodes(db, [
      { id: "decl", kind: "Identifier", parentId: null, childIndex: 0, payload: "" },
      { id: "ref1", kind: "Identifier", parentId: null, childIndex: 1, payload: "" },
      { id: "ref2", kind: "Identifier", parentId: null, childIndex: 2, payload: "" }
    ]);

    const refs: Reference[] = [
      { fromNodeId: "ref1", toNodeId: "decl", kind: "type" },
      { fromNodeId: "ref2", toNodeId: "decl", kind: "type" }
    ];
    insertReferences(db, refs);

    expect(getReferencesByTo(db, "decl")).toEqual(expect.arrayContaining(refs));
    expect(getReferenceFrom(db, "ref1")).toEqual(refs[0]);
    expect(getReferenceFrom(db, "missing")).toBeUndefined();
  });
});
