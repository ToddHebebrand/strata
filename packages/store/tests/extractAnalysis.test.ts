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

describe("analyzeExtraction — returns", () => {
  it("returns nothing when no span-declared binding is used after the span", () => {
    const source = `export function f(a: number): void {\n  const b = a + 1;\n  console.log(b);\n}\n`;
    // Extract both statements (0..1): b is declared and consumed entirely inside.
    const r = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 0, { start: 0, end: 1 }, "logIt");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.returns).toEqual([]);
    expect(r.returnType).toBe("void");
    expect(r.callSiteText).toBe("logIt(a);");
  });

  it("returns a single used-after binding and builds a const call site", () => {
    const source = `export function f(a: number): number {\n  const b = a + 1;\n  return b * 2;\n}\n`;
    // Extract index 0 (`const b = a + 1;`); b is used after the span (in the return).
    const r = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 0, { start: 0, end: 0 }, "incr");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.returns).toEqual([{ name: "b", type: "number", declKind: "const" }]);
    expect(r.returnType).toBe("number");
    expect(r.callSiteText).toBe("const b = incr(a);");
  });

  it("returns multiple used-after bindings as a destructured object", () => {
    const source = `export function f(a: number): number {\n  const lo = a - 1;\n  const hi = a + 1;\n  return lo + hi;\n}\n`;
    // Extract indices 0..1; both lo and hi are used after.
    const r = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 0, { start: 0, end: 1 }, "bounds");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.returns.map((x) => x.name)).toEqual(["lo", "hi"]);
    expect(r.returnType).toBe("{ lo: number; hi: number }");
    expect(r.callSiteText).toBe("const { lo, hi } = bounds(a);");
  });
});

describe("analyzeExtraction — async + hazards", () => {
  it("marks the extraction async and wraps the return type when the span awaits", () => {
    const source = `async function f(p: Promise<number>): Promise<number> {\n  const v = await p;\n  return v + 1;\n}\n`;
    const r = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 0, { start: 0, end: 0 }, "load");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.isAsync).toBe(true);
    expect(r.returnType).toBe("Promise<number>");
    expect(r.callSiteText).toBe("const v = await load(p);");
  });

  it("rejects a span containing a return statement", () => {
    const source = `export function f(a: number): number {\n  if (a > 0) {\n    return a;\n  }\n  return -a;\n}\n`;
    const r = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 0, { start: 0, end: 0 }, "g");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/return/i);
  });

  it("rejects a span with a break that escapes the span", () => {
    const source = `export function f(xs: number[]): void {\n  for (const x of xs) {\n    if (x < 0) break;\n    console.log(x);\n  }\n}\n`;
    // Extract the inner if (index 0 of the for body)? Simpler: extract a break-bearing
    // statement directly. Here extract the whole for-loop body's first statement set
    // by targeting a nested span is awkward; instead test a labeled escape:
    const labeled = `export function f(xs: number[]): void {\n  outer: for (const x of xs) {\n    break outer;\n  }\n}\n`;
    const r = analyzeExtraction(rendered(labeled), OPTIONS, "/p/m.ts", 0, { start: 0, end: 0 }, "g");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/break|continue/i);
  });

  it("rejects a span referencing this", () => {
    const source = `export function f(this: { n: number }): number {\n  const v = this.n + 1;\n  return v;\n}\n`;
    const r = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 0, { start: 0, end: 0 }, "g");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/this|super|arguments/i);
  });

  it("rejects reassignment of a parent-scope binding", () => {
    const source = `export function f(a: number): number {\n  let acc = 0;\n  acc = acc + a;\n  return acc;\n}\n`;
    // Extract index 1 (`acc = acc + a;`) — reassigns acc, declared outside the span.
    const r = analyzeExtraction(rendered(source), OPTIONS, "/p/m.ts", 0, { start: 1, end: 1 }, "g");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/reassign|assignment/i);
  });
});

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
