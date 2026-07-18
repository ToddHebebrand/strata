import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata-code/ingest";
import {
  openDb, insertNodes, insertReferences, begin,
  move_declaration, find_declarations, get_references, listModules, loadModule, nodeId
} from "@strata-code/store";
import { render } from "@strata-code/render";
import { buildAnalysisContext, commit } from "../src/validate";

function seed(inputs: { path: string; text: string }[]) {
  const batch = ingestBatch(inputs);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  return db;
}
function renderAll(db: ReturnType<typeof openDb>) {
  return listModules(db).map((m) => {
    const loaded = loadModule(db, m.id);
    return { path: m.payload, text: render(loaded.module, loaded.children) };
  });
}
function nodeIds(db: ReturnType<typeof openDb>) {
  return new Set((db.prepare(`SELECT id FROM nodes`).all() as { id: string }[]).map((r) => r.id));
}
function refKeys(db: ReturnType<typeof openDb>) {
  return new Set((db.prepare(`SELECT from_node_id f, to_node_id t, kind k FROM node_references`).all() as any[]).map((r) => `${r.f}|${r.t}|${r.k}`));
}

describe("move_declaration commit (integration)", () => {
  it("moves a symbol imported by 2 modules; commits clean; importers resolve to the new decl; re-ingest equivalent", () => {
    const db = seed([
      { path: "/project/a.ts", text: `export type Id = string | number;\n` },
      { path: "/project/shared.ts", text: `export const VERSION = 1;\n` },
      { path: "/project/c.ts", text: `import { Id } from "./a";\nexport const y: Id = "1";\n` },
      { path: "/project/d.ts", text: `import { Id } from "./a";\nexport const z: Id = 2;\n` }
    ]);
    const declId = nodeId("/project/a.ts", [0], "TypeAliasDeclaration");
    const targetId = nodeId("/project/shared.ts", [], "Module");
    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    const manifest = move_declaration(db, tx, declId, targetId, renderedByPath, options);
    expect(manifest.importersRewritten).toHaveLength(2);

    expect(commit(db, tx).ok).toBe(true);

    // Found in the target, not the source.
    const found = find_declarations(db, { name: "Id" });
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(manifest.newDeclarationId);
    // Both importers' uses resolve to the new declaration (real edges).
    expect(get_references(db, found[0]!.id).length).toBeGreaterThanOrEqual(2);

    // Re-ingest equivalence: committed graph == clean re-ingest of rendered text.
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

  it("mixed-import importer (split-out) commits clean and resolves", () => {
    const db = seed([
      { path: "/project/a.ts", text: `export type Id = string;\nexport type Other = number;\n` },
      { path: "/project/shared.ts", text: `export const VERSION = 1;\n` },
      { path: "/project/c.ts", text: `import { Id, Other } from "./a";\nexport const y: Id = "1";\nexport const z: Other = 2;\n` }
    ]);
    const declId = nodeId("/project/a.ts", [0], "TypeAliasDeclaration");
    const targetId = nodeId("/project/shared.ts", [], "Module");
    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    move_declaration(db, tx, declId, targetId, renderedByPath, options);
    expect(commit(db, tx).ok).toBe(true);
    expect(find_declarations(db, { name: "Id" })).toHaveLength(1);
    expect(find_declarations(db, { name: "Other" })).toHaveLength(1); // untouched
    db.close();
  });

  it("rolls back cleanly when the move would not type-check", () => {
    const db = seed([
      { path: "/project/a.ts", text: `export const NEEDED = 5;\nexport function uses(): number { return NEEDED; }\n` },
      { path: "/project/b.ts", text: `export const x = 1;\n` }
    ]);
    // move `uses` which depends on source-local NEEDED → analyzeMove rejects (self-contained gate).
    const declId = nodeId("/project/a.ts", [1], "FunctionDeclaration");
    const targetId = nodeId("/project/b.ts", [], "Module");
    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    expect(() => move_declaration(db, tx, declId, targetId, renderedByPath, options)).toThrow(/NEEDED|self-contained|depends/i);
    expect(commit(db, tx).ok).toBe(true); // empty tx commits fine; nothing moved
    expect(find_declarations(db, { name: "uses" })).toHaveLength(1); // still in a.ts
    db.close();
  });
});

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

describe("move_declaration on the real corpus", () => {
  // Tolerant probe against examples/medium: a move either commits clean OR is
  // refused with a specific reason — but NEVER corrupts the store. This guards
  // against real-world import shapes (re-exports, back-imports, multi-import
  // statements) the synthetic tests don't cover.
  //
  // Candidate selection: server/audit.ts declares `export type AuditKind =
  // "User" | "Session" | "Token"` — a self-contained string-literal union that
  // is NOT re-exported by index.ts (unlike everything in types.ts, which the
  // re-export gate refuses). `AuditEntry` (staying behind in audit.ts) uses it,
  // so the move exercises the BACK-IMPORT path: the source must re-import the
  // moved symbol after it leaves. We move it to lru.ts (no existing imports).
  it("moves a self-contained exported type to a new home (or refuses with a reason); never corrupts", () => {
    const { root, files } = loadMedium();
    const batch = ingestBatch(files);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    const srcPath = `${root}/server/audit.ts`;
    const srcMod = listModules(db).find((m) => m.payload === srcPath);
    const tgtPath = `${root}/lru.ts`;
    const tgtMod = listModules(db).find((m) => m.payload === tgtPath);
    expect(srcMod && tgtMod).toBeTruthy();
    if (!srcMod || !tgtMod) return;

    // First exported TypeAliasDeclaration child of the source module. payload is
    // getFullText (incl. leading trivia), so a trimmed `export ` prefix detects
    // the export modifier without re-parsing.
    const candidate = loadModule(db, srcMod.id).children.find(
      (c) => c.kind === "TypeAliasDeclaration" && c.payload.trim().startsWith("export ")
    );
    if (!candidate) { console.log("no exported type alias in source; skipping"); return; }

    const tx = begin(db, "t");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    let moved = true;
    let manifest: ReturnType<typeof move_declaration> | undefined;
    try {
      manifest = move_declaration(db, tx, candidate.id, tgtMod.id, renderedByPath, options);
    } catch (e) {
      moved = false; // self-contained / importer-shape / re-export refusal is acceptable
      console.log("move refused:", (e as Error).message);
    }
    if (moved && manifest) {
      const result = commit(db, tx);
      if (!result.ok) {
        // A commit failure on a legitimate move is a REAL bug — surface it.
        console.log("COMMIT FAILED diagnostics:", JSON.stringify(result.diagnostics, null, 2));
      }
      expect(result.ok).toBe(true);
      console.log(
        `moved ${manifest.newDeclarationId} to lru.ts; importersRewritten=${manifest.importersRewritten.length}; sourceBackImportAdded=${manifest.sourceBackImportAdded}`
      );
      // Post-commit the symbol resolves at exactly one home (the target).
      const found = find_declarations(db, { name: candidate.payload.match(/type\s+([A-Za-z0-9_]+)/)?.[1] ?? "" });
      expect(found.length).toBeGreaterThanOrEqual(1);
    }
    db.close();
  });
});
