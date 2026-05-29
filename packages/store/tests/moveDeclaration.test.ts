import { describe, expect, it } from "vitest";
import ts from "typescript";
import { ingestBatch } from "@strata/ingest";
import { openDb } from "../src/schema";
import { insertNodes, findNodeById, listChildren } from "../src/nodes";
import { insertReferences } from "../src/references";
import { begin } from "../src/transactions";
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
});
