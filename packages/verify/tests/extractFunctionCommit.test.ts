import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { openDb, insertNodes, insertReferences, begin, nodeId } from "@strata/store";
import { buildAnalysisContext } from "../src/validate";

function seed(path: string, text: string) {
  const batch = ingestBatch([{ path, text }]);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  return db;
}

describe("buildAnalysisContext", () => {
  it("returns rendered text keyed by resolved path plus compiler options", () => {
    const db = seed("/project/m.ts", `export function f(a: number): number {\n  const b = a + 1;\n  return b;\n}\n`);
    const tx = begin(db, "test");
    const { renderedByPath, options } = buildAnalysisContext(db, tx);
    // The module's rendered text is present and contains the function.
    const text = [...renderedByPath.values()].join("\n");
    expect(text).toContain("function f");
    expect(options.target).toBeDefined();
    db.close();
  });
});
