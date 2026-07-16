import { describe, expect, it } from "vitest";
import {
  ingestBatch,
  parseCanonicalU64,
  toKernelSnapshot,
  toRustGraphSnapshotFixture,
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
    expect(snapshot.generation).toBe("0");
    expect(snapshot.nodes.map((n) => n.id)).toEqual(
      [...snapshot.nodes.map((n) => n.id)].sort()
    );
    expect(snapshot.references.map((r) => r.fromNodeId)).toEqual(
      [...snapshot.references.map((r) => r.fromNodeId)].sort()
    );
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it.each(["0", "18446744073709551615"])(
    "accepts canonical unsigned decimal generation %s",
    (generation) => {
      expect(parseCanonicalU64(generation)).toBe(generation);
    }
  );

  it.each([
    "-1",
    "+1",
    "01",
    "1.0",
    "1e3",
    " 1",
    "1 ",
    1,
    "18446744073709551616"
  ])("rejects noncanonical or out-of-range generation %j", (generation) => {
    expect(() => parseCanonicalU64(generation)).toThrow();
  });

  it("defaults bridge snapshots to canonical generation zero", () => {
    const snapshot = toKernelSnapshot(ingestBatch([]));
    expect(snapshot.generation).toBe("0");
  });

  it("adapts only a safe generation for legacy Rust fixtures", () => {
    const snapshot = toKernelSnapshot(
      ingestBatch([{ path: "/project/a.ts", text: "export const a = 1;\n" }]),
      parseCanonicalU64("42")
    );

    const fixture = toRustGraphSnapshotFixture(snapshot);

    expect(fixture.generation).toBe(42);
    expect(fixture.nodes).toBe(snapshot.nodes);
    expect(fixture.references).toBe(snapshot.references);
    expect({ ...fixture, generation: snapshot.generation }).toEqual(snapshot);
    expect(() =>
      toRustGraphSnapshotFixture({
        ...snapshot,
        generation: parseCanonicalU64("9007199254740992")
      })
    ).toThrow(/safe integer/i);
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
