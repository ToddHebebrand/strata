import { describe, expect, it } from "vitest";
import ts from "typescript";
import { analyzeExtraction } from "../src/extractAnalysis";

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true
};

function rendered(source: string): Map<string, string> {
  return new Map([["/p/m.ts", source]]);
}

describe("analyzeExtraction — parameters", () => {
  it("infers parent-scope free variables as parameters with inferred types", () => {
    const source = `export function f(a: number, b: number): number {\n  const sum = a + b;\n  const scaled = sum * 2;\n  return scaled;\n}\n`;
    // Extract statement index 0 (`const sum = a + b;`). It reads a and b (params)
    // and declares sum.
    const result = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 0, { start: 0, end: 0 }, "computeSum");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params).toEqual([
      { name: "a", type: "number" },
      { name: "b", type: "number" }
    ]);
  });

  it("does NOT treat module-level or imported symbols as parameters", () => {
    const source = `const FACTOR = 10;\nexport function f(a: number): number {\n  const scaled = a * FACTOR;\n  return scaled;\n}\n`;
    // Parent is statements[1]; extract index 0 of its body (`const scaled = a * FACTOR;`).
    const result = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 1, { start: 0, end: 0 }, "scale");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // a is a parameter; FACTOR is module-level and must be excluded.
    expect(result.params).toEqual([{ name: "a", type: "number" }]);
  });
});
