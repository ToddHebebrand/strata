import { describe, expect, it } from "vitest";
import ts from "typescript";
import { ingestBatch } from "@strata/ingest";
import { openDb } from "../src/schema";
import { insertNodes, findNodeById, listChildren } from "../src/nodes";
import { insertReferences } from "../src/references";
import { begin, rollback, getOverlay } from "../src/transactions";
import { move_declaration } from "../src/moveDeclaration";
import { nodeId } from "../src/ids";
import { listModules } from "../src/nodes";

function importDeclFor(db: ReturnType<typeof openDb>, modulePath: string, name: string) {
  const mod = listModules(db).find((m) => m.payload.endsWith(modulePath))!;
  return listChildren(db, mod.id).filter((c) => c.kind === "ImportDeclaration")
    .find((c) => c.payload.includes(name));
}

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
  allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true
};

function seed(inputs: { path: string; text: string }[]) {
  const batch = ingestBatch(inputs);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  const rendered = new Map(inputs.map((i) => [i.path, i.text]));
  return { db, rendered };
}

describe("move_declaration apply — move mechanism", () => {
  it("recreates the declaration in the target and deletes it from the source", () => {
    const { db, rendered } = seed([
      { path: "/project/a.ts", text: `export type Id = string | number;\n` },
      { path: "/project/b.ts", text: `export const x = 1;\n` }
    ]);
    const declId = nodeId("/project/a.ts", [0], "TypeAliasDeclaration");
    const targetId = nodeId("/project/b.ts", [], "Module");
    const tx = begin(db, "t");

    const manifest = move_declaration(db, tx, declId, targetId, rendered, OPTIONS);

    expect(manifest.name).toBe("Id");
    expect(findNodeById(db, declId)).toBeUndefined(); // deleted from source
    const moved = findNodeById(db, manifest.newDeclarationId)!;
    expect(moved.kind).toBe("TypeAliasDeclaration");
    expect(moved.payload).toContain("export type Id = string | number;");
    // new id is target-derived
    expect(manifest.newDeclarationId).not.toBe(declId);
    expect(manifest.targetModulePath).toContain("b.ts");
    db.close();
  });

  it("throws a specific reason on a non-self-contained move (no overlay mutation)", () => {
    const { db, rendered } = seed([
      { path: "/project/a.ts", text: `const BASE = 10;\nexport function scaled(n: number): number { return n * BASE; }\n` },
      { path: "/project/b.ts", text: `export const x = 1;\n` }
    ]);
    const declId = nodeId("/project/a.ts", [1], "FunctionDeclaration");
    const targetId = nodeId("/project/b.ts", [], "Module");
    const tx = begin(db, "t");
    expect(() => move_declaration(db, tx, declId, targetId, rendered, OPTIONS)).toThrow(/BASE|self-contained|depends/i);
    expect(findNodeById(db, declId)).toBeDefined(); // untouched
    db.close();
  });

  it("re-indexes surviving source siblings + EOF down by one after the moved decl is removed", () => {
    // a.ts: Id (TypeAliasDeclaration @0), KEEP (FirstStatement @1), EOF @2.
    const { db, rendered } = seed([
      { path: "/project/a.ts", text: `export type Id = string;\nexport const KEEP = 1;\n` },
      { path: "/project/b.ts", text: `export const x = 1;\n` }
    ]);
    const moduleA = listModules(db).find((m) => m.payload.endsWith("a.ts"))!;
    // Sanity: confirm the stored layout (stored kind of `const` is FirstStatement).
    const before = listChildren(db, moduleA.id);
    expect(before.map((c) => [c.childIndex, c.kind])).toEqual([
      [0, "TypeAliasDeclaration"],
      [1, "FirstStatement"],
      [2, "EndOfFileTrivia"]
    ]);

    const declId = nodeId("/project/a.ts", [0], "TypeAliasDeclaration");
    const targetId = nodeId("/project/b.ts", [], "Module");
    const tx = begin(db, "t");
    move_declaration(db, tx, declId, targetId, rendered, OPTIONS);

    // The moved decl is gone from the source.
    expect(findNodeById(db, declId)).toBeUndefined();

    // KEEP shifted from index 1 → 0: the new id exists, the old id is gone.
    expect(findNodeById(db, nodeId("/project/a.ts", [0], "FirstStatement"))).toBeDefined();
    expect(findNodeById(db, nodeId("/project/a.ts", [1], "FirstStatement"))).toBeUndefined();

    // EOF shifted from index 2 → 1.
    const after = listChildren(db, moduleA.id);
    const eof = after.find((c) => c.kind === "EndOfFileTrivia")!;
    expect(eof.childIndex).toBe(1);

    // Contiguous, gap-free, duplicate-free childIndex set {0, 1}.
    const indices = after.map((c) => c.childIndex!).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1]);
    db.close();
  });

  it("rollback restores re-indexed surviving siblings + their nodes/edges exactly", () => {
    // a.ts: Id (moved) + a surviving statement that USES Id (self-use edge) and
    // is itself imported by c.ts (inbound edge) — so the survivor's subtree
    // carries real edges that must be restored on rollback.
    const { db, rendered } = seed([
      {
        path: "/project/a.ts",
        text: `export type Id = string;\nexport const fallback: Id = "x";\n`
      },
      { path: "/project/b.ts", text: `export const x = 1;\n` },
      {
        path: "/project/c.ts",
        text: `import { fallback } from "./a.ts";\nexport const y = fallback;\n`
      }
    ]);
    const declId = nodeId("/project/a.ts", [0], "TypeAliasDeclaration");
    const targetId = nodeId("/project/b.ts", [], "Module");

    const allNodes = () =>
      new Set(
        (db.prepare(`SELECT id FROM nodes`).all() as { id: string }[]).map((r) => r.id)
      );
    const allEdges = () =>
      new Set(
        (
          db
            .prepare(`SELECT from_node_id AS f, to_node_id AS t, kind FROM node_references`)
            .all() as { f: string; t: string; kind: string }[]
        ).map((r) => `${r.f}|${r.t}|${r.kind}`)
      );

    const nodesBefore = allNodes();
    const edgesBefore = allEdges();
    expect(edgesBefore.size).toBeGreaterThan(0);

    const tx = begin(db, "t");
    move_declaration(db, tx, declId, targetId, rendered, OPTIONS);
    // After apply: decl gone AND the survivor was re-indexed (old id gone).
    expect(findNodeById(db, declId)).toBeUndefined();
    expect(findNodeById(db, nodeId("/project/a.ts", [1], "FirstStatement"))).toBeUndefined();
    expect(findNodeById(db, nodeId("/project/a.ts", [0], "FirstStatement"))).toBeDefined();

    rollback(db, tx);

    // The graph must be the byte-for-byte pre-move snapshot.
    expect(allNodes()).toEqual(nodesBefore);
    expect(allEdges()).toEqual(edgesBefore);
    db.close();
  });

  it("rollback restores both the deleted nodes AND their reference edges", () => {
    // a.ts exports Id and uses it in another statement (self-use → edge);
    // c.ts imports { Id } and uses it (importer → edge TO the decl name id).
    const { db, rendered } = seed([
      {
        path: "/project/a.ts",
        text: `export type Id = string | number;\nexport const fallback: Id = 0;\n`
      },
      { path: "/project/b.ts", text: `export const x = 1;\n` },
      {
        path: "/project/c.ts",
        text: `import { Id } from "./a.ts";\nexport const y: Id = 1;\n`
      }
    ]);
    const declId = nodeId("/project/a.ts", [0], "TypeAliasDeclaration");
    const targetId = nodeId("/project/b.ts", [], "Module");

    const allNodes = () =>
      new Set(
        (db.prepare(`SELECT id FROM nodes`).all() as { id: string }[]).map(
          (r) => r.id
        )
      );
    const allEdges = () =>
      new Set(
        (
          db
            .prepare(`SELECT from_node_id AS f, to_node_id AS t, kind FROM node_references`)
            .all() as { f: string; t: string; kind: string }[]
        ).map((r) => `${r.f}|${r.t}|${r.kind}`)
      );

    const nodesBefore = allNodes();
    const edgesBefore = allEdges();
    // Precondition: there really are edges touching the decl's subtree, else
    // this test would pass trivially even with the bug.
    expect(edgesBefore.size).toBeGreaterThan(0);

    const tx = begin(db, "t");
    move_declaration(db, tx, declId, targetId, rendered, OPTIONS);
    // After apply the decl is gone (and so are its edges).
    expect(findNodeById(db, declId)).toBeUndefined();

    rollback(db, tx);

    // After rollback the graph must be byte-for-byte the pre-move snapshot:
    // every node AND every reference edge restored verbatim, none extra.
    expect(allNodes()).toEqual(nodesBefore);
    expect(allEdges()).toEqual(edgesBefore);
    db.close();
  });
});

describe("move_declaration apply — importer rewrites", () => {
  // NOTE: the importer-rewrite apply loop now THROWS (rather than silently
  // skipping) when a rewrite analyzeMove promised cannot be applied — an
  // analyze/apply coordinate disagreement is a bug, and a silent skip would
  // leave a half-applied move whose manifest misreports success. Those throws
  // are invariant guards: they must NOT fire on valid moves. The sole-importer
  // path-rewrite test below exercises the path-rewrite throws' non-firing
  // (importer-found, statement-found, specifier-found); Task 9's integration
  // split-out test will cover the split-out binding guard's non-firing.
  it("rewrites a sole importer's specifier and adds a back-import when source still uses it", () => {
    const { db, rendered } = seed([
      { path: "/project/a.ts", text: `export type Id = string;\nexport const first: Id = "1";\n` },
      { path: "/project/lib/b.ts", text: `export const x = 1;\n` },
      { path: "/project/c.ts", text: `import { Id } from "./a.ts";\nexport const y: Id = "z";\n` }
    ]);
    const declId = nodeId("/project/a.ts", [0], "TypeAliasDeclaration");
    const targetId = nodeId("/project/lib/b.ts", [], "Module");
    const tx = begin(db, "t");

    const manifest = move_declaration(db, tx, declId, targetId, rendered, OPTIONS);

    expect(manifest.sourceBackImportAdded).toBe(true); // a.ts still uses Id in `first`
    expect(manifest.importersRewritten.map((i) => i.style)).toContain("path-rewrite");

    // c.ts ImportDeclaration got a queued text-span edit rewriting "./a.ts" -> "./lib/b.ts"
    const cImport = importDeclFor(db, "c.ts", "Id")!;
    const edits = getOverlay(tx).textSpanMutations.get(cImport.id);
    expect(edits).toBeDefined();
    expect(edits!.some((e) => e.newText === `"./lib/b.ts"` && e.oldText === `"./a.ts"`)).toBe(true);
    db.close();
  });
});
