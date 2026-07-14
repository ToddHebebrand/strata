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

export interface KernelSnapshotV1 {
  schemaVersion: 1;
  generation: 0;
  nodes: KernelNodeV1[];
  references: KernelReferenceV1[];
}

export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function toKernelSnapshot(batch: IngestBatchResult): KernelSnapshotV1 {
  return {
    schemaVersion: 1,
    generation: 0,
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
