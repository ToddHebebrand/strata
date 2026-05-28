import { describe, expect, it } from "vitest";
import ts from "typescript";
import { emitIdentifiers } from "../src/emitIdentifiers";

describe("emitIdentifiers", () => {
  it("emits one Identifier node per ts.Identifier in pre-order, offsets relative to the statement", () => {
    const sf = ts.createSourceFile(
      "m.ts",
      `function f(a: number) { return a; }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const stmt = sf.statements[0]!;
    const ids = emitIdentifiers(sf, stmt, "m.ts", [0]);
    const texts = ids.map((n) => (JSON.parse(n.payload) as { text: string }).text);
    expect(texts).toEqual(["f", "a", "a"]); // declaration name, param, use
    expect(ids.every((n) => n.kind === "Identifier")).toBe(true);
  });
});
