import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { openDb } from "../src/schema";
import { insertNodes, findNodeById, listChildren } from "../src/nodes";
import { insertReferences } from "../src/references";
import { begin, rollback } from "../src/transactions";
import { removeChildStatement } from "../src/removeChildStatement";
import { nodeId } from "../src/ids";

function seed(inputs: { path: string; text: string }[]) {
  const batch = ingestBatch(inputs);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  return db;
}

describe("removeChildStatement", () => {
  it("deletes a top-level statement and re-indexes surviving siblings + EOF down by one", () => {
    const db = seed([{ path: "/p/a.ts", text: `export type A = string;\nexport const KEEP = 1;\n` }]);
    const moduleId = nodeId("/p/a.ts", [], "Module");
    const aId = nodeId("/p/a.ts", [0], "TypeAliasDeclaration");
    const tx = begin(db, "t");

    removeChildStatement(db, tx, moduleId, 0);

    expect(findNodeById(db, aId)).toBeUndefined(); // removed
    const children = listChildren(db, moduleId);
    const indices = children.map((c) => c.childIndex);
    expect(new Set(indices).size).toBe(indices.length); // no collision / gap-free
    // KEEP shifted 1 -> 0
    expect(findNodeById(db, nodeId("/p/a.ts", [0], "FirstStatement"))).toBeDefined();
    expect(findNodeById(db, nodeId("/p/a.ts", [1], "FirstStatement"))).toBeUndefined();
    // EOF shifted 2 -> 1
    const eof = children.find((c) => c.kind === "EndOfFileTrivia")!;
    expect(eof.childIndex).toBe(1);
    db.close();
  });

  it("restores nodes AND edges on rollback", () => {
    const db = seed([
      { path: "/p/a.ts", text: `export type Id = string;\nexport const first: Id = "1";\n` }
    ]);
    const moduleId = nodeId("/p/a.ts", [], "Module");
    const nodesBefore = new Set((db.prepare(`SELECT id FROM nodes`).all() as { id: string }[]).map((r) => r.id));
    const edgesBefore = new Set((db.prepare(`SELECT from_node_id f, to_node_id t, kind k FROM node_references`).all() as any[]).map((r) => `${r.f}|${r.t}|${r.k}`));
    expect(edgesBefore.size).toBeGreaterThan(0);

    const tx = begin(db, "t");
    removeChildStatement(db, tx, moduleId, 0); // remove `Id`
    rollback(db, tx);

    const nodesAfter = new Set((db.prepare(`SELECT id FROM nodes`).all() as { id: string }[]).map((r) => r.id));
    const edgesAfter = new Set((db.prepare(`SELECT from_node_id f, to_node_id t, kind k FROM node_references`).all() as any[]).map((r) => `${r.f}|${r.t}|${r.k}`));
    expect([...nodesAfter].sort()).toEqual([...nodesBefore].sort());
    expect([...edgesAfter].sort()).toEqual([...edgesBefore].sort());
    db.close();
  });
});
