import {
  compareCodeUnits,
  parseCanonicalU64,
  type CanonicalU64,
  type KernelNodeV1,
  type KernelReferenceV1,
  type KernelSnapshotV1
} from "@strata-code/ingest";
import {
  insertNodes,
  insertReferences,
  openDb,
  type Db,
  type Reference
} from "@strata-code/store";
import {
  kernelGraphDeltaV1Schema,
  kernelSnapshotV1Schema,
  type KernelGraphDeltaV1
} from "./protocol";

export type KernelGraphChangeV1 = KernelGraphDeltaV1["changes"][number];

interface NodeDbRow {
  id: string;
  kind: string;
  parent_id: string | null;
  child_index: number | null;
  payload: string;
}

interface ReferenceDbRow {
  from_node_id: string;
  to_node_id: string;
  kind: string;
}

function compareReferences(a: KernelReferenceV1, b: KernelReferenceV1): number {
  return (
    compareCodeUnits(a.fromNodeId, b.fromNodeId) ||
    compareCodeUnits(a.toNodeId, b.toNodeId) ||
    compareCodeUnits(a.kind, b.kind)
  );
}

function sameNode(a: KernelNodeV1, b: KernelNodeV1): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.parentId === b.parentId &&
    a.childIndex === b.childIndex &&
    a.payload === b.payload
  );
}

function sameReference(
  a: KernelReferenceV1,
  b: KernelReferenceV1
): boolean {
  return (
    a.fromNodeId === b.fromNodeId &&
    a.toNodeId === b.toNodeId &&
    a.kind === b.kind
  );
}

function nextGeneration(generation: CanonicalU64): CanonicalU64 {
  return parseCanonicalU64((BigInt(generation) + 1n).toString());
}

function assertSnapshot(value: KernelSnapshotV1): KernelSnapshotV1 {
  return kernelSnapshotV1Schema.parse(value);
}

export function hydrateSnapshot(snapshot: KernelSnapshotV1): Db {
  const canonical = assertSnapshot(snapshot);
  const db = openDb(":memory:");

  try {
    insertNodes(db, canonical.nodes);
    insertReferences(
      db,
      canonical.references.map((reference) => ({
        ...reference,
        // The wire/Rust schema deliberately keeps reference kinds extensible.
        // SQLite stores the value verbatim; this cast crosses the older store's
        // narrower TypeScript union without changing the runtime record.
        kind: reference.kind as Reference["kind"]
      }))
    );

    const exported = exportSnapshot(db, canonical.generation);
    if (JSON.stringify(exported) !== JSON.stringify(canonical)) {
      throw new Error("scratch hydration/export mismatch");
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function exportSnapshot(
  db: Db,
  generation: CanonicalU64
): KernelSnapshotV1 {
  const nodes = (db
    .prepare(
      `SELECT id, kind, parent_id, child_index, payload
       FROM nodes`
    )
    .all() as NodeDbRow[])
    .map((row): KernelNodeV1 => ({
      id: row.id,
      kind: row.kind,
      parentId: row.parent_id,
      childIndex: row.child_index,
      payload: row.payload
    }))
    .sort((a, b) => compareCodeUnits(a.id, b.id));

  const references = (db
    .prepare(
      `SELECT from_node_id, to_node_id, kind
       FROM node_references`
    )
    .all() as ReferenceDbRow[])
    .map((row): KernelReferenceV1 => ({
      fromNodeId: row.from_node_id,
      toNodeId: row.to_node_id,
      kind: row.kind
    }))
    .sort(compareReferences);

  return assertSnapshot({ schemaVersion: 1, generation, nodes, references });
}

export function diffSnapshots(
  before: KernelSnapshotV1,
  after: KernelSnapshotV1
): KernelGraphDeltaV1 {
  const canonicalBefore = assertSnapshot(before);
  const canonicalAfter = assertSnapshot(after);
  const expectedGeneration = nextGeneration(canonicalBefore.generation);
  if (canonicalAfter.generation !== expectedGeneration) {
    throw new Error(
      `after snapshot must have generation ${expectedGeneration}, received ${canonicalAfter.generation}`
    );
  }

  const beforeNodes = new Map(canonicalBefore.nodes.map((item) => [item.id, item]));
  const afterNodes = new Map(canonicalAfter.nodes.map((item) => [item.id, item]));
  const beforeReferences = new Map(
    canonicalBefore.references.map((item) => [item.fromNodeId, item])
  );
  const afterReferences = new Map(
    canonicalAfter.references.map((item) => [item.fromNodeId, item])
  );

  const nodeDeletes: KernelGraphChangeV1[] = canonicalBefore.nodes
    .filter((item) => !afterNodes.has(item.id))
    .map((item) => ({ type: "deleteNode", nodeId: item.id }));
  const nodeUpserts: KernelGraphChangeV1[] = canonicalAfter.nodes
    .filter((item) => {
      const previous = beforeNodes.get(item.id);
      return previous === undefined || !sameNode(previous, item);
    })
    .map((item) => ({ type: "upsertNode", node: item }));
  const referenceDeletes: KernelGraphChangeV1[] = canonicalBefore.references
    .filter((item) => !afterReferences.has(item.fromNodeId))
    .map((item) => ({
      type: "deleteReference",
      fromNodeId: item.fromNodeId
    }));
  const referenceUpserts: KernelGraphChangeV1[] = canonicalAfter.references
    .filter((item) => {
      const previous = beforeReferences.get(item.fromNodeId);
      return previous === undefined || !sameReference(previous, item);
    })
    .map((item) => ({ type: "upsertReference", reference: item }));

  return kernelGraphDeltaV1Schema.parse({
    schemaVersion: 1,
    baseGeneration: canonicalBefore.generation,
    changes: [
      ...nodeDeletes,
      ...nodeUpserts,
      ...referenceDeletes,
      ...referenceUpserts
    ]
  });
}

export function applyDelta(
  before: KernelSnapshotV1,
  delta: KernelGraphDeltaV1
): KernelSnapshotV1 {
  const canonicalBefore = assertSnapshot(before);
  const canonicalDelta = kernelGraphDeltaV1Schema.parse(delta);
  if (canonicalDelta.baseGeneration !== canonicalBefore.generation) {
    throw new Error(
      `delta base generation ${canonicalDelta.baseGeneration} does not match snapshot generation ${canonicalBefore.generation}`
    );
  }

  const nodes = new Map(canonicalBefore.nodes.map((item) => [item.id, item]));
  const references = new Map(
    canonicalBefore.references.map((item) => [item.fromNodeId, item])
  );

  for (const change of canonicalDelta.changes) {
    switch (change.type) {
      case "deleteNode":
        nodes.delete(change.nodeId);
        break;
      case "upsertNode":
        nodes.set(change.node.id, change.node);
        break;
      case "deleteReference":
        references.delete(change.fromNodeId);
        break;
      case "upsertReference":
        references.set(change.reference.fromNodeId, change.reference);
        break;
    }
  }

  return assertSnapshot({
    schemaVersion: 1,
    generation: nextGeneration(canonicalBefore.generation),
    nodes: [...nodes.values()].sort((a, b) => compareCodeUnits(a.id, b.id)),
    references: [...references.values()].sort(compareReferences)
  });
}
