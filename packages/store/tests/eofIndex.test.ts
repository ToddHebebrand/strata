import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { openDb } from "../src/schema";
import { insertNodes, listChildren } from "../src/nodes";
import { begin } from "../src/transactions";
import { create_function } from "../src/createFunction";
import { add_import } from "../src/addImport";
import { nodeId } from "../src/ids";

const SOURCE = `export const x = 1;\n`;

describe("create_function appends at the re-ingest-consistent statement index", () => {
  it("places the new function at statement index N (not N+1) and shifts EOF", () => {
    const batch = ingestBatch([{ path: "m.ts", text: SOURCE }]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    const moduleId = nodeId("m.ts", [], "Module");

    const tx = begin(db, "test");
    const result = create_function(
      db,
      tx,
      moduleId,
      `export function helper(): void {}`
    );

    const expectedId = nodeId("m.ts", [1], "FunctionDeclaration");
    expect(result.newNodeId).toBe(expectedId);

    const rendered = `export const x = 1;\n\nexport function helper(): void {}`;
    const reIngest = ingestBatch([{ path: "m.ts", text: rendered }]);
    const reFn = reIngest.allNodes.find((n) => n.kind === "FunctionDeclaration");
    expect(reFn?.id).toBe(result.newNodeId);

    const children = listChildren(db, moduleId);
    const indices = children.map((c) => c.childIndex);
    expect(new Set(indices).size).toBe(indices.length);
    const eof = children.find((c) => c.kind === "EndOfFileTrivia")!;
    expect(eof.childIndex).toBe(Math.max(...(indices as number[])));
    db.close();
  });

  it("add_import also appends at index N and shifts EOF", () => {
    const batch = ingestBatch([{ path: "m.ts", text: `export const x = 1;\n` }]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    const moduleId = nodeId("m.ts", [], "Module");
    const tx = begin(db, "test");
    const result = add_import(db, tx, moduleId, `import { y } from "./y";`);
    expect(result.newNodeId).toBe(nodeId("m.ts", [1], "ImportDeclaration"));
    const children = listChildren(db, moduleId);
    const indices = children.map((c) => c.childIndex);
    expect(new Set(indices).size).toBe(indices.length);
    db.close();
  });
});
