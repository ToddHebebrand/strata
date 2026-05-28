import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { openDb } from "../src/schema";
import { insertNodes, listChildren } from "../src/nodes";
import { begin, queueIdentifierUpdate, getOverlay } from "../src/transactions";
import { create_function } from "../src/createFunction";
import { planMaterialization, isNoop, emitIdentifiersForInserted } from "../src/materializeGraph";
import { nodeId } from "../src/ids";

function seed(path: string, text: string) {
  const batch = ingestBatch([{ path, text }]);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  return db;
}

describe("planMaterialization / isNoop", () => {
  it("is a no-op for a pure rename (only identifier text updates)", () => {
    const db = seed("m.ts", `export function f(): void {}\n`);
    const tx = begin(db, "test");
    const declNameId = nodeId("m.ts", [0, 0], "Identifier");
    queueIdentifierUpdate(tx, declNameId, "g");
    const plan = planMaterialization(db, getOverlay(tx));
    expect(isNoop(plan)).toBe(true);
    db.close();
  });

  it("flags an inserted node as a dirty module needing class-1 emission", () => {
    const db = seed("m.ts", `export const x = 1;\n`);
    const tx = begin(db, "test");
    const moduleId = nodeId("m.ts", [], "Module");
    const { newNodeId } = create_function(db, tx, moduleId, `export function h(): void {}`);
    const plan = planMaterialization(db, getOverlay(tx));
    expect(isNoop(plan)).toBe(false);
    expect(plan.dirtyModulePaths).toContain("m.ts");
    expect(plan.insertedNodeIds).toContain(newNodeId);
    db.close();
  });

  it("emits Identifier children for an inserted function so it is findable", () => {
    const db = seed("m.ts", `export const x = 1;\n`);
    const tx = begin(db, "test");
    const moduleId = nodeId("m.ts", [], "Module");
    const { newNodeId } = create_function(db, tx, moduleId, `export function h(): void {}`);
    const plan = planMaterialization(db, getOverlay(tx));

    emitIdentifiersForInserted(db, tx, plan);

    const idents = listChildren(db, newNodeId).filter((c) => c.kind === "Identifier");
    const names = idents.map((n) => (JSON.parse(n.payload) as { text: string }).text);
    expect(names).toContain("h");
    db.close();
  });

  it("emits Identifier children with offsets matching re-ingest (offset consistency)", () => {
    const db = seed("m.ts", `export const x = 1;\n`);
    const tx = begin(db, "test");
    const moduleId = nodeId("m.ts", [], "Module");
    const { newNodeId } = create_function(db, tx, moduleId, `export function h(): void {}`);
    const plan = planMaterialization(db, getOverlay(tx));

    emitIdentifiersForInserted(db, tx, plan);

    // The rendered module: statement[0] payload "export const x = 1;" +
    // new function payload "\n\nexport function h(): void {}" + EOF payload "\n"
    // = "export const x = 1;\n\nexport function h(): void {}\n"
    const renderedModule = `export const x = 1;\n\nexport function h(): void {}\n`;
    const reIngest = ingestBatch([{ path: "m.ts", text: renderedModule }]);
    const reH = reIngest.allNodes.find(
      (n) => n.kind === "Identifier" && (JSON.parse(n.payload) as { text: string }).text === "h"
    );
    const storedH = listChildren(db, newNodeId).find(
      (c) => c.kind === "Identifier" && (JSON.parse(c.payload) as { text: string }).text === "h"
    );
    expect(storedH).toBeDefined();
    expect(reH).toBeDefined();
    expect(storedH!.id).toBe(reH!.id);
    expect(JSON.parse(storedH!.payload)).toEqual(JSON.parse(reH!.payload));
    db.close();
  });
});
