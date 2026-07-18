import { describe, expect, it } from "vitest";
import ts from "typescript";
import { ingestBatch } from "@strata-code/ingest";
import { openDb } from "../src/schema";
import { insertNodes, findNodeById, listChildren, listModules } from "../src/nodes";
import { insertReferences } from "../src/references";
import { begin, getOverlay } from "../src/transactions";
import { inline_function } from "../src/inlineFunction";
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
  return { db, rendered: new Map(inputs.map((i) => [i.path, i.text])) };
}
function stmtIn(db: ReturnType<typeof openDb>, modulePath: string, contains: string) {
  const mod = listModules(db).find((m) => m.payload.endsWith(modulePath))!;
  return listChildren(db, mod.id).find((c) => c.payload?.includes(contains));
}

describe("inline_function apply — substitution + delete", () => {
  it("splices each call site to the inlined expression and deletes the declaration", () => {
    const { db, rendered } = seed([
      { path: "/project/a.ts", text: `export function add(a: number, b: number): number { return a + b; }\n` },
      { path: "/project/b.ts", text: `import { add } from "./a.ts";\nexport const y = add(1, 2);\n` }
    ]);
    const fnId = nodeId("/project/a.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "t");

    const manifest = inline_function(db, tx, fnId, rendered, OPTIONS);

    expect(manifest.name).toBe("add");
    expect(manifest.callSitesInlined).toBe(1);
    expect(findNodeById(db, fnId)).toBeUndefined(); // declaration deleted

    // b.ts's `y` statement got a queued edit replacing add(1, 2) with (1 + 2)
    const yStmt = stmtIn(db, "b.ts", "y")!;
    const edits = getOverlay(tx).textSpanMutations.get(yStmt.id);
    expect(edits).toBeDefined();
    expect(edits!.some((e) => e.newText === "(1 + 2)")).toBe(true);
    db.close();
  });

  it("throws on a non-self-contained function (no mutation)", () => {
    const { db, rendered } = seed([
      { path: "/project/a.ts", text: `const K = 3;\nexport function f(n: number): number { return n * K; }\n` },
      { path: "/project/b.ts", text: `import { f } from "./a.ts";\nexport const y = f(2);\n` }
    ]);
    const fnId = nodeId("/project/a.ts", [1], "FunctionDeclaration");
    const tx = begin(db, "t");
    expect(() => inline_function(db, tx, fnId, rendered, OPTIONS)).toThrow(/K|self-contained|scope/i);
    expect(findNodeById(db, fnId)).toBeDefined(); // untouched
    db.close();
  });
});

describe("inline_function apply — importer strip", () => {
  it("removes a sole-binding importer's statement and a mixed importer's binding", () => {
    const { db, rendered } = seed([
      { path: "/project/a.ts", text: `export function dbl(n: number): number { return n * 2; }\nexport const OTHER = 9;\n` },
      { path: "/project/sole.ts", text: `import { dbl } from "./a.ts";\nexport const y = dbl(2);\n` },
      { path: "/project/mixed.ts", text: `import { dbl, OTHER } from "./a.ts";\nexport const z = dbl(OTHER);\n` }
    ]);
    const fnId = nodeId("/project/a.ts", [0], "FunctionDeclaration");
    const tx = begin(db, "t");

    const manifest = inline_function(db, tx, fnId, rendered, OPTIONS);

    const styles = manifest.importersStripped.map((s) => s.style).sort();
    expect(styles).toEqual(["removed-binding", "removed-statement"]);
    db.close();
  });
});
