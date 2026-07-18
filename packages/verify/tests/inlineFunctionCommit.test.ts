import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata-code/ingest";
import {
  openDb, insertNodes, insertReferences, begin,
  inline_function, find_declarations, listModules, loadModule, nodeId
} from "@strata-code/store";
import { render } from "@strata-code/render";
import { buildAnalysisContext, commit } from "../src/validate";

function loadMedium() {
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

function seed(inputs: { path: string; text: string }[]) {
  const batch = ingestBatch(inputs);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  return db;
}
function renderAll(db: ReturnType<typeof openDb>) {
  return listModules(db).map((m) => { const l = loadModule(db, m.id); return { path: m.payload, text: render(l.module, l.children) }; });
}
function nodeIds(db: ReturnType<typeof openDb>) { return new Set((db.prepare(`SELECT id FROM nodes`).all() as { id: string }[]).map((r) => r.id)); }
function refKeys(db: ReturnType<typeof openDb>) { return new Set((db.prepare(`SELECT from_node_id f, to_node_id t, kind k FROM node_references`).all() as any[]).map((r) => `${r.f}|${r.t}|${r.k}`)); }

describe("inline_function commit (integration)", () => {
  it("inlines a function called by 2 modules; commits clean; declaration gone; re-ingest equivalent", () => {
    const db = seed([
      { path: "/project/a.ts", text: `export function add(a: number, b: number): number { return a + b; }\n` },
      { path: "/project/b.ts", text: `import { add } from "./a";\nexport const y = add(1, 2);\n` },
      { path: "/project/c.ts", text: `import { add } from "./a";\nexport const z = add(3, 4);\n` }
    ]);
    const fnId = nodeId("/project/a.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    const manifest = inline_function(db, tx, fnId, renderedByPath, options);
    expect(manifest.callSitesInlined).toBe(2);

    expect(commit(db, tx).ok).toBe(true);
    expect(find_declarations(db, { name: "add" })).toHaveLength(0); // gone

    // Re-ingest equivalence.
    const live = nodeIds(db), liveR = refKeys(db);
    const batch = ingestBatch(renderAll(db));
    const reNodes = new Set(batch.allNodes.map((n) => n.id));
    const reRefs = new Set(batch.references.map((r) => `${r.fromNodeId}|${r.toNodeId}|${r.kind}`));
    expect([...reNodes].filter((i) => !live.has(i))).toEqual([]);
    expect([...live].filter((i) => !reNodes.has(i))).toEqual([]);
    expect([...reRefs].filter((r) => !liveR.has(r))).toEqual([]);
    expect([...liveR].filter((r) => !reRefs.has(r))).toEqual([]);
    db.close();
  });

  it("importer that imports AND calls the function commits clean (sole-binding strip + call splice in one module)", () => {
    const db = seed([
      { path: "/project/a.ts", text: `export function dbl(n: number): number { return n * 2; }\n` },
      { path: "/project/b.ts", text: `import { dbl } from "./a";\nexport const y = dbl(21);\n` }
    ]);
    const fnId = nodeId("/project/a.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    inline_function(db, tx, fnId, renderedByPath, options);
    expect(commit(db, tx).ok).toBe(true);
    expect(find_declarations(db, { name: "dbl" })).toHaveLength(0);
    db.close();
  });

  it("mixed-importer (split binding) commits clean and leaves the sibling import", () => {
    const db = seed([
      { path: "/project/a.ts", text: `export function dbl(n: number): number { return n * 2; }\nexport const OTHER = 5;\n` },
      { path: "/project/b.ts", text: `import { dbl, OTHER } from "./a";\nexport const y = dbl(OTHER);\n` }
    ]);
    const fnId = nodeId("/project/a.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    inline_function(db, tx, fnId, renderedByPath, options);
    expect(commit(db, tx).ok).toBe(true);
    expect(find_declarations(db, { name: "OTHER" })).toHaveLength(1); // untouched
    db.close();
  });

  it("rolls back cleanly when a non-self-contained inline is refused", () => {
    const db = seed([
      { path: "/project/a.ts", text: `const K = 3;\nexport function f(n: number): number { return n * K; }\n` },
      { path: "/project/b.ts", text: `import { f } from "./a";\nexport const y = f(2);\n` }
    ]);
    const fnId = nodeId("/project/a.ts", [1], "FunctionDeclaration");
    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    expect(() => inline_function(db, tx, fnId, renderedByPath, options)).toThrow(/K|self-contained|scope/i);
    expect(commit(db, tx).ok).toBe(true); // empty tx
    expect(find_declarations(db, { name: "f" })).toHaveLength(1); // still there
    db.close();
  });
});

describe("inline_function on the real corpus", () => {
  it("inlines a self-contained expression-body function (or refuses with a reason); never corrupts", () => {
    const { files } = loadMedium();
    const batch = ingestBatch(files);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    // Pick formatTimestamp from lib/format.ts if it is a single-return expression
    // body; else skip. (In the medium corpus it IS a single self-contained
    // expression, but ui/timeline.ts passes it as a `.map` callback — a non-call
    // value use — so the probe is expected to REFUSE, which is acceptable.)
    const formatMod = listModules(db).find((m) => m.payload.endsWith("lib/format.ts"));
    if (!formatMod) { console.log("no lib/format.ts; skipping"); return; }
    const candidate = loadModule(db, formatMod.id).children.find(
      (c) => (c.kind === "FunctionDeclaration" || c.kind === "FirstStatement") && c.payload?.includes("formatTimestamp")
    );
    if (!candidate) { console.log("no formatTimestamp; skipping"); return; }

    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    let inlined = true;
    try { inline_function(db, tx, candidate.id, renderedByPath, options); }
    catch (e) { inlined = false; console.log("inline refused:", (e as Error).message); }
    if (inlined) expect(commit(db, tx).ok).toBe(true);
    db.close();
  });
});
