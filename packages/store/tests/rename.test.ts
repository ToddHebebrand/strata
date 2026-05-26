import { describe, expect, it } from "vitest";
import {
  begin,
  commitWithoutValidate,
  insertNodes,
  insertReferences,
  openDb,
  rename_symbol
} from "../src/index";

function seedRenameGraph() {
  const db = openDb(":memory:");
  insertNodes(db, [
    {
      id: "module-types",
      kind: "Module",
      parentId: null,
      childIndex: null,
      payload: "/work/src/types/user.ts"
    },
    {
      id: "decl",
      kind: "InterfaceDeclaration",
      parentId: "module-types",
      childIndex: 0,
      payload: "export interface User { id: string; }\n"
    },
    {
      id: "decl-ident",
      kind: "Identifier",
      parentId: "decl",
      childIndex: 0,
      payload: JSON.stringify({ text: "User", offset: 17 })
    },
    {
      id: "module-consumer",
      kind: "Module",
      parentId: null,
      childIndex: null,
      payload: "/work/src/consumer.ts"
    },
    {
      id: "import",
      kind: "ImportDeclaration",
      parentId: "module-consumer",
      childIndex: 0,
      payload: 'import type { User } from "./types/user.ts";\n'
    },
    {
      id: "import-ident",
      kind: "Identifier",
      parentId: "import",
      childIndex: 0,
      payload: JSON.stringify({ text: "User", offset: 14 })
    },
    {
      id: "fn",
      kind: "FunctionDeclaration",
      parentId: "module-consumer",
      childIndex: 1,
      payload: "export function f(user: User): User { return user; }\n"
    },
    {
      id: "param-ident",
      kind: "Identifier",
      parentId: "fn",
      childIndex: 0,
      payload: JSON.stringify({ text: "user", offset: 18 })
    },
    {
      id: "param-type-ident",
      kind: "Identifier",
      parentId: "fn",
      childIndex: 1,
      payload: JSON.stringify({ text: "User", offset: 24 })
    },
    {
      id: "return-type-ident",
      kind: "Identifier",
      parentId: "fn",
      childIndex: 2,
      payload: JSON.stringify({ text: "User", offset: 31 })
    }
  ]);
  insertReferences(db, [
    { fromNodeId: "import-ident", toNodeId: "decl-ident", kind: "type" },
    { fromNodeId: "param-type-ident", toNodeId: "decl-ident", kind: "type" },
    { fromNodeId: "return-type-ident", toNodeId: "decl-ident", kind: "type" }
  ]);
  return db;
}

describe("rename_symbol", () => {
  it("renames the declaration and all references in a single transaction", () => {
    const db = seedRenameGraph();
    const tx = begin(db, "test");

    rename_symbol(db, tx, "decl", "Account");
    commitWithoutValidate(db, tx);

    const identifierPayloads = db
      .prepare(`SELECT id, payload FROM nodes WHERE kind = 'Identifier' ORDER BY id`)
      .all() as Array<{ id: string; payload: string }>;
    const textsById = new Map(
      identifierPayloads.map((row) => [
        row.id,
        (JSON.parse(row.payload) as { text: string }).text
      ])
    );

    expect(textsById.get("decl-ident")).toEqual("Account");
    expect(textsById.get("import-ident")).toEqual("Account");
    expect(textsById.get("param-type-ident")).toEqual("Account");
    expect(textsById.get("return-type-ident")).toEqual("Account");
    expect(textsById.get("param-ident")).toEqual("user");

    const ops = db
      .prepare(
        `SELECT tx_id, kind, params_json, affected_node_ids_json FROM operations`
      )
      .all() as Array<{
      tx_id: string;
      kind: string;
      params_json: string;
      affected_node_ids_json: string;
    }>;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.tx_id).toEqual(tx.id);
    expect(ops[0]!.kind).toEqual("RenameSymbol");
    expect(JSON.parse(ops[0]!.params_json)).toEqual({
      declaration_id: "decl",
      old_name: "User",
      new_name: "Account"
    });
    expect(JSON.parse(ops[0]!.affected_node_ids_json).sort()).toEqual([
      "decl-ident",
      "import-ident",
      "param-type-ident",
      "return-type-ident"
    ]);
  });

  it("is a no-op when newName matches the existing identifier text", () => {
    const db = seedRenameGraph();
    const tx = begin(db, "test");

    rename_symbol(db, tx, "decl", "User");
    commitWithoutValidate(db, tx);

    const ops = db.prepare(`SELECT * FROM operations`).all();
    expect(ops).toHaveLength(0);
  });

  it("throws when newName is not a valid TypeScript identifier", () => {
    const db = seedRenameGraph();
    const tx = begin(db, "test");

    expect(() => rename_symbol(db, tx, "decl", "1notValid")).toThrow(
      /Invalid TypeScript identifier/
    );
  });

  it("throws when the target node is not a declaration", () => {
    const db = seedRenameGraph();
    const tx = begin(db, "test");

    expect(() => rename_symbol(db, tx, "decl-ident", "Account")).toThrow(
      /is not a declaration/
    );
  });

  // Regression test for 2026-05-26 kind-mapping symmetric fix.
  // `export const X` is persisted as kind "FirstStatement" by ingest.
  // The fix in rename.ts:17 adds "FirstStatement" to DECLARATION_KINDS so
  // const decls are renameable. Without the fix, the test below would
  // throw "is not a declaration".
  it("renames an exported const declaration (FirstStatement kind) and its single reference", () => {
    const db = openDb(":memory:");
    insertNodes(db, [
      {
        id: "module-config",
        kind: "Module",
        parentId: null,
        childIndex: null,
        payload: "/work/src/config.ts"
      },
      {
        id: "decl",
        kind: "FirstStatement",
        parentId: "module-config",
        childIndex: 0,
        payload: 'export const ZONE = "UTC";\n'
      },
      {
        id: "decl-ident",
        kind: "Identifier",
        parentId: "decl",
        childIndex: 0,
        payload: JSON.stringify({ text: "ZONE", offset: 13 })
      },
      {
        id: "module-consumer",
        kind: "Module",
        parentId: null,
        childIndex: null,
        payload: "/work/src/consumer.ts"
      },
      {
        id: "import",
        kind: "ImportDeclaration",
        parentId: "module-consumer",
        childIndex: 0,
        payload: 'import { ZONE } from "./config.ts";\n'
      },
      {
        id: "import-ident",
        kind: "Identifier",
        parentId: "import",
        childIndex: 0,
        payload: JSON.stringify({ text: "ZONE", offset: 9 })
      }
    ]);
    insertReferences(db, [
      { fromNodeId: "import-ident", toNodeId: "decl-ident", kind: "value" }
    ]);

    const tx = begin(db, "test");
    rename_symbol(db, tx, "decl", "TIMEZONE");
    commitWithoutValidate(db, tx);

    const identifierPayloads = db
      .prepare(`SELECT id, payload FROM nodes WHERE kind = 'Identifier' ORDER BY id`)
      .all() as Array<{ id: string; payload: string }>;
    const textsById = new Map(
      identifierPayloads.map((row) => [
        row.id,
        (JSON.parse(row.payload) as { text: string }).text
      ])
    );

    expect(textsById.get("decl-ident")).toEqual("TIMEZONE");
    expect(textsById.get("import-ident")).toEqual("TIMEZONE");
  });
});
