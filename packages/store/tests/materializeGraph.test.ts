import { describe, expect, it } from "vitest";
import ts from "typescript";
import { ingestBatch } from "@strata/ingest";
import { openDb } from "../src/schema";
import { insertNodes, listChildren } from "../src/nodes";
import { begin, queueIdentifierUpdate, getOverlay } from "../src/transactions";
import { create_function } from "../src/createFunction";
import { planMaterialization, isNoop, emitIdentifiersForInserted, refreshReferenceEdges } from "../src/materializeGraph";
import { nodeId } from "../src/ids";
import { find_declarations, get_references } from "../src/queries";

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

const OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true
} as const;

it("created function is findable and a same-module caller resolves to it", () => {
  const db = seed("m.ts", `export function caller(): void { h(); }\n`);
  const tx = begin(db, "test");
  const moduleId = nodeId("m.ts", [], "Module");
  const { newNodeId } = create_function(db, tx, moduleId, `export function h(): void {}`);
  const plan = planMaterialization(db, getOverlay(tx));
  emitIdentifiersForInserted(db, tx, plan);

  // Rendered module: existing caller statement + new h function.
  // Statement indices: 0 = caller, 1 = h (new, childIndex assigned by create_function).
  const rendered = new Map<string, string>([
    ["m.ts", `export function caller(): void { h(); }\n\nexport function h(): void {}`]
  ]);
  refreshReferenceEdges(db, plan, rendered, { ...OPTIONS });

  // find_declarations returns NodeRow[]; each row has .id (the declaration node id)
  const decls = find_declarations(db, { name: "h" });
  expect(decls).toHaveLength(1);
  // get_references takes the declaration node id and returns Reference[]
  const refs = get_references(db, decls[0]!.id);
  expect(refs.length).toBeGreaterThanOrEqual(1);
  db.close();
});
