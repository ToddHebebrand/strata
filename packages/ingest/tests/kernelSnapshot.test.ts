import { describe, expect, it } from "vitest";
import {
  ingestBatch,
  toKernelSnapshot,
  type IngestBatchResult
} from "../src/index";

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

  it("orders canonical records by locale-independent UTF-16 code units", () => {
    const node = (id: string) => ({
      id,
      kind: "Identifier",
      parentId: null,
      childIndex: null,
      payload: id
    });
    const batch: IngestBatchResult = {
      allNodes: [node("a"), node("~"), node("Z"), node("_")],
      references: [
        { fromNodeId: "a", toNodeId: "Z", kind: "~" },
        { fromNodeId: "Z", toNodeId: "a", kind: "_" },
        { fromNodeId: "Z", toNodeId: "_", kind: "a" },
        { fromNodeId: "Z", toNodeId: "_", kind: "Z" }
      ],
      modules: []
    };

    const snapshot = toKernelSnapshot(batch);

    expect(snapshot.nodes.map(({ id }) => id)).toEqual(["Z", "_", "a", "~"]);
    expect(
      snapshot.references.map(({ fromNodeId, toNodeId, kind }) => [
        fromNodeId,
        toNodeId,
        kind
      ])
    ).toEqual([
      ["Z", "_", "Z"],
      ["Z", "_", "a"],
      ["Z", "a", "_"],
      ["a", "Z", "~"]
    ]);
  });
});
