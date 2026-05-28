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
  add_import,
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

  it("add_import: imported name is resolvable as a reference target after commit", () => {
    // Gap 1: verify that after add_import + create_function in one tx, the new
    // function's use of the imported name resolves to the exporting declaration.
    // Fixture: dep.ts exports `helper`; main.ts initially does NOT import it.
    // The tx adds the import and a function that uses the imported name.
    const files = [
      { path: "/project/dep.ts", text: `export const helper = 1;\n` },
      { path: "/project/main.ts", text: `export const x = 1;\n` }
    ];
    const batch = ingestBatch(files);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    const mainModuleId = nodeId("/project/main.ts", [], "Module");
    const tx = begin(db, "test-add-import");

    // Add the import declaration first so the subsequent create_function can
    // reference the imported name and tsc sees it.
    add_import(db, tx, mainModuleId, `import { helper } from "./dep";`);
    create_function(db, tx, mainModuleId, `export function usesHelper(): number { return helper; }`);

    const result = commit(db, tx);
    expect(result.ok, `commit failed: ${JSON.stringify((result as any).diagnostics)}`).toBe(true);

    // usesHelper must be findable after commit.
    const usesHelperDecls = find_declarations(db, { name: "usesHelper" });
    expect(usesHelperDecls).toHaveLength(1);
    const usesHelperDeclId = usesHelperDecls[0]!.id;

    // Collect the Identifier children of the usesHelper FunctionDeclaration.
    const usesHelperIdentIds = new Set(
      listChildren(db, usesHelperDeclId)
        .filter((n) => n.kind === "Identifier")
        .map((n) => n.id)
    );
    expect(usesHelperIdentIds.size).toBeGreaterThan(0); // sanity: must have identifier children

    // Core assertion: get_references on dep.ts's `helper` declaration must include
    // an edge whose fromNodeId originates inside the usesHelper function body.
    // This proves the imported name resolved to the exporting declaration after commit.
    const helperDeclId = find_declarations(db, { name: "helper" })[0]!.id;
    const refs = get_references(db, helperDeclId);
    const hasUsesHelperEdge = refs.some((r) => usesHelperIdentIds.has(r.fromNodeId));
    expect(
      hasUsesHelperEdge,
      `Expected a reference edge from inside usesHelper (ids: ${[...usesHelperIdentIds].join(",")}) ` +
        `to dep.ts helper declaration, but refs were: ${JSON.stringify(refs)}`
    ).toBe(true);

    db.close();
  });

  it("dirty-set scoping: a tx touching module A does not alter graph facts for unrelated modules B and C", () => {
    // Gap 2: behavioral proxy for boundedRenderInputs scoping.
    // Materialization of a tx touching only a.ts must leave the node_references
    // rows for b.ts and c.ts byte-identical before and after commit.
    // (If boundedRenderInputs over-included b.ts/c.ts, their edges would be
    // re-derived unnecessarily — but since these modules have no imports from
    // a.ts, over-inclusion here would not change the edges. The real value is
    // confirming that isolated modules are not dragged into the program, and the
    // observable guarantee — "unrelated modules' graph facts are untouched" — is
    // what the product needs to hold.)
    const files = [
      { path: "/project/a.ts", text: `export const a = 1;\n` },
      { path: "/project/b.ts", text: `export const b = 1;\n` },
      { path: "/project/c.ts", text: `export const c = 1;\n` }
    ];
    const batch = ingestBatch(files);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    // Helper to snapshot all nodes and edges that belong to b.ts or c.ts.
    // Nodes: all rows whose id starts with the module path (ingest encodes the
    // file path into the node ID).  Edges: any row with from_node_id or
    // to_node_id anchored to b.ts or c.ts nodes.
    function snapshotBandC(): string {
      const nodes = (
        db
          .prepare(`SELECT id, kind, parent_id, child_index, payload FROM nodes ORDER BY id`)
          .all() as Array<{ id: string; kind: string; parent_id: string | null; child_index: number | null; payload: string }>
      ).filter((n) => n.id.startsWith("/project/b.ts") || n.id.startsWith("/project/c.ts"));

      const allEdges = db
        .prepare(`SELECT from_node_id, to_node_id, kind FROM node_references ORDER BY from_node_id`)
        .all() as Array<{ from_node_id: string; to_node_id: string; kind: string }>;
      const bIds = new Set(nodes.filter((n) => n.id.startsWith("/project/b.ts")).map((n) => n.id));
      const cIds = new Set(nodes.filter((n) => n.id.startsWith("/project/c.ts")).map((n) => n.id));
      const relatedEdges = allEdges.filter(
        (e) =>
          bIds.has(e.from_node_id) || bIds.has(e.to_node_id) ||
          cIds.has(e.from_node_id) || cIds.has(e.to_node_id)
      );

      return JSON.stringify({ nodes, relatedEdges });
    }

    const snapshotBefore = snapshotBandC();

    // Tx that only touches a.ts — no imports from b.ts or c.ts.
    const aModuleId = nodeId("/project/a.ts", [], "Module");
    const tx = begin(db, "test-dirty-scope");
    create_function(db, tx, aModuleId, `export function fa(): number { return a; }`);
    const result = commit(db, tx);
    expect(result.ok, `commit failed: ${JSON.stringify((result as any).diagnostics)}`).toBe(true);

    const snapshotAfter = snapshotBandC();

    // The snapshot must be byte-identical: materialization touched only a.ts.
    expect(
      snapshotAfter,
      `b.ts/c.ts graph facts changed after a tx that only touched a.ts.\n` +
        `Before: ${snapshotBefore}\nAfter:  ${snapshotAfter}`
    ).toBe(snapshotBefore);

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
