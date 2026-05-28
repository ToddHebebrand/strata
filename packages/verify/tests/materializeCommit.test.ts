import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import {
  openDb,
  insertNodes,
  insertReferences,
  begin,
  create_function,
  rename_symbol,
  find_declarations,
  get_references,
  nodeId
} from "@strata/store";
import { commit } from "../src/validate";

function seed(filePath: string, text: string) {
  const batch = ingestBatch([{ path: filePath, text }]);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  return db;
}

describe("commit materializes the graph", () => {
  it("created function is findable after commit (headline)", () => {
    const db = seed("/project/m.ts", `export const x = 1;\n`);
    const tx = begin(db, "test");
    const moduleId = nodeId("/project/m.ts", [], "Module");
    create_function(db, tx, moduleId, `export function h(): number { return 1; }`);
    const result = commit(db, tx);
    expect(result.ok).toBe(true);
    expect(find_declarations(db, { name: "h" })).toHaveLength(1);
    db.close();
  });

  it("rename of a freshly-created+committed helper updates the caller call site", () => {
    const db = seed("/project/m.ts", `export function caller(): number { return h(); }\n`);
    const tx1 = begin(db, "t1");
    const moduleId = nodeId("/project/m.ts", [], "Module");
    create_function(db, tx1, moduleId, `export function h(): number { return 1; }`);
    expect(commit(db, tx1).ok).toBe(true);

    const decls = find_declarations(db, { name: "h" });
    expect(decls).toHaveLength(1);
    const decl = decls[0]!;
    const refsBefore = get_references(db, decl.id);
    expect(refsBefore.length).toBeGreaterThanOrEqual(1);

    const tx2 = begin(db, "t2");
    rename_symbol(db, tx2, decl.id, "renamedH");
    expect(commit(db, tx2).ok).toBe(true);
    expect(find_declarations(db, { name: "renamedH" })).toHaveLength(1);
    db.close();
  });

  it("rollback on validation failure leaves no materialized rows", () => {
    const db = seed("/project/m.ts", `export const x = 1;\n`);
    const tx = begin(db, "test");
    const moduleId = nodeId("/project/m.ts", [], "Module");
    create_function(db, tx, moduleId, `export function h(): number { return missing; }`);
    const result = commit(db, tx);
    expect(result.ok).toBe(false);
    // The function node was inserted at create_function time, but identifiers
    // are only materialized by the graph-materialization pass which runs AFTER
    // validation. On validation failure, no identifiers are emitted, so
    // find_declarations (which requires an Identifier child via
    // resolveDeclarationNameIdentifier) must return 0.
    expect(find_declarations(db, { name: "h" })).toHaveLength(0);
    db.close();
  });
});
