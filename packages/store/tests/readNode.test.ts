import { describe, expect, it } from "vitest";
import { insertNodes, openDb, read_node, readNode } from "../src/index";

describe("readNode", () => {
  it("returns the node alone when includeChildren is false/omitted", () => {
    const db = openDb(":memory:");
    insertNodes(db, [
      {
        id: "m",
        kind: "Module",
        parentId: null,
        childIndex: null,
        payload: "x.ts"
      },
      {
        id: "s1",
        kind: "InterfaceDeclaration",
        parentId: "m",
        childIndex: 0,
        payload: "export interface User {}"
      }
    ]);
    const result = readNode(db, "s1");
    expect(result?.node.id).toBe("s1");
    expect(result?.children).toBeUndefined();
    db.close();
  });

  it("returns shallow children when includeChildren is true", () => {
    const db = openDb(":memory:");
    insertNodes(db, [
      {
        id: "m",
        kind: "Module",
        parentId: null,
        childIndex: null,
        payload: "x.ts"
      },
      {
        id: "s1",
        kind: "InterfaceDeclaration",
        parentId: "m",
        childIndex: 0,
        payload: "export interface User {}"
      },
      {
        id: "i1",
        kind: "Identifier",
        parentId: "s1",
        childIndex: 0,
        payload: JSON.stringify({ text: "User", offset: 17 })
      }
    ]);
    const result = readNode(db, "s1", { includeChildren: true });
    expect(result?.children?.map((c) => c.id)).toEqual(["i1"]);
    db.close();
  });

  it("returns undefined for an unknown id", () => {
    const db = openDb(":memory:");
    expect(readNode(db, "missing")).toBeUndefined();
    db.close();
  });

  it("exposes the same function under the snake_case name", () => {
    expect(read_node).toBe(readNode);
  });
});
