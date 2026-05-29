import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import {
  openDb,
  insertNodes,
  insertReferences,
  begin,
  nodeId,
  extract_function,
  find_declarations,
  get_references,
  loadModule,
  listModules
} from "@strata/store";
import { render } from "@strata/render";
import { buildAnalysisContext, commit } from "../src/validate";

function seed(path: string, text: string) {
  const batch = ingestBatch([{ path, text }]);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  return db;
}

describe("buildAnalysisContext", () => {
  it("returns rendered text keyed by resolved path plus compiler options", () => {
    const db = seed("/project/m.ts", `export function f(a: number): number {\n  const b = a + 1;\n  return b;\n}\n`);
    const tx = begin(db, "test");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    // The module's rendered text is present and contains the function.
    const text = [...renderedByPath.values()].join("\n");
    expect(text).toContain("function f");
    expect(options.target).toBeDefined();
    db.close();
  });
});

function renderAll(db: ReturnType<typeof openDb>) {
  return listModules(db).map((m) => {
    const loaded = loadModule(db, m.id);
    return { path: m.payload, text: render(loaded.module, loaded.children) };
  });
}

function nodeIdSet(db: ReturnType<typeof openDb>): Set<string> {
  return new Set(
    (db.prepare(`SELECT id FROM nodes`).all() as { id: string }[]).map((r) => r.id)
  );
}
function refSet(db: ReturnType<typeof openDb>): Set<string> {
  return new Set(
    (db.prepare(`SELECT from_node_id, to_node_id, kind FROM node_references`).all() as {
      from_node_id: string;
      to_node_id: string;
      kind: string;
    }[]).map((r) => `${r.from_node_id}|${r.to_node_id}|${r.kind}`)
  );
}

describe("extract_function commit (integration)", () => {
  it("extracts, commits clean, and the new function is findable", () => {
    const db = seed(
      "/project/m.ts",
      `export function f(a: number, b: number): number {\n  const sum = a + b;\n  const scaled = sum * 2;\n  return scaled;\n}\n`
    );
    const parentId = nodeId("/project/m.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "test");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    const manifest = extract_function(db, tx, parentId, 0, 0, "addUp", renderedByPath, options);
    const result = commit(db, tx);
    expect(result.ok).toBe(true);
    expect(find_declarations(db, { name: "addUp" })).toHaveLength(1);
    expect(manifest.callSiteText).toBe("const sum = addUp(a, b);");
    db.close();
  });

  it("the rewritten call site resolves to the new function (real edge)", () => {
    const db = seed(
      "/project/m.ts",
      `export function f(a: number, b: number): number {\n  const sum = a + b;\n  return sum * 2;\n}\n`
    );
    const parentId = nodeId("/project/m.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "test");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    extract_function(db, tx, parentId, 0, 0, "addUp", renderedByPath, options);
    expect(commit(db, tx).ok).toBe(true);
    const decl = find_declarations(db, { name: "addUp" })[0]!;
    expect(get_references(db, decl.id).length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it("the committed graph equals a clean re-ingest (node IDs + edges)", () => {
    const db = seed(
      "/project/m.ts",
      `export function f(a: number, b: number): number {\n  const lo = a - b;\n  const hi = a + b;\n  return lo + hi;\n}\n`
    );
    const parentId = nodeId("/project/m.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "test");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    extract_function(db, tx, parentId, 0, 1, "bounds", renderedByPath, options);
    expect(commit(db, tx).ok).toBe(true);

    const liveNodes = nodeIdSet(db);
    const liveRefs = refSet(db);
    const batch = ingestBatch(renderAll(db));
    const reNodes = new Set(batch.allNodes.map((n) => n.id));
    const reRefs = new Set(batch.references.map((r) => `${r.fromNodeId}|${r.toNodeId}|${r.kind}`));
    expect([...reNodes].filter((id) => !liveNodes.has(id))).toEqual([]); // none missing
    expect([...liveNodes].filter((id) => !reNodes.has(id))).toEqual([]); // none stale
    expect([...reRefs].filter((r) => !liveRefs.has(r))).toEqual([]);
    expect([...liveRefs].filter((r) => !reRefs.has(r))).toEqual([]);
    db.close();
  });

  it("rolls back cleanly when the extracted code fails to type-check", () => {
    // Force a post-extraction type error by extracting into a context that can't
    // satisfy the inferred type: a span whose declared binding is used after with
    // an incompatible operation is hard to force; instead, make validate fail by
    // referencing an undefined symbol within the span.
    const db = seed(
      "/project/m.ts",
      `export function f(a: number): number {\n  const b = a + missing;\n  return b;\n}\n`
    );
    const parentId = nodeId("/project/m.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "test");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    // analyzeExtraction may still succeed structurally (missing is treated as a
    // global it can't resolve to a param); commit's tsc rejects it.
    try {
      extract_function(db, tx, parentId, 0, 0, "g", renderedByPath, options);
    } catch {
      // If analysis itself rejects, that's also acceptable — assert nothing leaked.
    }
    const result = commit(db, tx);
    expect(result.ok).toBe(false);
    expect(find_declarations(db, { name: "g" })).toHaveLength(0);
    const dangling = db
      .prepare(
        `SELECT count(*) AS n FROM node_references r
         WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = r.from_node_id)
            OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = r.to_node_id)`
      )
      .get() as { n: number };
    expect(dangling.n).toBe(0);
    db.close();
  });
});
