import { describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { insertNodes, listChildren, modulePathOf } from "../src/nodes";
import { find_declarations } from "../src/queries";
import { openDb } from "../src/schema";

describe("modulePathOf", () => {
  it("returns the module path for a declaration and a nested statement", () => {
    const batch = ingestBatch([
      {
        path: "lib/format.ts",
        text:
          "export function formatTimestamp(ts: number): string {\n" +
          "  return new Date(ts).toISOString();\n" +
          "}\n"
      }
    ]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    const decl = find_declarations(db, {
      name: "formatTimestamp",
      kind: "function"
    })[0]!;
    expect(modulePathOf(db, decl.id)).toBe("lib/format.ts");

    const child = listChildren(db, decl.id)[0]!;
    expect(child).toBeDefined();
    expect(child.id).not.toBe(decl.id);
    expect(modulePathOf(db, child.id)).toBe("lib/format.ts");

    db.close();
  });

  it("throws a clear error for an unknown node id", () => {
    const db = openDb(":memory:");
    expect(() => modulePathOf(db, "nonexistent")).toThrow(
      /modulePathOf: node not found:/i
    );
    db.close();
  });
});
