import { describe, expect, it } from "vitest";
import ts from "typescript";
import { analyzeMove } from "../src/moveAnalysis";

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true
};

// A declaration is located by (modulePath, childIndex, name). The analysis takes
// these plus the target module path and the rendered set.
describe("analyzeMove — scaffolding", () => {
  it("rejects a non-exported declaration", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `function helper(): number { return 1; }\n`],
      ["/p/b.ts", `export const x = 1;\n`]
    ]);
    const r = analyzeMove(rendered, OPTIONS, {
      sourcePath: "/p/a.ts", declChildIndex: 0, name: "helper", targetPath: "/p/b.ts"
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/export/i);
  });

  it("rejects when the target already declares the same name", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export const FOO = 1;\n`],
      ["/p/b.ts", `export const FOO = 2;\n`]
    ]);
    const r = analyzeMove(rendered, OPTIONS, {
      sourcePath: "/p/a.ts", declChildIndex: 0, name: "FOO", targetPath: "/p/b.ts"
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/already|collision|exists/i);
  });

  it("accepts a self-contained exported decl with no importers (plan, empty rewrites)", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export type Id = string | number;\n`],
      ["/p/b.ts", `export const x = 1;\n`]
    ]);
    const r = analyzeMove(rendered, OPTIONS, {
      sourcePath: "/p/a.ts", declChildIndex: 0, name: "Id", targetPath: "/p/b.ts"
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe("Id");
    expect(r.importerRewrites).toEqual([]);
    expect(r.sourceStillUses).toBe(false);
  });
});
