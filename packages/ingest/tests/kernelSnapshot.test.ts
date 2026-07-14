import { describe, expect, it } from "vitest";
import { ingestBatch, toKernelSnapshot } from "../src/index";

describe("kernel snapshot bridge", () => {
  it("emits sorted schema-v1 camelCase records", () => {
    const batch = ingestBatch([
      { path: "/project/b.ts", text: "export const b = 1;\n" },
      { path: "/project/a.ts", text: "export const a = 1;\n" }
    ]);
    const snapshot = toKernelSnapshot(batch);
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.generation).toBe(0);
    expect(snapshot.nodes.map((n) => n.id)).toEqual(
      [...snapshot.nodes.map((n) => n.id)].sort()
    );
    expect(snapshot.references.map((r) => r.fromNodeId)).toEqual(
      [...snapshot.references.map((r) => r.fromNodeId)].sort()
    );
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});
