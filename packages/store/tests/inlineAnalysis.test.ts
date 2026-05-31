import { describe, expect, it } from "vitest";
import ts from "typescript";
import { analyzeInline } from "../src/inlineAnalysis";

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
  allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true
};

// A declaration is located by (modulePath, childIndex, name).
describe("analyzeInline — scaffolding (normalize + shape rejection)", () => {
  it("accepts a function declaration with a single returned expression (no refs → empty plan)", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export function dbl(n: number): number { return n * 2; }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe("dbl");
    expect(r.callSites).toEqual([]);
    expect(r.importerStrips).toEqual([]);
  });

  it("accepts an arrow const with a concise expression body", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export const dbl = (n: number): number => n * 2;\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(true);
  });

  it("accepts an arrow const with a single-return block body", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export const dbl = (n: number): number => { return n * 2; };\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(true);
  });

  it("rejects a multi-statement body", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export function f(n: number): number { const x = n + 1; return x * 2; }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "f" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/single|expression|one returned|multi/i);
  });

  it("rejects a generic function", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export function id<T>(x: T): T { return x; }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "id" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/generic|type parameter/i);
  });

  it("rejects a destructured parameter", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export function f({ a }: { a: number }): number { return a; }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "f" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/parameter|identifier|destructur/i);
  });
});

describe("analyzeInline — body scan", () => {
  it("accepts a body using only params + globals", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export function clamp(n: number, lo: number, hi: number): number { return Math.min(Math.max(n, lo), hi); }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "clamp" });
    expect(r.ok).toBe(true);
  });

  it("rejects a body referencing a module-local free variable", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `const BASE = 10;\nexport function scaled(n: number): number { return n * BASE; }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 1, name: "scaled" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/BASE|self-contained|scope/i);
  });

  it("rejects a body referencing an imported symbol", () => {
    const rendered = new Map<string, string>([
      ["/p/c.ts", `export const K = 2;\n`],
      ["/p/a.ts", `import { K } from "./c.ts";\nexport function f(n: number): number { return n * K; }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 1, name: "f" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/K|self-contained|scope/i);
  });

  it("rejects a recursive function", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export function f(n: number): number { return n <= 0 ? 0 : f(n - 1); }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "f" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/recurs/i);
  });

  it("rejects a body using this", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export function f(): number { return (this as any).x; }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "f" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/this|super|arguments/i);
  });

  it("rejects a body using await", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export async function f(p: Promise<number>): Promise<number> { return await p; }\n`]
    ]);
    const r = analyzeInline(rendered, OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "f" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/await|async/i);
  });
});

describe("analyzeInline — reference discovery + call classification", () => {
  const fn = `export function dbl(n: number): number { return n * 2; }\n`;

  it("accepts direct calls across modules and records call-site count", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", fn],
      ["/p/b.ts", `import { dbl } from "./a.ts";\nexport const y = dbl(3);\n`],
      ["/p/c.ts", `import { dbl } from "./a.ts";\nexport const z = dbl(4);\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.callSites.length).toBe(2);
  });

  it("rejects a non-call value use (passed as a callback)", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", fn],
      ["/p/b.ts", `import { dbl } from "./a.ts";\nexport const ys = [1, 2].map(dbl);\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/value|callback|not a (direct )?call/i);
  });

  it("rejects a re-export", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", fn],
      ["/p/b.ts", `export { dbl } from "./a.ts";\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/re-export|export .* from|value|not a (direct )?call/i);
  });

  it("rejects a spread-argument call", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", fn],
      ["/p/b.ts", `import { dbl } from "./a.ts";\nconst args: [number] = [3];\nexport const y = dbl(...args);\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/spread|arity|argument/i);
  });

  it("rejects an arity mismatch", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", `export function add(a: number, b: number): number { return a + b; }\n`],
      ["/p/b.ts", `import { add } from "./a.ts";\nexport const y = (add as any)(1);\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "add" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/arity|argument count/i);
  });
});

describe("analyzeInline — argument purity + substitution", () => {
  it("substitutes pure args into the body, parenthesized", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", `export function add(a: number, b: number): number { return a + b; }\n`],
      ["/p/b.ts", `import { add } from "./a.ts";\nexport const y = add(x, 2);\nconst x = 1;\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "add" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.callSites).toHaveLength(1);
    expect(r.callSites[0]!.replacementText).toBe("(x + 2)");
  });

  it("substitutes a member-access pure arg and handles a multiply-used param", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", `export function sq(n: number): number { return n * n; }\n`],
      ["/p/b.ts", `import { sq } from "./a.ts";\ndeclare const o: { v: number };\nexport const y = sq(o.v);\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "sq" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.callSites[0]!.replacementText).toBe("(o.v * o.v)");
  });

  it("rejects an impure argument (call expression)", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", `export function dbl(n: number): number { return n * 2; }\n`],
      ["/p/b.ts", `import { dbl } from "./a.ts";\ndeclare function side(): number;\nexport const y = dbl(side());\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/pure|side effect|argument/i);
  });

  it("rejects an impure argument (await/assignment)", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", `export function dbl(n: number): number { return n * 2; }\n`],
      ["/p/b.ts", `import { dbl } from "./a.ts";\nlet k = 0;\nexport const y = dbl((k += 1));\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/pure|side effect|argument/i);
  });
});

describe("analyzeInline — importer strip plan", () => {
  const fn = `export function dbl(n: number): number { return n * 2; }\n`;

  it("plans removed-statement for a sole-binding importer", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", fn],
      ["/p/b.ts", `import { dbl } from "./a.ts";\nexport const y = dbl(1);\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const strip = r.importerStrips.find((s) => s.importerPath.endsWith("b.ts"))!;
    expect(strip.style).toBe("removed-statement");
  });

  it("plans removed-binding for a mixed-binding importer", () => {
    const r = analyzeInline(new Map([
      ["/p/a.ts", `export function dbl(n: number): number { return n * 2; }\nexport const OTHER = 1;\n`],
      ["/p/b.ts", `import { dbl, OTHER } from "./a.ts";\nexport const y = dbl(OTHER);\n`]
    ]), OPTIONS, { functionPath: "/p/a.ts", functionChildIndex: 0, name: "dbl" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const strip = r.importerStrips.find((s) => s.importerPath.endsWith("b.ts"))!;
    expect(strip.style).toBe("removed-binding");
    expect(strip.removeName).toBe("dbl");
  });
});
