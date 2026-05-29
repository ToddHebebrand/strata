import { describe, expect, it } from "vitest";
import ts from "typescript";
import { ingestBatch } from "@strata/ingest";
import { openDb } from "../src/schema";
import { insertNodes, findNodeById, listChildren } from "../src/nodes";
import { insertReferences } from "../src/references";
import { begin, rollback } from "../src/transactions";
import { move_declaration } from "../src/moveDeclaration";
import { nodeId } from "../src/ids";

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
