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
import { resolveCallsites } from "../src/callsites";
import { buildDeclarationEmbeddingText } from "../src/embed";
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

    // The meaningful assertion is on fromNodeId: each reference site must be
    // an Identifier whose text is "parse" (the call-site usage in `caller`),
    // not a JSDoc @param tag word. toNodeId is the same for all rows by
    // construction (getReferencesByTo filters by it), so checking it would be
    // a tautology.
    function payloadText(nodeId: string): string | undefined {
      const row = db
        .prepare(`SELECT payload FROM nodes WHERE id = ?`)
        .get(nodeId) as { payload: string } | undefined;
      if (!row) return undefined;
      try {
        return (JSON.parse(row.payload) as { text?: string }).text;
      } catch {
        return undefined;
      }
    }

    for (const ref of refs) {
      // The call-site identifier must spell "parse", not "param".
      expect(payloadText(ref.fromNodeId)).toBe("parse");

      // The call site must live inside the `caller` function, not somewhere else.
      // Walk up parent_id until we hit a FunctionDeclaration or null.
      let ancestorId: string | null = ref.fromNodeId;
      let foundCallerAncestor = false;
      while (ancestorId !== null) {
        const ancestor = db
          .prepare(`SELECT kind, payload, parent_id FROM nodes WHERE id = ?`)
          .get(ancestorId) as { kind: string; payload: string; parent_id: string | null } | undefined;
        if (!ancestor) break;
        if (ancestor.kind === "FunctionDeclaration") {
          // The enclosing function's name identifier should be "caller".
          const nameIdentRow = db
            .prepare(
              `SELECT payload FROM nodes WHERE parent_id = ? AND kind = 'Identifier' ORDER BY child_index ASC LIMIT 1`
            )
            .get(ancestorId) as { payload: string } | undefined;
          if (nameIdentRow) {
            try {
              const nameText = (JSON.parse(nameIdentRow.payload) as { text?: string }).text;
              if (nameText === "caller") {
                foundCallerAncestor = true;
              }
            } catch {
              // ignore parse error
            }
          }
          break;
        }
        ancestorId = ancestor.parent_id;
      }
      expect(foundCallerAncestor).toBe(true);
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

describe("buildDeclarationEmbeddingText with JSDoc'd declarations (Fix-B assertion 8)", () => {
  it("embedding text for parse contains 'parse' as name, not 'param'", () => {
    const db = seedJsdocDb();

    const parseDecls = find_declarations(db, { name: "parse", kind: "function" });
    expect(parseDecls).toHaveLength(1);
    const parseDecl = parseDecls[0]!;

    const text = buildDeclarationEmbeddingText(db, parseDecl.id);

    // The name line must say "parse", not "param" (the JSDoc @param tag word).
    expect(text).toContain("name: parse");
    expect(text).not.toContain("name: param");

    db.close();
  });
});

describe("resolveCallsites with JSDoc'd declarations (Fix-B assertion 9)", () => {
  it("callsites of parse surface the call from caller, not a JSDoc identifier", () => {
    const db = seedJsdocDb();

    const parseDecls = find_declarations(db, { name: "parse", kind: "function" });
    expect(parseDecls).toHaveLength(1);
    const parseDecl = parseDecls[0]!;

    const result = resolveCallsites(db, parseDecl.id);

    // The call `parse("x")` inside `caller` must appear as a direct callsite.
    expect(result.callsites.length).toBeGreaterThanOrEqual(1);
    // No JSDoc identifier should have been misrouted as an unresolved reference
    // or a spurious callsite.
    expect(result.unresolvedReferences).toHaveLength(0);

    // The callsite's statementId must belong to a node whose ancestor is the
    // `caller` function, not the `parse` declaration or a JSDoc node.
    const firstCallsite = result.callsites[0]!;
    const statementNode = db
      .prepare(`SELECT kind, parent_id FROM nodes WHERE id = ?`)
      .get(firstCallsite.statementId) as { kind: string; parent_id: string | null } | undefined;
    expect(statementNode).toBeDefined();
    // Walk up to find the enclosing FunctionDeclaration.
    let ancestorId: string | null = firstCallsite.statementId;
    let enclosingFnName: string | null = null;
    while (ancestorId !== null) {
      const ancestor = db
        .prepare(`SELECT kind, parent_id FROM nodes WHERE id = ?`)
        .get(ancestorId) as { kind: string; parent_id: string | null } | undefined;
      if (!ancestor) break;
      if (ancestor.kind === "FunctionDeclaration") {
        // Get the name identifier of this function declaration.
        const nameIdent = db
          .prepare(
            `SELECT payload FROM nodes WHERE parent_id = ? AND kind = 'Identifier' ORDER BY child_index ASC LIMIT 1`
          )
          .get(ancestorId) as { payload: string } | undefined;
        if (nameIdent) {
          try {
            enclosingFnName = (JSON.parse(nameIdent.payload) as { text?: string }).text ?? null;
          } catch {
            // ignore
          }
        }
        break;
      }
      ancestorId = ancestor.parent_id;
    }
    expect(enclosingFnName).toBe("caller");

    db.close();
  });
});
