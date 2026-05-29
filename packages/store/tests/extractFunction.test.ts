import { describe, expect, it } from "vitest";
import ts from "typescript";
import { ingestBatch } from "@strata/ingest";
import { openDb } from "../src/schema";
import { insertNodes, findNodeById } from "../src/nodes";
import { begin, getOverlay } from "../src/transactions";
import { extract_function } from "../src/extractFunction";
import { nodeId } from "../src/ids";

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true
};

function seed(source: string) {
  const batch = ingestBatch([{ path: "/p/m.ts", text: source }]);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  return { db, rendered: new Map<string, string>([["/p/m.ts", source]]) };
}

describe("extract_function apply", () => {
  it("inserts a new function, splices the parent to a call, and returns a manifest", () => {
    const source = `export function f(a: number, b: number): number {\n  const sum = a + b;\n  return sum * 2;\n}\n`;
    const { db, rendered } = seed(source);
    const parentId = nodeId("/p/m.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "test");

    const manifest = extract_function(db, tx, parentId, 0, 0, "computeSum", rendered, OPTIONS);

    expect(manifest.name).toBe("computeSum");
    expect(manifest.params).toEqual([
      { name: "a", type: "number" },
      { name: "b", type: "number" }
    ]);
    expect(manifest.returns).toEqual([{ name: "sum", type: "number", declKind: "const" }]);
    expect(manifest.callSiteText).toBe("const sum = computeSum(a, b);");

    // The parent splice is queued as a text-span edit on the overlay (NOT applied
    // to the DB until commit; the commit-time class-2 pass re-derives the parent).
    const edits = getOverlay(tx).textSpanMutations.get(parentId);
    expect(edits).toBeDefined();
    expect(edits!.some((e) => e.newText === "const sum = computeSum(a, b);")).toBe(true);
    expect(edits!.some((e) => e.oldText.includes("const sum = a + b;"))).toBe(true);

    // A new FunctionDeclaration node exists with the expected body + signature.
    const newFn = findNodeById(db, manifest.newNodeId)!;
    expect(newFn.kind).toBe("FunctionDeclaration");
    expect(newFn.payload).toContain("function computeSum(a: number, b: number): number");
    expect(newFn.payload).toContain("const sum = a + b;");
    expect(newFn.payload).toContain("return sum;");
    db.close();
  });

  it("throws a specific reason when the span is unsafe (no overlay mutation)", () => {
    const source = `export function f(a: number): number {\n  return a + 1;\n}\n`;
    const { db, rendered } = seed(source);
    const parentId = nodeId("/p/m.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "test");
    expect(() => extract_function(db, tx, parentId, 0, 0, "g", rendered, OPTIONS)).toThrow(/return/i);
    // Parent untouched; no new function node added.
    const parent = findNodeById(db, parentId)!;
    expect(parent.payload).toContain("return a + 1;");
    db.close();
  });

  it("throws on a name collision with an existing top-level declaration", () => {
    const source = `export function taken(): void {}\nexport function f(a: number): number {\n  const b = a + 1;\n  return b;\n}\n`;
    const { db, rendered } = seed(source);
    const parentId = nodeId("/p/m.ts", [1], "FunctionDeclaration");
    const tx = begin(db, "test");
    expect(() => extract_function(db, tx, parentId, 0, 0, "taken", rendered, OPTIONS)).toThrow(/taken|exists|collision/i);
    db.close();
  });
});
