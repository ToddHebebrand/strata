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

describe("analyzeMove — self-contained verification", () => {
  it("accepts a declaration that uses only globals + its own internals", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export function clamp(n: number, lo: number, hi: number): number {\n  return Math.min(Math.max(n, lo), hi);\n}\n`],
      ["/p/b.ts", `export const x = 1;\n`]
    ]);
    const r = analyzeMove(rendered, OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 0, name: "clamp", targetPath: "/p/b.ts" });
    expect(r.ok).toBe(true);
  });

  it("rejects a declaration that references a source-local symbol", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `const BASE = 10;\nexport function scaled(n: number): number { return n * BASE; }\n`],
      ["/p/b.ts", `export const x = 1;\n`]
    ]);
    // scaled is statements[1]; it references BASE (source-local, statements[0]).
    const r = analyzeMove(rendered, OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 1, name: "scaled", targetPath: "/p/b.ts" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/BASE|self-contained|depends/i);
  });

  it("rejects a declaration that references an imported symbol", () => {
    const rendered = new Map<string, string>([
      ["/p/types.ts", `export type User = { id: string };\n`],
      ["/p/a.ts", `import { User } from "./types.ts";\nexport function idOf(u: User): string { return u.id; }\n`],
      ["/p/b.ts", `export const x = 1;\n`]
    ]);
    const r = analyzeMove(rendered, OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 1, name: "idOf", targetPath: "/p/b.ts" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/User|self-contained|depends/i);
  });

  it("accepts a declaration that references a symbol already in the target", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `import { User } from "./b.ts";\nexport function idOf(u: User): string { return u.id; }\n`],
      ["/p/b.ts", `export type User = { id: string };\n`]
    ]);
    // idOf uses User which lives in the TARGET (b.ts) — in scope after the move.
    const r = analyzeMove(rendered, OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 1, name: "idOf", targetPath: "/p/b.ts" });
    expect(r.ok).toBe(true);
  });
});

describe("analyzeMove — importer classification", () => {
  const base = (extra: Record<string, string>) =>
    new Map<string, string>([
      ["/p/a.ts", `export type Id = string;\n`],
      ["/p/b.ts", `export const x = 1;\n`],
      ...Object.entries(extra)
    ]);

  it("rejects a namespace importer", () => {
    const r = analyzeMove(
      base({ "/p/c.ts": `import * as A from "./a.ts";\nexport const y: A.Id = "1";\n` }),
      OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 0, name: "Id", targetPath: "/p/b.ts" }
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/namespace|import \*/i);
  });

  it("rejects a re-export importer", () => {
    const r = analyzeMove(
      base({ "/p/c.ts": `export { Id } from "./a.ts";\n` }),
      OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 0, name: "Id", targetPath: "/p/b.ts" }
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/re-export|export .* from/i);
  });

  it("accepts named importers (sole and mixed) and records them", () => {
    const r = analyzeMove(
      base({
        "/p/c.ts": `import { Id } from "./a.ts";\nexport const y: Id = "1";\n`,
        "/p/d.ts": `import { Id, } from "./a.ts";\nimport { x } from "./b.ts";\nexport const z: Id = "2";\n`
      }),
      OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 0, name: "Id", targetPath: "/p/b.ts" }
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.importerRewrites.map((i) => i.importerPath).sort()).toEqual(
      [normalizePathTest("/p/c.ts"), normalizePathTest("/p/d.ts")].sort()
    );
  });
});

describe("analyzeMove — dynamic import rejection", () => {
  it("rejects a module that dynamically imports the source module", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export type Id = string;\nexport const ID_NAME = "id";\n`],
      ["/p/b.ts", `export const x = 1;\n`],
      ["/p/c.ts", `export async function load() {\n  const m = await import("./a.ts");\n  return m.ID_NAME;\n}\n`]
    ]);
    const r = analyzeMove(rendered, OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 1, name: "ID_NAME", targetPath: "/p/b.ts" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/dynamic/i);
  });

  it("does NOT reject a dynamic import of an UNRELATED module", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export type Id = string;\nexport const ID_NAME = "id";\n`],
      ["/p/b.ts", `export const x = 1;\n`],
      ["/p/other.ts", `export const z = 2;\n`],
      ["/p/c.ts", `import { ID_NAME } from "./a.ts";\nexport async function load() {\n  const m = await import("./other.ts");\n  return [ID_NAME, m.z];\n}\n`]
    ]);
    // c.ts imports ID_NAME normally (named) AND dynamically imports an unrelated module.
    // The dynamic import is to ./other.ts (not the source), so it must NOT trigger the dynamic rejection;
    // the named import of ID_NAME from ./a.ts should be handled normally (path-rewrite).
    const r = analyzeMove(rendered, OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 1, name: "ID_NAME", targetPath: "/p/b.ts" });
    expect(r.ok).toBe(true);
  });
});

describe("analyzeMove — rewrite computation", () => {
  it("sole import → specifier path rewrite, style preserved (.ts kept)", () => {
    const rendered = new Map<string, string>([
      ["/p/sub/a.ts", `export type Id = string;\n`],
      ["/p/lib/b.ts", `export const x = 1;\n`],
      ["/p/c.ts", `import { Id } from "./sub/a.ts";\nexport const y: Id = "1";\n`]
    ]);
    const r = analyzeMove(rendered, OPTIONS, { sourcePath: "/p/sub/a.ts", declChildIndex: 0, name: "Id", targetPath: "/p/lib/b.ts" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rw = r.importerRewrites.find((i) => i.importerPath.endsWith("c.ts"))!;
    expect(rw.style).toBe("path-rewrite");
    // c.ts is at /p/c.ts; target /p/lib/b.ts → "./lib/b.ts"
    expect(rw.newSpecifier).toBe(`"./lib/b.ts"`);
    expect(rw.oldSpecifier).toBe(`"./sub/a.ts"`);
  });

  it("mixed import → remove the binding + add a new target import", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export type Id = string;\nexport type Other = number;\n`],
      ["/p/b.ts", `export const x = 1;\n`],
      ["/p/c.ts", `import { Id, Other } from "./a.ts";\nexport const y: Id = "1";\nexport const z: Other = 2;\n`]
    ]);
    const r = analyzeMove(rendered, OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 0, name: "Id", targetPath: "/p/b.ts" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rw = r.importerRewrites.find((i) => i.importerPath.endsWith("c.ts"))!;
    expect(rw.style).toBe("split-out");
    expect(rw.removeName).toBe("Id");
    expect(rw.newImportText).toBe(`import { Id } from "./b.ts";`);
  });

  it("detects source self-use", () => {
    const rendered = new Map<string, string>([
      ["/p/a.ts", `export type Id = string;\nexport const first: Id = "1";\n`],
      ["/p/b.ts", `export const x = 1;\n`]
    ]);
    // a.ts itself uses Id (in `first`), so after moving Id a back-import is needed.
    const r = analyzeMove(rendered, OPTIONS, { sourcePath: "/p/a.ts", declChildIndex: 0, name: "Id", targetPath: "/p/b.ts" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sourceStillUses).toBe(true);
  });
});

// helper mirroring resolveReferences.normalizePath for assertion convenience
function normalizePathTest(p: string): string {
  return p.replaceAll("\\", "/").replace(/^\.\//, "");
}
