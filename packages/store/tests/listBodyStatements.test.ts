import { describe, expect, it } from "vitest";
import { listBodyStatements } from "../src/extractAnalysis";
import { ingestBatch } from "@strata-code/ingest";
import { openDb } from "../src/schema";
import { insertNodes } from "../src/nodes";
import { read_node } from "../src/read_node";
import { nodeId } from "../src/ids";

describe("listBodyStatements", () => {
  it("enumerates the top-level body statements of a function payload in order", () => {
    const payload = `export function f(a: number): number {\n  const b = a + 1;\n  const c = b * 2;\n  return c;\n}`;
    const stmts = listBodyStatements(payload);
    expect(stmts.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(stmts[0]!.text).toBe("const b = a + 1;");
    expect(stmts[1]!.text).toBe("const c = b * 2;");
    expect(stmts[2]!.text).toBe("return c;");
  });

  it("returns [] for a payload whose first statement is not a function declaration", () => {
    expect(listBodyStatements(`export const x = 1;`)).toEqual([]);
  });
});

it("read_node attaches bodyStatements for a FunctionDeclaration", () => {
  const batch = ingestBatch([
    { path: "m.ts", text: `export function f(a: number): number {\n  const b = a + 1;\n  return b;\n}\n` }
  ]);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  const fnId = nodeId("m.ts", [0], "FunctionDeclaration");
  const result = read_node(db, fnId);
  expect(result?.bodyStatements?.map((s) => s.index)).toEqual([0, 1]);
  db.close();
});
