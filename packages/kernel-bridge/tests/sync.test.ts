// Worker-side mirror-sync gates (bridge-persistence slice, Task 6).
//
// The MirrorState under test is the persistent worker's long-lived mirror:
// hydrate replaces it, sync applies ordered published deltas transactionally,
// and every refusal must leave the database AND the attested identity exactly
// as they were (rollback gates). Digests come from the shared canonical sync
// digest (Task 2), so an attested identity here is byte-compatible with what
// the Rust daemon computes for the same graph.
import {
  ingestBatch,
  parseCanonicalU64,
  toKernelSnapshot,
  type KernelSnapshotV1
} from "@strata-code/ingest";
import { describe, expect, it } from "vitest";
import { analyzeIntent, analyzeIntentInDb } from "../src/analyze";
import type { IntentRecord, KernelGraphDeltaV1 } from "../src/protocol";
import { applyDelta, diffSnapshots } from "../src/snapshot";
import { canonicalSyncDigest } from "../src/sync-digest";
import {
  MirrorState,
  computeMirrorDigest,
  hydrateFrameSchema,
  mirrorAnalyzeRequestSchema,
  syncFrameSchema,
  type GraphIdentity
} from "../src/sync";

function identityOf(snapshot: KernelSnapshotV1): GraphIdentity {
  return {
    generation: snapshot.generation,
    digest: canonicalSyncDigest(snapshot.generation, snapshot.nodes, snapshot.references)
  };
}

function baseSnapshot(): KernelSnapshotV1 {
  return toKernelSnapshot(
    ingestBatch([
      {
        path: "main.ts",
        text:
          "export interface User {\n  id: string;\n}\n\n" +
          'export const current: User = { id: "u1" };\n'
      },
      {
        path: "other.ts",
        text: 'import { User } from "./main";\n\nexport const other: User = { id: "u2" };\n'
      }
    ]),
    parseCanonicalU64("3")
  );
}

/** A published-step delta: patch one node's payload with a marker. */
function patchDelta(snapshot: KernelSnapshotV1, marker: string): KernelGraphDeltaV1 {
  const target = snapshot.nodes.find((node) => node.payload.includes("export interface User"));
  expect(target).toBeDefined();
  const after: KernelSnapshotV1 = {
    ...snapshot,
    generation: parseCanonicalU64((BigInt(snapshot.generation) + 1n).toString()),
    nodes: snapshot.nodes.map((node) =>
      node.id === target!.id ? { ...node, payload: `${node.payload}// ${marker}\n` } : node
    )
  };
  return diffSnapshots(snapshot, after);
}

/** Three consecutive generations G, G+1, G+2 plus the two published deltas. */
function generationChain(): {
  g0: KernelSnapshotV1;
  g1: KernelSnapshotV1;
  g2: KernelSnapshotV1;
  d1: KernelGraphDeltaV1;
  d2: KernelGraphDeltaV1;
} {
  const g0 = baseSnapshot();
  const d1 = patchDelta(g0, "published-1");
  const g1 = applyDelta(g0, d1);
  const d2 = patchDelta(g1, "published-2");
  const g2 = applyDelta(g1, d2);
  return { g0, g1, g2, d1, d2 };
}

function hydrateAt(mirror: MirrorState, snapshot: KernelSnapshotV1): GraphIdentity {
  const target = identityOf(snapshot);
  const outcome = mirror.handleHydrate(
    hydrateFrameSchema.parse({
      requestId: "hydrate-0",
      kind: "hydrate",
      target,
      snapshot
    })
  );
  expect(outcome).toEqual({ kind: "attest", identity: target });
  return target;
}

function syncFrame(
  base: GraphIdentity,
  target: GraphIdentity,
  deltas: KernelGraphDeltaV1[]
) {
  return syncFrameSchema.parse({
    requestId: "sync-0",
    kind: "sync",
    base,
    target,
    deltas
  });
}

describe("mirror hydrate", () => {
  it("hydrates, recomputes the digest from the database, and attests", () => {
    const { g0 } = generationChain();
    const mirror = new MirrorState();
    const target = hydrateAt(mirror, g0);

    expect(mirror.attested()).toEqual(target);
    const db = mirror.databaseFor(target);
    expect(db).not.toBeNull();
    expect(computeMirrorDigest(db!, target.generation)).toBe(target.digest);
    mirror.close();
  });

  it("refuses a hydrate whose target digest does not match the snapshot", () => {
    const { g0 } = generationChain();
    const mirror = new MirrorState();
    const outcome = mirror.handleHydrate(
      hydrateFrameSchema.parse({
        requestId: "hydrate-bad",
        kind: "hydrate",
        target: { generation: g0.generation, digest: "0".repeat(64) },
        snapshot: g0
      })
    );
    expect(outcome).toEqual({ kind: "refuse", reason: "digest-mismatch", have: null });
    expect(mirror.attested()).toBeNull();
    mirror.close();
  });
});

describe("mirror sync", () => {
  it("gate (a): applies an ordered contiguous batch and attests the target", () => {
    // Worker at G, published G+2, contiguous batch [d1, d2] → attest (G+2, D2).
    const { g0, g2, d1, d2 } = generationChain();
    const mirror = new MirrorState();
    const base = hydrateAt(mirror, g0);
    const target = identityOf(g2);

    const outcome = mirror.handleSync(syncFrame(base, target, [d1, d2]));
    expect(outcome).toEqual({ kind: "attest", identity: target });
    expect(mirror.attested()).toEqual(target);
    const db = mirror.databaseFor(target);
    expect(db).not.toBeNull();
    // The database content IS the target generation, not merely the digest:
    expect(computeMirrorDigest(db!, target.generation)).toBe(target.digest);
    const payload = db!
      .prepare(`SELECT payload FROM nodes WHERE payload LIKE '%export interface User%'`)
      .all() as { payload: string }[];
    expect(payload).toHaveLength(1);
    expect(payload[0]!.payload).toContain("published-1");
    expect(payload[0]!.payload).toContain("published-2");
    mirror.close();
  });

  it("gate (b): refuses a duplicate delta and rolls the mirror back", () => {
    const { g0, g1, d1 } = generationChain();
    const mirror = new MirrorState();
    const base = hydrateAt(mirror, g0);
    // Duplicate: d1 twice — the second repeats base generation G, breaking
    // the chain mid-transaction.
    const bogusTarget = { ...identityOf(g1), generation: parseCanonicalU64("5") };
    const outcome = mirror.handleSync(syncFrame(base, bogusTarget, [d1, d1]));
    expect(outcome).toEqual({ kind: "refuse", reason: "gap", have: base });
    // Rolled back: still attested and byte-identical at G.
    expect(mirror.attested()).toEqual(base);
    const db = mirror.databaseFor(base);
    expect(computeMirrorDigest(db!, base.generation)).toBe(base.digest);
    mirror.close();
  });

  it("gate (c): refuses a gapped batch without touching the database", () => {
    const { g0, g2, d2 } = generationChain();
    const mirror = new MirrorState();
    const base = hydrateAt(mirror, g0);
    const target = identityOf(g2);

    // Batch starts at G+1's delta (base generation G+1) while the worker and
    // frame base are at G: mid-transaction chain break → gap + rollback.
    const outcome = mirror.handleSync(syncFrame(base, target, [d2]));
    expect(outcome).toEqual({ kind: "refuse", reason: "gap", have: base });
    expect(mirror.attested()).toEqual(base);
    expect(computeMirrorDigest(mirror.databaseFor(base)!, base.generation)).toBe(base.digest);

    // A frame whose BASE is already past the worker refuses before any work.
    const aheadBase = identityOf(applyDelta(g0, patchDelta(g0, "published-1")));
    const outcome2 = mirror.handleSync(syncFrame(aheadBase, target, [d2]));
    expect(outcome2).toEqual({ kind: "refuse", reason: "gap", have: base });
    mirror.close();
  });

  it("gate (d): digest mismatch rolls back and keeps the old attestation", () => {
    const { g0, g1, d1 } = generationChain();
    const mirror = new MirrorState();
    const base = hydrateAt(mirror, g0);
    const target = identityOf(g1);

    // Corrupt one delta change so the applied content cannot reach the
    // target digest.
    const corrupted: KernelGraphDeltaV1 = {
      ...d1,
      changes: d1.changes.map((change) =>
        change.type === "upsertNode"
          ? { ...change, node: { ...change.node, payload: `${change.node.payload}/*x*/` } }
          : change
      )
    };
    const outcome = mirror.handleSync(syncFrame(base, target, [corrupted]));
    expect(outcome).toEqual({ kind: "refuse", reason: "digest-mismatch", have: base });
    // The mirror is unchanged — the worker still attests the OLD identity
    // and the database recomputes to the OLD digest.
    expect(mirror.attested()).toEqual(base);
    const db = mirror.databaseFor(base);
    expect(db).not.toBeNull();
    expect(computeMirrorDigest(db!, base.generation)).toBe(base.digest);
    const payload = db!
      .prepare(`SELECT payload FROM nodes WHERE payload LIKE '%export interface User%'`)
      .all() as { payload: string }[];
    expect(payload[0]!.payload).not.toContain("/*x*/");
    mirror.close();
  });

  it("gate (e): refuses ahead when its attestation is past the frame base", () => {
    const { g0, g1, g2, d1, d2 } = generationChain();
    const mirror = new MirrorState();
    hydrateAt(mirror, g2);
    const attested = identityOf(g2);

    const outcome = mirror.handleSync(syncFrame(identityOf(g0), identityOf(g1), [d1]));
    expect(outcome).toEqual({ kind: "refuse", reason: "ahead", have: attested });
    // Forward-only: nothing moved.
    expect(mirror.attested()).toEqual(attested);
    expect(computeMirrorDigest(mirror.databaseFor(attested)!, attested.generation)).toBe(
      attested.digest
    );
    // Unused in this scenario but keeps the chain honest:
    void d2;
    mirror.close();
  });

  it("refuses a same-generation base whose digest differs, without touching the db", () => {
    const { g0, g1, d1 } = generationChain();
    const mirror = new MirrorState();
    const base = hydrateAt(mirror, g0);

    const outcome = mirror.handleSync(
      syncFrame({ ...base, digest: "f".repeat(64) }, identityOf(g1), [d1])
    );
    expect(outcome).toEqual({ kind: "refuse", reason: "digest-mismatch", have: base });
    expect(mirror.attested()).toEqual(base);
    mirror.close();
  });

  it("refuses with gap when it has no mirror at all", () => {
    const { g0, g1, d1 } = generationChain();
    const mirror = new MirrorState();
    const outcome = mirror.handleSync(syncFrame(identityOf(g0), identityOf(g1), [d1]));
    expect(outcome).toEqual({ kind: "refuse", reason: "gap", have: null });
  });
});

describe("mirror analyze", () => {
  function renameIntent(snapshot: KernelSnapshotV1, requestSuffix: string): IntentRecord {
    const declaration = snapshot.nodes.find((node) =>
      /export interface User\s*\{/.test(node.payload)
    );
    expect(declaration).toBeDefined();
    return {
      schemaVersion: 1,
      intentId: `intent-${requestSuffix}`,
      changeSetId: `change-${requestSuffix}`,
      baseGeneration: snapshot.generation,
      parameters: {
        type: "renameSymbol",
        declarationId: declaration!.id,
        newName: "Account"
      }
    };
  }

  it("produces the same facts from the mirror as the snapshot-served path", () => {
    const { g0 } = generationChain();
    const mirror = new MirrorState();
    const target = hydrateAt(mirror, g0);
    const intent = renameIntent(g0, "mirror");

    const mirrorResult = analyzeIntentInDb(mirror.databaseFor(target)!, intent);
    const oneShotResult = analyzeIntent({
      protocolVersion: 1,
      requestId: "one-shot",
      kind: "analyzeIntent",
      binding: {
        serviceEpoch: parseCanonicalU64("1"),
        graphGeneration: g0.generation,
        graphDigest: "a".repeat(64)
      },
      snapshot: g0,
      intent
    });
    expect("facts" in mirrorResult).toBe(true);
    expect("facts" in oneShotResult).toBe(true);
    expect(mirrorResult).toEqual(oneShotResult);
    mirror.close();
  });

  it("identity gating: databaseFor and mismatchReason follow the attested state", () => {
    const { g0, g1, d1 } = generationChain();
    const mirror = new MirrorState();
    const base = hydrateAt(mirror, g0);
    const next = identityOf(g1);

    expect(mirror.databaseFor(next)).toBeNull();
    expect(mirror.mismatchReason(next)).toBe("gap");
    expect(mirror.mismatchReason({ ...base, digest: "0".repeat(64) })).toBe("digest-mismatch");

    mirror.handleSync(syncFrame(base, next, [d1]));
    expect(mirror.databaseFor(next)).not.toBeNull();
    expect(mirror.databaseFor(base)).toBeNull();
    expect(mirror.mismatchReason(base)).toBe("ahead");
    mirror.close();
  });

  it("mirror analyze request schema pins identity/binding/intent consistency", () => {
    const { g0 } = generationChain();
    const intent = renameIntent(g0, "schema");
    const identity = identityOf(g0);
    const valid = {
      protocolVersion: 1,
      requestId: "mirror-req",
      kind: "analyzeIntentMirror",
      binding: {
        serviceEpoch: parseCanonicalU64("1"),
        graphGeneration: g0.generation,
        graphDigest: "a".repeat(64)
      },
      identity,
      intent
    };
    expect(() => mirrorAnalyzeRequestSchema.parse(valid)).not.toThrow();
    expect(() =>
      mirrorAnalyzeRequestSchema.parse({
        ...valid,
        identity: { ...identity, generation: parseCanonicalU64("99") }
      })
    ).toThrow();
    expect(() =>
      mirrorAnalyzeRequestSchema.parse({ ...valid, snapshot: g0 })
    ).toThrow();
  });
});
