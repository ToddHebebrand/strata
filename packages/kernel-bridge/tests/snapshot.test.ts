import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ingestBatch,
  parseCanonicalU64,
  toKernelSnapshot,
  type KernelNodeV1,
  type KernelReferenceV1,
  type KernelSnapshotV1
} from "@strata-code/ingest";
import { insertNodes, insertReferences, openDb } from "@strata-code/store";
import { describe, expect, it } from "vitest";
import {
  applyDelta,
  diffSnapshots,
  exportSnapshot,
  hydrateSnapshot
} from "../src/index";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

function loadMediumCorpus(): { path: string; text: string }[] {
  const root = path.resolve(currentDir, "../../../examples/medium/src");
  const modules: { path: string; text: string }[] = [];

  function walk(directory: string): void {
    for (const entry of readdirSync(directory).sort()) {
      const absolutePath = path.join(directory, entry);
      if (statSync(absolutePath).isDirectory()) {
        walk(absolutePath);
      } else if (entry.endsWith(".ts")) {
        modules.push({
          path: path.relative(root, absolutePath).replaceAll(path.sep, "/"),
          text: readFileSync(absolutePath, "utf8")
        });
      }
    }
  }

  walk(root);
  return modules;
}

function mediumSnapshot(): KernelSnapshotV1 {
  return toKernelSnapshot(
    ingestBatch(loadMediumCorpus()),
    parseCanonicalU64("7")
  );
}

function node(id: string, payload = id): KernelNodeV1 {
  return { id, kind: "Identifier", parentId: null, childIndex: null, payload };
}

function reference(
  fromNodeId: string,
  toNodeId: string,
  kind = "value"
): KernelReferenceV1 {
  return { fromNodeId, toNodeId, kind };
}

function snapshot(
  generation: string,
  nodes: KernelNodeV1[],
  references: KernelReferenceV1[] = []
): KernelSnapshotV1 {
  return {
    schemaVersion: 1,
    generation: parseCanonicalU64(generation),
    nodes,
    references
  };
}

describe("scratch graph snapshot adapters", () => {
  it("round-trips the ingest-derived examples/medium graph byte-equivalently", () => {
    const input = mediumSnapshot();
    expect(input.nodes.length).toBeGreaterThan(1_000);
    expect(input.references.length).toBeGreaterThan(500);

    const db = hydrateSnapshot(input);
    try {
      expect(JSON.stringify(exportSnapshot(db, input.generation))).toBe(
        JSON.stringify(input)
      );
    } finally {
      db.close();
    }
  });

  it("canonicalizes reversed SQLite insertion order and ignores scratch history rows", () => {
    const input = mediumSnapshot();
    const db = openDb(":memory:");
    try {
      insertNodes(db, [...input.nodes].reverse());
      insertReferences(
        db,
        [...input.references].reverse().map((item) => ({
          ...item,
          kind: item.kind as "value" | "type" | "namespace"
        }))
      );
      db.prepare(
        `INSERT INTO transactions (tx_id, started_at, status, actor)
         VALUES ('scratch-tx', 1, 'open', 'worker')`
      ).run();
      db.prepare(
        `INSERT INTO operations
           (op_id, tx_id, kind, params_json, affected_node_ids_json, actor, ts)
         VALUES ('scratch-op', 'scratch-tx', 'RenameSymbol', '{}', '[]', 'worker', 1)`
      ).run();

      expect(JSON.stringify(exportSnapshot(db, input.generation))).toBe(
        JSON.stringify(input)
      );
    } finally {
      db.close();
    }
  });

  it.each([
    {
      label: "duplicate node IDs",
      value: snapshot("0", [node("a"), node("a")]),
      message: /duplicate node id/i
    },
    {
      label: "duplicate reference sources",
      value: snapshot(
        "0",
        [node("a"), node("b")],
        [reference("a", "b"), reference("a", "b", "type")]
      ),
      message: /duplicate reference source/i
    },
    {
      label: "dangling parents",
      value: snapshot("0", [
        { ...node("a"), parentId: "missing", childIndex: 0 }
      ]),
      message: /dangling parent/i
    },
    {
      label: "dangling reference endpoints",
      value: snapshot("0", [node("a")], [reference("a", "missing")]),
      message: /reference endpoint/i
    },
    {
      label: "negative child indexes",
      value: snapshot("0", [
        { ...node("a"), parentId: "a", childIndex: -1 }
      ]),
      message: />=0/i
    },
    {
      label: "fractional child indexes",
      value: snapshot("0", [
        { ...node("a"), parentId: "a", childIndex: 0.5 }
      ]),
      message: /expected int/i
    }
  ])("rejects $label before scratch hydration", ({ value, message }) => {
    expect(() => hydrateSnapshot(value)).toThrow(message);
  });

  it("rejects graph rows that cannot be exported as the hydrated snapshot contract", () => {
    const db = openDb(":memory:");
    try {
      db.prepare(
        `INSERT INTO nodes (id, kind, parent_id, child_index, payload)
         VALUES ('a', 'Identifier', NULL, -1, 'a')`
      ).run();
      expect(() => exportSnapshot(db, parseCanonicalU64("0"))).toThrow(
        />=0/i
      );
    } finally {
      db.close();
    }
  });

  it("orders node/reference deletes before upserts and applies the delta", () => {
    const before = snapshot(
      "7",
      [node("a", "old-a"), node("b"), node("c"), node("d")],
      [reference("b", "a"), reference("d", "c")]
    );
    const after = snapshot(
      "8",
      [node("a", "new-a"), node("b"), node("c"), node("e")],
      [reference("b", "c", "type"), reference("e", "a")]
    );

    const delta = diffSnapshots(before, after);

    expect(delta).toEqual({
      schemaVersion: 1,
      baseGeneration: "7",
      changes: [
        { type: "deleteNode", nodeId: "d" },
        { type: "upsertNode", node: node("a", "new-a") },
        { type: "upsertNode", node: node("e") },
        { type: "deleteReference", fromNodeId: "d" },
        {
          type: "upsertReference",
          reference: reference("b", "c", "type")
        },
        { type: "upsertReference", reference: reference("e", "a") }
      ]
    });
    expect(applyDelta(before, delta)).toEqual(after);
    expect(before.nodes.find(({ id }) => id === "a")?.payload).toBe("old-a");
  });

  it("uses locale-independent code-unit tie-breakers for canonical upserts", () => {
    const before = snapshot("0", [node("Z"), node("_")]);
    const after = snapshot(
      "1",
      [node("Z", "changed"), node("_"), node("a"), node("~")],
      [reference("Z", "~", "a"), reference("_", "Z", "~")]
    );

    expect(diffSnapshots(before, after).changes).toEqual([
      { type: "upsertNode", node: node("Z", "changed") },
      { type: "upsertNode", node: node("a") },
      { type: "upsertNode", node: node("~") },
      { type: "upsertReference", reference: reference("Z", "~", "a") },
      { type: "upsertReference", reference: reference("_", "Z", "~") }
    ]);
  });

  it("rejects mismatched generations and invalid applied graph integrity", () => {
    const before = snapshot("3", [node("a"), node("b")], [reference("b", "a")]);
    expect(() => diffSnapshots(before, { ...before, generation: parseCanonicalU64("3") }))
      .toThrow(/generation 4/i);
    expect(() =>
      applyDelta(before, {
        schemaVersion: 1,
        baseGeneration: parseCanonicalU64("2"),
        changes: []
      })
    ).toThrow(/base generation/i);
    expect(() =>
      applyDelta(before, {
        schemaVersion: 1,
        baseGeneration: before.generation,
        changes: [{ type: "deleteNode", nodeId: "a" }]
      })
    ).toThrow(/reference endpoint/i);
  });
});
