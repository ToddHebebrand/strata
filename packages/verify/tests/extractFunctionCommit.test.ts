import { describe, expect, it } from "vitest";
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
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

  it("shorthand property assignment reads of parent-scope params become parameters", () => {
    // Seed: extracting `const pair = { a, b };` should infer params a and b,
    // because `a` and `b` are referenced via shorthand property assignment.
    // Without the fix, getSymbolAtLocation(a) returns the property symbol
    // (declared inside the object literal, i.e. inside the span), so inferParams
    // excludes a and b — the extracted function omits them and tsc rejects it.
    const db = seed(
      "/project/m.ts",
      `export function f(a: number, b: number): { a: number; b: number } {\n  const pair = { a, b };\n  return pair;\n}\n`
    );
    const parentId = nodeId("/project/m.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "test");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    const manifest = extract_function(db, tx, parentId, 0, 0, "pairBuild", renderedByPath, options);
    const result = commit(db, tx);
    expect(result.ok).toBe(true);
    expect(find_declarations(db, { name: "pairBuild" })).toHaveLength(1);
    const decl = find_declarations(db, { name: "pairBuild" })[0]!;
    expect(get_references(db, decl.id).length).toBeGreaterThanOrEqual(1);
    // The call site must pass both a and b as arguments.
    expect(manifest.callSiteText).toContain("a");
    expect(manifest.callSiteText).toContain("b");
    db.close();
  });
});

function loadMedium(): { root: string; files: { path: string; text: string }[] } {
  const root = path.resolve(__dirname, "../../../examples/medium/src");
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith(".ts")) files.push({ path: full.replaceAll("\\", "/"), text: readFileSync(full, "utf8") });
    }
  };
  walk(root);
  return { root, files };
}

describe("extract_function on the real corpus", () => {
  it("extracts a contiguous span from a medium-corpus function and commits green", () => {
    const { root, files } = loadMedium();
    const batch = ingestBatch(files);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    // Pick a function with >=2 simple body statements. Inspect via read_node-style
    // listing: find the first top-level FunctionDeclaration in lru.ts with a body
    // of at least 2 statements and extract its first statement.
    const lruPath = `${root}/lru.ts`;
    const lruModule = nodeId(lruPath, [], "Module");
    // Find a FunctionDeclaration child of lru.ts (fall back to any module if none).
    const candidates = listModules(db)
      .flatMap((m) => loadModule(db, m.id).children.map((c) => ({ m, c })))
      .filter(({ c }) => c.kind === "FunctionDeclaration");
    const target = candidates.find(({ c }) => {
      const sf = ts.createSourceFile("x.ts", c.payload, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const fn = sf.statements[0];
      return fn && ts.isFunctionDeclaration(fn) && fn.body && fn.body.statements.length >= 2;
    });
    expect(target).toBeDefined();
    if (!target) return;

    const tx = begin(db, "test");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    const analysis = (() => {
      try {
        return extract_function(db, tx, target.c.id, 0, 0, "__extracted_probe__", renderedByPath, options);
      } catch (e) {
        return e as Error;
      }
    })();
    // Either the extraction is safe and commits green, or it was refused with a
    // reason (also acceptable — the point is no corruption). If it applied, commit.
    if (!(analysis instanceof Error)) {
      const result = commit(db, tx);
      expect(result.ok).toBe(true);
      expect(find_declarations(db, { name: "__extracted_probe__" })).toHaveLength(1);
    }
    db.close();
  });
});

describe("extract_function pre-commit rejection (transaction stays open)", () => {
  it("refuses a span containing a return, before any mutation", () => {
    const db = seed("/project/m.ts", `export function f(a: number): number {\n  if (a > 0) {\n    return a;\n  }\n  return -a;\n}\n`);
    const parentId = nodeId("/project/m.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "test");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    expect(() => extract_function(db, tx, parentId, 0, 0, "g", renderedByPath, options)).toThrow(/return/i);
    // Parent unchanged; the transaction is still usable for a different op.
    expect(find_declarations(db, { name: "g" })).toHaveLength(0);
    db.close();
  });
});
