/**
 * Falsifier test for the JSDoc identifier bug.
 *
 * Before the fix: `find_declarations({name:"parse"})` returned 0 hits on any
 * JSDoc'd declaration because the SQL subquery picked the lowest-offset
 * Identifier child of the declaration — which is a JSDoc @param tag word, not
 * the function name. `find_declarations({name:"param"})` could return a false
 * positive.
 *
 * Fix-B deferred: get_references and rename_symbol sibling assertions will be
 * added in the Fix-B commit once resolveDeclarationNameIdentifier is wired
 * into those paths as well.
 */

import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { find_declarations } from "../src/queries";
import { insertNodes, insertReferences } from "../src";
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
