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
import { insertReferences, getReferencesByTo } from "../src/references";

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
  // (internally resolves to the declaration-name identifier and returns inbound edges)
  const refs = get_references(db, decls[0]!.id);
  // Exactly one reference: the h() call-site identifier in caller resolves to
  // the declaration-name identifier of h (statement index 1, first child [1,0]).
  expect(refs).toHaveLength(1);
  expect(refs[0]!.toNodeId).toBe(nodeId("m.ts", [1, 0], "Identifier"));
  db.close();
});

it("refreshReferenceEdges Step 2 does NOT delete inbound edges of a surviving from-identifier", () => {
  // Scenario: module has `f` (statement [0]) and `caller` (calls `f`, statement [1]).
  // We create a new function `h`. During refreshReferenceEdges the resolver re-produces
  // the edge fCallsite → fDeclName (because `caller` is a dirty-module surviving caller).
  // Before refresh we also wire a SYNTHETIC INBOUND edge pointing TO fCallsiteId,
  // simulating fCallsiteId being both a reference source (it resolves to f) and a
  // reference target (something else points to it — e.g. an alias / re-export).
  // After refresh, the inbound edge must survive. With the pre-fix code (OR form),
  // Step 2 would delete it; with the fix (from-only), it survives.
  const db = seed("m.ts", `export function f(): void {}\nexport function caller(): void { f(); }\n`);

  // emitIdentifiers does a pre-order DFS over getChildren within each statement.
  // For `export function caller(): void { f(); }`:
  //   index 0 → `caller` (the function name)
  //   index 1 → `f`     (the call expression identifier)
  // So the f-callsite identifier is at child path [1, 1].
  const fCallsiteId = nodeId("m.ts", [1, 1], "Identifier");

  // The f declaration name identifier is at [0, 0] (first identifier in statement 0).
  const fDeclNameId = nodeId("m.ts", [0, 0], "Identifier");

  // Manually wire a pre-existing outgoing edge: fCallsite → fDeclName.
  // (mirrors what a full ingest + resolve pass would have written)
  insertReferences(db, [{ fromNodeId: fCallsiteId, toNodeId: fDeclNameId, kind: "value" }]);

  // Wire a synthetic INBOUND edge pointing TO fCallsiteId. The source must be a
  // real node in the DB to satisfy the FK constraint, and must not already be a
  // from_node_id in node_references. fDeclNameId has no outgoing edge yet and is
  // a valid choice — it represents "something pointing at the callsite identifier".
  insertReferences(db, [{ fromNodeId: fDeclNameId, toNodeId: fCallsiteId, kind: "value" }]);

  // Create new function h and run the materialization pipeline.
  // The plan's insertedNodeIds includes h; its Identifier children are owned.
  // f and caller identifiers are NOT owned — they're surviving.
  const tx = begin(db, "test");
  const moduleId = nodeId("m.ts", [], "Module");
  const { newNodeId: _hNodeId } = create_function(db, tx, moduleId, `export function h(): void {}`);
  const plan = planMaterialization(db, getOverlay(tx));
  emitIdentifiersForInserted(db, tx, plan);

  // Rendered text: f + caller (unchanged) + h (new at index 2).
  const rendered = new Map<string, string>([
    [
      "m.ts",
      `export function f(): void {}\nexport function caller(): void { f(); }\n\nexport function h(): void {}`
    ]
  ]);
  refreshReferenceEdges(db, plan, rendered, { ...OPTIONS });

  // The resolver will have re-produced fCallsite → fDeclName (because caller/f
  // are in the dirty module). Step 2 must have deleted only fCallsite's outgoing
  // edge (by from_node_id) before re-inserting it — NOT the inbound edge
  // fDeclName → fCallsite. Assert that inbound edge survived.
  const inboundEdges = getReferencesByTo(db, fCallsiteId);
  expect(inboundEdges.some((e) => e.fromNodeId === fDeclNameId)).toBe(true);
  db.close();
});
