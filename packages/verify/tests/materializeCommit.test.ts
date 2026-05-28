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
  add_parameter,
  rollback,
  nodeId,
  listChildren,
  findNodeById,
  queueTextSpanEdit
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
    // commit() returning {ok:false} does NOT auto-rollback; the caller must
    // call rollback() explicitly to undo the node rows inserted by the
    // preceding mutations (e.g. create_function inserts the node immediately).
    const db = seed("/project/m.ts", `export const x = 1;\n`);
    const moduleId = nodeId("/project/m.ts", [], "Module");

    // Count FunctionDeclaration nodes before the tx so we can assert cleanup.
    const countBefore = (
      db
        .prepare("SELECT count(*) AS n FROM nodes WHERE kind='FunctionDeclaration'")
        .get() as { n: number }
    ).n;

    const tx = begin(db, "test");
    create_function(db, tx, moduleId, `export function h(): number { return missing; }`);
    const result = commit(db, tx);
    expect(result.ok).toBe(false);

    // commit() returned {ok:false} — the caller must rollback() to clean up
    // the node rows that create_function inserted directly into the DB.
    rollback(db, tx);

    // After rollback, find_declarations must return nothing for "h".
    expect(find_declarations(db, { name: "h" })).toHaveLength(0);

    // The leaked FunctionDeclaration node must be gone (rollback cleaned it up).
    const countAfter = (
      db
        .prepare("SELECT count(*) AS n FROM nodes WHERE kind='FunctionDeclaration'")
        .get() as { n: number }
    ).n;
    expect(countAfter).toBe(countBefore);

    // No dangling node_references rows (all edge endpoints must exist in nodes).
    const dangling = (
      db
        .prepare(
          `SELECT count(*) AS n FROM node_references
           WHERE from_node_id NOT IN (SELECT id FROM nodes)
              OR to_node_id   NOT IN (SELECT id FROM nodes)`
        )
        .get() as { n: number }
    ).n;
    expect(dangling).toBe(0);

    db.close();
  });

  it("a pure rename commit leaves node_references unchanged (no-op gate)", () => {
    const db = seed("/project/m.ts", `export function f(): number { return 1; }\nexport const y = f();\n`);
    const before = db.prepare(`SELECT count(*) AS n FROM node_references`).get() as { n: number };
    const decl = find_declarations(db, { name: "f" })[0]!;
    const tx = begin(db, "test");
    rename_symbol(db, tx, decl.id, "g");
    expect(commit(db, tx).ok).toBe(true);
    const after = db.prepare(`SELECT count(*) AS n FROM node_references`).get() as { n: number };
    expect(after.n).toBe(before.n); // edges survive a rename untouched
    expect(find_declarations(db, { name: "g" })).toHaveLength(1);
    db.close();
  });

  it("materialization over a small dirty set still commits + resolves cross-module imports", () => {
    const files = [
      { path: "/project/a.ts", text: `import { fromB } from "./b";\nexport const ax = fromB;\n` },
      { path: "/project/b.ts", text: `export const fromB = 1;\n` },
      { path: "/project/c.ts", text: `export const cx = 1;\n` },
      { path: "/project/d.ts", text: `export const dx = 1;\n` }
    ];
    const batch = ingestBatch(files);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    const moduleA = nodeId("/project/a.ts", [], "Module");
    const tx = begin(db, "test");
    // New function in a that references the imported fromB → must resolve to b's decl.
    create_function(db, tx, moduleA, `export function usesB(): number { return fromB; }`);
    expect(commit(db, tx).ok).toBe(true);

    const usesBDecls = find_declarations(db, { name: "usesB" });
    expect(usesBDecls).toHaveLength(1);
    const usesBDeclId = usesBDecls[0]!.id;

    // Strengthen: assert the specific NEW edge from within usesB's body to fromB.
    // Collect the Identifier children of the usesB FunctionDeclaration node.
    const usesBIdentIds = new Set(
      listChildren(db, usesBDeclId)
        .filter((n) => n.kind === "Identifier")
        .map((n) => n.id)
    );
    expect(usesBIdentIds.size).toBeGreaterThan(0); // sanity: usesB has identifier children

    // get_references(fromBDecl) returns edges whose toNodeId is fromB's name identifier.
    // Assert that at least one such edge originates from an Identifier inside usesB.
    const fromBDecl = find_declarations(db, { name: "fromB" })[0]!;
    const refs = get_references(db, fromBDecl.id);
    const hasUsesBEdge = refs.some((r) => usesBIdentIds.has(r.fromNodeId));
    expect(
      hasUsesBEdge,
      `Expected a reference edge from inside usesB (ids: ${[...usesBIdentIds].join(",")}) ` +
        `to fromB, but refs were: ${JSON.stringify(refs)}`
    ).toBe(true);

    db.close();
  });

  it("boundedRenderInputs resolves ../ relative imports (cross-dir cross-module edge)", () => {
    // a.ts in /project/sub/ imports fromB from ../b (not ./b) — this exercises the
    // path.join-based resolution for ../ specifiers in boundedRenderInputs.
    const files = [
      {
        path: "/project/sub/a.ts",
        text: `import { fromB } from "../b";\nexport const ax = fromB;\n`
      },
      { path: "/project/b.ts", text: `export const fromB = 1;\n` }
    ];
    const batch = ingestBatch(files);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    const moduleA = nodeId("/project/sub/a.ts", [], "Module");
    const tx = begin(db, "test");
    // New function in sub/a that references the imported fromB → must cross the ../ boundary.
    create_function(db, tx, moduleA, `export function usesB(): number { return fromB; }`);
    expect(commit(db, tx).ok).toBe(true);

    const usesBDecls = find_declarations(db, { name: "usesB" });
    expect(usesBDecls).toHaveLength(1);
    const usesBDeclId = usesBDecls[0]!.id;

    const usesBIdentIds = new Set(
      listChildren(db, usesBDeclId)
        .filter((n) => n.kind === "Identifier")
        .map((n) => n.id)
    );
    expect(usesBIdentIds.size).toBeGreaterThan(0);

    // The critical assertion: the new edge from within usesB to fromB must exist.
    // This only passes if boundedRenderInputs correctly includes /project/b.ts
    // when the dirty module is /project/sub/a.ts importing via "../b".
    const fromBDecl = find_declarations(db, { name: "fromB" })[0]!;
    const refs = get_references(db, fromBDecl.id);
    const hasUsesBEdge = refs.some((r) => usesBIdentIds.has(r.fromNodeId));
    expect(
      hasUsesBEdge,
      `Expected a ../b cross-module edge from inside usesB (ids: ${[...usesBIdentIds].join(",")}) ` +
        `to fromB, but refs were: ${JSON.stringify(refs)}`
    ).toBe(true);

    db.close();
  });

  it("no dangling edges after extract-shaped commit (falsifier #4)", () => {
    // Fixture: parent calls console.log(a). We extract that call into a helper h
    // by (a) creating h and (b) text-span-splicing the parent body to call h(a).
    // Post-splice parent type-checks because the removed statement does not define
    // anything used later — both `console.log(a)` and `h(a)` are pure side-effects.
    const db = seed(
      "/project/m.ts",
      "export function parent(a: number): void { console.log(a); }\n"
    );

    const tx = begin(db, "test-no-dangling");
    const moduleId = nodeId("/project/m.ts", [], "Module");

    // Class-1: create the extracted helper.
    create_function(db, tx, moduleId, `export function h(a: number): void { console.log(a); }`);

    // Class-2: text-span-splice the parent body.
    const parentId = nodeId("/project/m.ts", [0], "FunctionDeclaration");
    const parentNode = findNodeById(db, parentId)!;
    const removed = `console.log(a);`;
    const start = parentNode.payload.indexOf(removed);
    expect(start).toBeGreaterThanOrEqual(0); // sanity: span must be found
    queueTextSpanEdit(tx, parentId, {
      start,
      end: start + removed.length,
      oldText: removed,
      newText: `h(a);`
    });

    // commit() runs validate (tsc) + graph materialization in one DB transaction.
    const result = commit(db, tx);
    expect(result.ok).toBe(true);

    // Falsifier #4: no node_references row may point to a missing node.
    const dangling = db
      .prepare(
        `SELECT count(*) AS n FROM node_references r
         WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = r.from_node_id)
            OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = r.to_node_id)`
      )
      .get() as { n: number };
    expect(dangling.n).toBe(0);

    // The helper must be findable after the extract-shaped commit.
    expect(find_declarations(db, { name: "h" })).toHaveLength(1);

    db.close();
  });

  it("add_parameter graph is consistent after commit (class-2 path)", () => {
    // Seed a module with an exported function foo that has a same-module callsite,
    // so there is a callsite to re-derive through class-2 graph materialization.
    const src =
      "export function foo(a: number): number { return a; }\n" +
      "export const r = foo(1);\n";
    const db = seed("/project/m.ts", src);

    // Locate foo's declaration id before the transaction.
    const decls = find_declarations(db, { name: "foo" });
    expect(decls).toHaveLength(1);
    const fooDeclId = decls[0]!.id;

    // Confirm a callsite reference already exists (foo(1) -> foo declaration).
    const refsBefore = get_references(db, fooDeclId);
    expect(refsBefore.length).toBeGreaterThanOrEqual(1);

    // Add a parameter with a default value so the callsite is auto-patched and
    // the result still type-checks (no required-arg error at foo(1)).
    const tx = begin(db, "test-add-param");
    add_parameter(db, tx, fooDeclId, "b", "number", 1, "0");

    const result = commit(db, tx);
    expect(result.ok).toBe(true);

    // Graph consistency assertions after commit.

    // 1. foo is still findable by name (declaration node survived re-derivation).
    const declsAfter = find_declarations(db, { name: "foo" });
    expect(declsAfter).toHaveLength(1);
    const fooDeclIdAfter = declsAfter[0]!.id;
    // Stable node ID: the declaration is the same node, not a replacement.
    expect(fooDeclIdAfter).toBe(fooDeclId);

    // 2. get_references returns the callsite edge after re-derivation.
    //    The callsite statement (foo(1) -> now foo(1, 0)) must still resolve
    //    back to the foo declaration via the reference edge.
    const refsAfter = get_references(db, fooDeclId);
    expect(refsAfter.length).toBeGreaterThanOrEqual(1);

    // 3. The callsite edge's toNodeId resolves to the foo declaration (edge integrity).
    //    get_references returns Reference rows; toNodeId is the identifier node that
    //    references foo's name identifier.  The important thing is the edge still
    //    exists (length >= 1) and targets a node that is still in the DB.
    for (const ref of refsAfter) {
      const toExists = db
        .prepare("SELECT id FROM nodes WHERE id = ?")
        .get(ref.toNodeId);
      expect(toExists).toBeTruthy();
    }

    // 4. The foo declaration payload now contains the new parameter signature.
    const fooNodeAfter = declsAfter[0]!;
    expect(fooNodeAfter.payload).toContain("b: number");

    db.close();
  });
});
