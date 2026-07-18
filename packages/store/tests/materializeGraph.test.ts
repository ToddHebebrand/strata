import { describe, expect, it } from "vitest";
import ts from "typescript";
import { ingestBatch } from "@strata-code/ingest";
import { openDb } from "../src/schema";
import { insertNodes, listChildren, findNodeById } from "../src/nodes";
import { begin, queueIdentifierUpdate, queueTextSpanEdit, getOverlay } from "../src/transactions";
import { create_function } from "../src/createFunction";
import { planMaterialization, isNoop, emitIdentifiersForInserted, refreshReferenceEdges, reDeriveChangedStatements } from "../src/materializeGraph";
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

it("re-derives a spliced parent body: removed-span ids gone, call-site id present", () => {
  const source = `export function parent(a: number): void {\n  const b = a + 1;\n  console.log(b);\n}\n`;
  const db = seed("m.ts", source);
  const tx = begin(db, "test");
  const moduleId = nodeId("m.ts", [], "Module");

  // 1) Create the helper (class-1).
  create_function(
    db, tx, moduleId, `export function h(a: number): void { const b = a + 1; }`
  );

  // 2) Splice the parent body's first body statement with a call to h.
  const parentId = nodeId("m.ts", [0], "FunctionDeclaration");
  const parentNode = findNodeById(db, parentId)!;
  const removed = `  const b = a + 1;`;
  const start = parentNode.payload.indexOf(removed);
  queueTextSpanEdit(tx, parentId, {
    start,
    end: start + removed.length,
    oldText: removed,
    newText: `  h(a);`
  });

  // Apply the payload edit to the parent node (mimics materializeStatementPayloads).
  const newPayload =
    parentNode.payload.slice(0, start) + `  h(a);` + parentNode.payload.slice(start + removed.length);
  db.prepare(`UPDATE nodes SET payload = ? WHERE id = ?`).run(newPayload, parentId);

  const plan = planMaterialization(db, getOverlay(tx));
  emitIdentifiersForInserted(db, tx, plan);
  reDeriveChangedStatements(db, tx, plan);

  const parentIdents = listChildren(db, parentId)
    .filter((c) => c.kind === "Identifier");
  const parentIdentTexts = parentIdents.map((n) => (JSON.parse(n.payload) as { text: string }).text);

  // After splice: `const b = a + 1;` is gone, so the old DFS-index-2 identifier
  // (which was `b` from the const declaration) no longer exists as `b` — it's now
  // `h` (the call-site). The `b` from `console.log(b)` still exists (it's in the
  // body), but the const-declaration `b` identifier is gone.
  // The original `b` at DFS index 2 had id nodeId("m.ts", [0, 2], "Identifier").
  // After re-derivation that slot is `h`. The old `b` from `console.log(b)` is
  // still in the function, so `b` appears exactly once (in the log call).
  expect(parentIdentTexts).toContain("h");
  // The OLD identifier ID for DFS slot 2 (was `b`) is now re-used for `h`.
  const slot2Id = nodeId("m.ts", [0, 2], "Identifier");
  const slot2 = parentIdents.find((n) => n.id === slot2Id);
  expect(slot2).toBeDefined();
  expect((JSON.parse(slot2!.payload) as { text: string }).text).toBe("h");
  // The console.log(b) `b` still exists (it was not removed by the splice).
  expect(parentIdentTexts.filter((t) => t === "b")).toHaveLength(1);
  db.close();
});

it("re-derived statement identifiers match re-ingest (offset consistency)", () => {
  // This is the core guarantee: identifiers emitted by reDeriveChangedStatements
  // must have the same IDs and payloads as a clean re-ingest of the final module text.
  //
  // Assumption: after the splice, the rendered module is the spliced parent
  // (with `h(a)` replacing `const b = a + 1`) followed by the helper `h`.
  // We construct this text and compare ids/payloads for the parent statement.
  const source = `export function parent(a: number): void {\n  const b = a + 1;\n  console.log(b);\n}\n`;
  const db = seed("m.ts", source);
  const tx = begin(db, "test");
  const moduleId = nodeId("m.ts", [], "Module");

  // 1) Create the helper (class-1).
  create_function(
    db, tx, moduleId, `export function h(a: number): void { const b = a + 1; }`
  );

  // 2) Splice the parent body.
  const parentId = nodeId("m.ts", [0], "FunctionDeclaration");
  const parentNode = findNodeById(db, parentId)!;
  const removed = `  const b = a + 1;`;
  const start = parentNode.payload.indexOf(removed);
  queueTextSpanEdit(tx, parentId, {
    start,
    end: start + removed.length,
    oldText: removed,
    newText: `  h(a);`
  });

  const newPayload =
    parentNode.payload.slice(0, start) + `  h(a);` + parentNode.payload.slice(start + removed.length);
  db.prepare(`UPDATE nodes SET payload = ? WHERE id = ?`).run(newPayload, parentId);

  const plan = planMaterialization(db, getOverlay(tx));
  emitIdentifiersForInserted(db, tx, plan);
  reDeriveChangedStatements(db, tx, plan);

  // Build the final rendered module text.
  // Statement[0] = spliced parent payload (no leading newline for first statement).
  // Statement[1] = helper payload (create_function prepends "\n\n").
  // EOF payload = "\n".
  // The rendered module is the concatenation of all statement payloads.
  // The helper payload from create_function has a "\n\n" prefix.
  // Directly construct the rendered module from known parts.
  // The original source's parent statement (statement[0]) has no leading newline
  // (it starts at offset 0). After splice its payload is newPayload.
  // The helper was appended with "\n\n" prefix by create_function.
  // Retrieve the helper's actual stored payload.
  const helperStmt = db.prepare(
    `SELECT payload FROM nodes WHERE parent_id = ? AND kind = 'FunctionDeclaration' AND id != ?`
  ).get(moduleId, parentId) as { payload: string } | null;
  if (!helperStmt) throw new Error("helper not found");

  // The rendered module text is: splicedParentPayload + helperPayload + "\n" (EOF payload).
  const renderedModule = newPayload + helperStmt.payload + "\n";

  // Re-ingest from this rendered text.
  const reIngest = ingestBatch([{ path: "m.ts", text: renderedModule }]);

  // For statement[0] (the spliced parent, at childIndex 0), compare all identifiers.
  const reIngestParentIdents = reIngest.allNodes.filter(
    (n) => n.kind === "Identifier" && n.parentId === nodeId("m.ts", [0], "FunctionDeclaration")
  );
  const storedParentIdents = listChildren(db, parentId).filter(
    (c) => c.kind === "Identifier"
  );

  // IDs must match exactly.
  const reIngestIds = new Set(reIngestParentIdents.map((n) => n.id));
  const storedIds = new Set(storedParentIdents.map((n) => n.id));
  for (const id of reIngestIds) {
    expect(storedIds.has(id)).toBe(true);
  }
  for (const id of storedIds) {
    expect(reIngestIds.has(id)).toBe(true);
  }

  // Payloads must also match.
  for (const reNode of reIngestParentIdents) {
    const stored = storedParentIdents.find((n) => n.id === reNode.id);
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!.payload)).toEqual(JSON.parse(reNode.payload));
  }

  db.close();
});
