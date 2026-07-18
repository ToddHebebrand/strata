import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata-code/ingest";
import { begin, insertNodes, insertReferences, openDb } from "@strata-code/store";
import { renderPendingModules } from "../src/validate";

describe("renderPendingModules", () => {
  it("returns one rendered entry per module at the pending tx state", () => {
    const batch = ingestBatch([
      { path: "/c/src/a.ts", text: "export const a: number = 1;\n" }
    ]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);
    const tx = begin(db, "test");
    const { renderedFiles, sourceMaps } = renderPendingModules(db, tx);
    expect(renderedFiles.size).toBe(1);
    expect(sourceMaps.size).toBe(1);
    const text = [...renderedFiles.values()][0] as string;
    expect(text).toContain("const a: number = 1");
    db.close();
  });
});
