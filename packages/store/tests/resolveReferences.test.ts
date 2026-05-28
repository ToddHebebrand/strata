import { describe, expect, it } from "vitest";
import ts from "typescript";
import { resolveReferencesForModules } from "../src/resolveReferences";
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

describe("resolveReferencesForModules", () => {
  it("emits an edge from a use to its declaration identifier", () => {
    const rendered = new Map<string, string>([
      ["m.ts", `function f(): number { return 1; }\nconst y = f();\n`]
    ]);
    const refs = resolveReferencesForModules(rendered, OPTIONS, ["m.ts"]);
    const declNameId = nodeId("m.ts", [0, 0], "Identifier");
    expect(refs.some((r) => r.toNodeId === declNameId && r.kind === "value")).toBe(true);
  });
});
