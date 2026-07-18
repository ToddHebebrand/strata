import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata-code/ingest";
import { openDb } from "../src/schema";
import { insertNodes, listChildren, findNodeById } from "../src/nodes";
import { begin } from "../src/transactions";
import { appendChildStatement } from "../src/appendChildStatement";
import { nodeId } from "../src/ids";

describe("appendChildStatement", () => {
  it("appends at the EOF index, shifts EOF, returns the new id, tracks for rollback", () => {
    const batch = ingestBatch([{ path: "m.ts", text: `export const x = 1;\n` }]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    const moduleId = nodeId("m.ts", [], "Module");
    const tx = begin(db, "t");

    const newId = appendChildStatement(
      db, tx, moduleId, "FunctionDeclaration", `\n\nexport function h(): void {}`
    );

    expect(newId).toBe(nodeId("m.ts", [1], "FunctionDeclaration"));
    const children = listChildren(db, moduleId);
    const indices = children.map((c) => c.childIndex);
    expect(new Set(indices).size).toBe(indices.length); // no collision
    const eof = children.find((c) => c.kind === "EndOfFileTrivia")!;
    expect(eof.childIndex).toBe(Math.max(...(indices as number[])));
    expect(findNodeById(db, newId)?.payload).toBe(`\n\nexport function h(): void {}`);
    db.close();
  });
});
