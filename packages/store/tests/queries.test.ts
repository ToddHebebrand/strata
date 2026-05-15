import { describe, expect, it } from "vitest";
import { insertNodes } from "../src/nodes";
import { find_declarations, get_references } from "../src/queries";
import { insertReferences } from "../src/references";
import { openDb } from "../src/schema";

describe("find_declarations", () => {
  it("returns interface declarations whose identifier child has matching text", () => {
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
        id: "s",
        kind: "InterfaceDeclaration",
        parentId: "m",
        childIndex: 0,
        payload: "export interface User {}\n"
      },
      {
        id: "i",
        kind: "Identifier",
        parentId: "s",
        childIndex: null,
        payload: JSON.stringify({ text: "User", offset: 17 })
      }
    ]);

    const found = find_declarations(db, { name: "User", kind: "interface" });

    expect(found.map((declaration) => declaration.id)).toEqual(["s"]);
  });

  it("returns [] for an unknown name", () => {
    const db = openDb(":memory:");

    expect(find_declarations(db, { name: "Missing" })).toEqual([]);
  });
});

describe("get_references", () => {
  it("returns all references whose to_node_id matches the declaration identifier", () => {
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
        payload: "export interface User {}\n"
      },
      {
        id: "i1",
        kind: "Identifier",
        parentId: "s1",
        childIndex: null,
        payload: JSON.stringify({ text: "User", offset: 17 })
      },
      {
        id: "s2",
        kind: "FunctionDeclaration",
        parentId: "m",
        childIndex: 1,
        payload: "function f(u: User): void {}\n"
      },
      {
        id: "i2",
        kind: "Identifier",
        parentId: "s2",
        childIndex: null,
        payload: JSON.stringify({ text: "User", offset: 14 })
      }
    ]);
    insertReferences(db, [{ fromNodeId: "i2", toNodeId: "i1", kind: "type" }]);

    expect(get_references(db, "s1").map((reference) => reference.fromNodeId)).toEqual([
      "i2"
    ]);
  });
});
