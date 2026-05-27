/**
 * Falsifier test for the JSDoc identifier bug.
 *
 * Before the fix: `find_declarations({name:"parse"})` returned 0 hits on any
 * JSDoc'd declaration because the SQL subquery picked the lowest-offset
 * Identifier child of the declaration — which is a JSDoc @param tag word, not
 * the function name. `find_declarations({name:"param"})` could return a false
 * positive.
 *
 * Fix-B: extends this test to cover get_references, rename_symbol,
 * list_module_exports, and find_declarations_in_module — all migrated to
 * resolveDeclarationNameIdentifier.
 */

import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { find_declarations, get_references } from "../src/queries";
import {
  list_module_exports,
  find_declarations_in_module
} from "../src/discovery";
import { rename_symbol } from "../src/rename";
import {
  insertNodes,
  insertReferences,
  begin,
  commitWithoutValidate
} from "../src";
import { openDb } from "../src/schema";

const SOURCE = `/**
 * @param {string} value
 */
export function parse(value: string): string {
  return value;
}

export function caller(): string {
  return parse("x");
}
`;

function seedJsdocDb() {
  const batch = ingestBatch([{ path: "parser.ts", text: SOURCE }]);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  return db;
}

describe("find_declarations with JSDoc'd declarations", () => {
  it("finds parse by name + kind (assertion 1)", () => {
    const db = seedJsdocDb();
    const results = find_declarations(db, { name: "parse", kind: "function" });
    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("FunctionDeclaration");
    db.close();
  });

  it("finds parse by name only, no kind filter (assertion 2)", () => {
    const db = seedJsdocDb();
    const results = find_declarations(db, { name: "parse" });
    expect(results).toHaveLength(1);
    db.close();
  });

  it("does NOT match 'param' — JSDoc tag identifiers must not bleed through (assertion 3)", () => {
    const db = seedJsdocDb();
    const results = find_declarations(db, { name: "param" });
    expect(results).toHaveLength(0);
    db.close();
  });
});

describe("get_references with JSDoc'd declarations (Fix-B assertion 4)", () => {
  it("get_references on parse's declaration returns the call site in caller", () => {
    const db = seedJsdocDb();
    const parseDecls = find_declarations(db, { name: "parse", kind: "function" });
    expect(parseDecls).toHaveLength(1);
    const parseDecl = parseDecls[0]!;

    const refs = get_references(db, parseDecl.id);
    // The call `parse("x")` inside `caller` should produce at least one reference.
    expect(refs.length).toBeGreaterThanOrEqual(1);

    // Every reference's toNodeId should be the name identifier of `parse`,
    // not a JSDoc tag identifier.
    for (const ref of refs) {
      const refRow = db
        .prepare(`SELECT payload FROM nodes WHERE id = ?`)
        .get(ref.toNodeId) as { payload: string } | undefined;
      expect(refRow).toBeDefined();
      const parsed = JSON.parse(refRow!.payload) as { text?: string };
      // The identifier being referenced must be "parse", never "param".
      expect(parsed.text).toBe("parse");
    }

    db.close();
  });
});

describe("rename_symbol with JSDoc'd declarations (Fix-B assertion 5)", () => {
  it("renames parse to read — updates declaration and call site, ignores JSDoc tag words", () => {
    const db = seedJsdocDb();

    const parseDecls = find_declarations(db, { name: "parse", kind: "function" });
    expect(parseDecls).toHaveLength(1);
    const parseDecl = parseDecls[0]!;

    const tx = begin(db, "test-fix-b");
    rename_symbol(db, tx, parseDecl.id, "read");
    commitWithoutValidate(db, tx);

    // Verify the operation was recorded with old_name="parse", not "param".
    const ops = db
      .prepare(`SELECT params_json FROM operations WHERE kind = 'RenameSymbol'`)
      .all() as Array<{ params_json: string }>;
    expect(ops).toHaveLength(1);
    const params = JSON.parse(ops[0]!.params_json) as {
      old_name: string;
      new_name: string;
    };
    expect(params.old_name).toBe("parse");
    expect(params.new_name).toBe("read");

    // All affected identifier payloads that previously said "parse" should now
    // say "read". The JSDoc Identifiers (kind=Identifier, payload containing
    // "param" or the JSDoc @param tag text) must be unchanged.
    const identifiers = db
      .prepare(`SELECT id, payload FROM nodes WHERE kind = 'Identifier'`)
      .all() as Array<{ id: string; payload: string }>;

    for (const ident of identifiers) {
      let parsed: { text?: string };
      try {
        parsed = JSON.parse(ident.payload) as { text?: string };
      } catch {
        continue;
      }
      // No identifier should still carry the old name "parse".
      if (parsed.text !== undefined) {
        expect(parsed.text).not.toBe("parse");
      }
    }

    // At least one identifier should now read "read" (the declaration name ident).
    const readIdents = identifiers.filter((i) => {
      try {
        return (JSON.parse(i.payload) as { text?: string }).text === "read";
      } catch {
        return false;
      }
    });
    expect(readIdents.length).toBeGreaterThanOrEqual(1);

    db.close();
  });
});

describe("list_module_exports with JSDoc'd declarations (Fix-B assertion 6)", () => {
  it("reports exported name as 'parse', not 'param'", () => {
    const db = seedJsdocDb();

    // Find the module node.
    const modules = db
      .prepare(`SELECT id FROM nodes WHERE kind = 'Module'`)
      .all() as Array<{ id: string }>;
    expect(modules.length).toBeGreaterThanOrEqual(1);
    const moduleId = modules[0]!.id;

    const exports = list_module_exports(db, moduleId);
    const names = exports.map((e) => e.name);

    // Must include "parse" — not "param".
    expect(names).toContain("parse");
    expect(names).not.toContain("param");

    db.close();
  });
});

describe("find_declarations_in_module with JSDoc'd declarations (Fix-B assertion 7)", () => {
  it("finds parse by name in module, does not match 'param'", () => {
    const db = seedJsdocDb();

    const modules = db
      .prepare(`SELECT id FROM nodes WHERE kind = 'Module'`)
      .all() as Array<{ id: string }>;
    expect(modules.length).toBeGreaterThanOrEqual(1);
    const moduleId = modules[0]!.id;

    const found = find_declarations_in_module(db, {
      moduleId,
      name: "parse",
      kind: "FunctionDeclaration"
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("FunctionDeclaration");

    const notFound = find_declarations_in_module(db, {
      moduleId,
      name: "param",
      kind: "FunctionDeclaration"
    });
    expect(notFound).toHaveLength(0);

    db.close();
  });
});
