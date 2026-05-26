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

  // Regression test for the 2026-05-26 kind-mapping bug. Ingest stores
  // `export const X` as kind "FirstStatement" (TypeScript SyntaxKind alias
  // for VariableStatement, value 244). Prior mapping `variable →
  // "VariableStatement"` missed every const decl, both with `kind:"variable"`
  // and with no kind (since the no-kind branch uses Object.values of the
  // mapping). Fix is in queries.ts:22; this test guards against regression.
  describe("const declarations (FirstStatement kind)", () => {
    function seedConstZone() {
      const db = openDb(":memory:");
      insertNodes(db, [
        {
          id: "m",
          kind: "Module",
          parentId: null,
          childIndex: null,
          payload: "/work/src/config.ts"
        },
        {
          id: "s",
          kind: "FirstStatement",
          parentId: "m",
          childIndex: 0,
          payload: 'export const ZONE = "UTC";\n'
        },
        {
          id: "i",
          kind: "Identifier",
          parentId: "s",
          childIndex: null,
          payload: JSON.stringify({ text: "ZONE", offset: 13 })
        }
      ]);
      return db;
    }

    it("surfaces an exported const via {name, kind:'variable'}", () => {
      const db = seedConstZone();
      const found = find_declarations(db, { name: "ZONE", kind: "variable" });
      expect(found.map((d) => d.id)).toEqual(["s"]);
    });

    it("surfaces an exported const via bare {name} (no kind filter)", () => {
      const db = seedConstZone();
      const found = find_declarations(db, { name: "ZONE" });
      expect(found.map((d) => d.id)).toEqual(["s"]);
    });
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
