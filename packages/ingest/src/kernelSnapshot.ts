import type { IngestBatchResult } from "./batch";

export interface KernelNodeV1 {
  id: string;
  kind: string;
  parentId: string | null;
  childIndex: number | null;
  payload: string;
}

export interface KernelReferenceV1 {
  fromNodeId: string;
  toNodeId: string;
  kind: string;
}

export type CanonicalU64 = string & {
  readonly __canonicalU64: unique symbol;
};

export interface KernelSnapshotV1 {
  schemaVersion: 1;
  generation: CanonicalU64;
  nodes: KernelNodeV1[];
  references: KernelReferenceV1[];
}

export interface RustGraphSnapshotFixtureV1 {
  schemaVersion: 1;
  generation: number;
  nodes: KernelNodeV1[];
  references: KernelReferenceV1[];
}

const MAX_U64 = 2n ** 64n - 1n;
const CANONICAL_U64_PATTERN = /^(0|[1-9][0-9]*)$/;

export function parseCanonicalU64(value: unknown): CanonicalU64 {
  if (
    typeof value !== "string" ||
    !CANONICAL_U64_PATTERN.test(value) ||
    BigInt(value) > MAX_U64
  ) {
    throw new TypeError("expected a canonical unsigned 64-bit decimal string");
  }
  return value as CanonicalU64;
}

export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function toKernelSnapshot(
  batch: IngestBatchResult,
  generation: CanonicalU64 = parseCanonicalU64("0")
): KernelSnapshotV1 {
  return {
    schemaVersion: 1,
    generation,
    nodes: batch.allNodes
      .map(({ id, kind, parentId, childIndex, payload }) => ({
        id,
        kind,
        parentId,
        childIndex,
        payload
      }))
      .sort((a, b) => compareCodeUnits(a.id, b.id)),
    references: batch.references
      .map(({ fromNodeId, toNodeId, kind }) => ({ fromNodeId, toNodeId, kind }))
      .sort(
        (a, b) =>
          compareCodeUnits(a.fromNodeId, b.fromNodeId) ||
          compareCodeUnits(a.toNodeId, b.toNodeId) ||
          compareCodeUnits(a.kind, b.kind)
      )
  };
}

export function toRustGraphSnapshotFixture(
  snapshot: KernelSnapshotV1
): RustGraphSnapshotFixtureV1 {
  const generation = Number(snapshot.generation);
  if (!Number.isSafeInteger(generation)) {
    throw new RangeError("legacy Rust fixture generation must be a safe integer");
  }
  return { ...snapshot, generation };
}
