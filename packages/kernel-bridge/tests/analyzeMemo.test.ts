// Worker-side exact-generation semantic-fact memoization gates
// (bridge-persistence slice, Task 10).
//
// The memo lives inside the persistent worker's MirrorState and serves ONLY
// mirror-served analyzeIntent requests. Gates proven here, in-process against
// the real serve core (`serveMirrorAnalyzeCore`):
//
//   (a) the same request twice at the same attestation returns byte-identical
//       response bodies (modulo requestId) with the second served as a hit —
//       observable via the memo's test-seam counters, never via metrics;
//   (b) a sync to a new generation between identical requests clears the memo
//       (choke-point invalidation) and the rebound request recomputes;
//   (c) hydrate clears; poison clears; close clears — every path that changes
//       MirrorState invalidates through the same setAttested/markPoisoned
//       choke points;
//   (d) two DIFFERENT requests (different newName) at one generation are both
//       misses with no cross-contamination;
//   (e) the entry bound holds (belt-and-braces cap on top of the primary
//       clear-on-generation-change policy).
//
// Candidate requests are never memoized: the memo is consulted exclusively by
// `serveMirrorAnalyzeCore` (worker.ts); `serveMirrorCandidate` has no memo
// interaction by construction.
import {
  ingestBatch,
  parseCanonicalU64,
  toKernelSnapshot,
  type KernelSnapshotV1
} from "@strata-code/ingest";
import { describe, expect, it } from "vitest";
import { MEMO_MAX_ENTRIES } from "../src/analyze-memo";
import { bridgeResponseSchema, type KernelGraphDeltaV1 } from "../src/protocol";
import { applyDelta, diffSnapshots } from "../src/snapshot";
import { canonicalSyncDigest } from "../src/sync-digest";
import {
  MirrorState,
  hydrateFrameSchema,
  mirrorAnalyzeRequestSchema,
  syncFrameSchema,
  type GraphIdentity,
  type MirrorAnalyzeRequest
} from "../src/sync";
import { serveMirrorAnalyzeCore } from "../src/worker";

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

function declarationId(snapshot: KernelSnapshotV1, pattern: RegExp): string {
  const matches = snapshot.nodes.filter(
    (node) => node.parentId !== null && pattern.test(node.payload)
  );
  expect(matches).toHaveLength(1);
  return matches[0]!.id;
}

function hydrateAt(mirror: MirrorState, snapshot: KernelSnapshotV1): GraphIdentity {
  const target = identityOf(snapshot);
  const outcome = mirror.handleHydrate(
    hydrateFrameSchema.parse({
      requestId: "memo-hydrate",
      kind: "hydrate",
      target,
      snapshot
    })
  );
  expect(outcome).toEqual({ kind: "attest", identity: target });
  return target;
}

function analyzeRequestAt(
  requestId: string,
  identity: GraphIdentity,
  declaration: string,
  newName: string
): MirrorAnalyzeRequest {
  return mirrorAnalyzeRequestSchema.parse({
    protocolVersion: 1,
    requestId,
    kind: "analyzeIntentMirror",
    binding: {
      serviceEpoch: "1",
      graphGeneration: identity.generation,
      graphDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    identity,
    intent: {
      schemaVersion: 1,
      intentId: "memo-intent",
      changeSetId: "memo-change-set",
      baseGeneration: identity.generation,
      parameters: { type: "renameSymbol", declarationId: declaration, newName }
    }
  });
}

function serveOk(mirror: MirrorState, request: MirrorAnalyzeRequest) {
  const outcome = serveMirrorAnalyzeCore(mirror, request);
  expect(outcome.kind).toBe("serve");
  if (outcome.kind !== "serve") throw new Error("unreachable");
  return outcome;
}

/** The exact bytes the transport would write for this semantic response
 * (worker.ts serializes via `bridgeResponseSchema.parse` + JSON.stringify). */
function responseBytes(response: unknown): string {
  return JSON.stringify(bridgeResponseSchema.parse(response));
}

describe("analyze memoization (Task 10)", () => {
  it("(a) same request twice at one attestation: identical bytes, second is a hit", () => {
    const g0 = baseSnapshot();
    const mirror = new MirrorState();
    const identity = hydrateAt(mirror, g0);
    const declaration = declarationId(g0, /export interface User\s*\{/);

    const first = serveOk(mirror, analyzeRequestAt("memo-a-0", identity, declaration, "Account"));
    expect(first.memoHit).toBe(false);
    expect(mirror.analyzeMemo.hits()).toBe(0);
    expect(mirror.analyzeMemo.misses()).toBe(1);

    const second = serveOk(mirror, analyzeRequestAt("memo-a-1", identity, declaration, "Account"));
    expect(second.memoHit).toBe(true);
    expect(mirror.analyzeMemo.hits()).toBe(1);
    expect(mirror.analyzeMemo.misses()).toBe(1);

    // Byte-identical modulo requestId: rebinding the first response to the
    // second request id yields exactly the second response's bytes.
    expect(responseBytes(second.response)).toBe(
      responseBytes({ ...first.response, requestId: "memo-a-1" })
    );
    mirror.close();
  });

  it("(b) sync to a new generation clears the memo; the rebound request recomputes", () => {
    const g0 = baseSnapshot();
    const mirror = new MirrorState();
    const base = hydrateAt(mirror, g0);
    const declaration = declarationId(g0, /export interface User\s*\{/);
    serveOk(mirror, analyzeRequestAt("memo-b-0", base, declaration, "Account"));
    expect(mirror.analyzeMemo.size()).toBe(1);

    // One published delta advances the mirror to G+1.
    const target = g0.nodes.find((node) => /export interface User\s*\{/.test(node.payload))!;
    const patched: KernelSnapshotV1 = {
      ...g0,
      generation: parseCanonicalU64("4"),
      nodes: g0.nodes.map((node) =>
        node.id === target.id ? { ...node, payload: `${node.payload}// synced\n` } : node
      )
    };
    const delta: KernelGraphDeltaV1 = diffSnapshots(g0, patched);
    const g1 = applyDelta(g0, delta);
    const next = identityOf(g1);
    const synced = mirror.handleSync(
      syncFrameSchema.parse({
        requestId: "memo-b-sync",
        kind: "sync",
        base,
        target: next,
        deltas: [delta]
      })
    );
    expect(synced).toEqual({ kind: "attest", identity: next });

    // Choke point: the successful sync cleared every memoized entry.
    expect(mirror.analyzeMemo.size()).toBe(0);

    const rebound = serveOk(mirror, analyzeRequestAt("memo-b-1", next, declaration, "Account"));
    expect(rebound.memoHit).toBe(false);
    expect(mirror.analyzeMemo.hits()).toBe(0);
    expect(mirror.analyzeMemo.misses()).toBe(2);
    mirror.close();
  });

  it("(c) hydrate clears; poison clears; close clears", () => {
    const g0 = baseSnapshot();
    const mirror = new MirrorState();
    const identity = hydrateAt(mirror, g0);
    const declaration = declarationId(g0, /export interface User\s*\{/);

    serveOk(mirror, analyzeRequestAt("memo-c-0", identity, declaration, "Account"));
    expect(mirror.analyzeMemo.size()).toBe(1);
    hydrateAt(mirror, g0);
    expect(mirror.analyzeMemo.size()).toBe(0);

    serveOk(mirror, analyzeRequestAt("memo-c-1", identity, declaration, "Account"));
    expect(mirror.analyzeMemo.size()).toBe(1);
    mirror.markPoisoned("test poison");
    expect(mirror.analyzeMemo.size()).toBe(0);
    expect(serveMirrorAnalyzeCore(mirror, analyzeRequestAt("memo-c-2", identity, declaration, "Account")).kind).toBe(
      "refuse"
    );

    const fresh = new MirrorState();
    const freshIdentity = hydrateAt(fresh, g0);
    serveOk(fresh, analyzeRequestAt("memo-c-3", freshIdentity, declaration, "Account"));
    expect(fresh.analyzeMemo.size()).toBe(1);
    fresh.close();
    expect(fresh.analyzeMemo.size()).toBe(0);
    mirror.close();
  });

  it("(d) different requests at one generation both miss with no cross-contamination", () => {
    const g0 = baseSnapshot();
    const mirror = new MirrorState();
    const identity = hydrateAt(mirror, g0);
    const declaration = declarationId(g0, /export interface User\s*\{/);

    // Different newName → different key → both miss (even though renameSymbol
    // facts do not depend on the new name, the FULL request is the key).
    const toAccount = serveOk(mirror, analyzeRequestAt("memo-d-0", identity, declaration, "Account"));
    const toProfile = serveOk(mirror, analyzeRequestAt("memo-d-1", identity, declaration, "Profile"));
    expect(toAccount.memoHit).toBe(false);
    expect(toProfile.memoHit).toBe(false);
    expect(mirror.analyzeMemo.hits()).toBe(0);
    expect(mirror.analyzeMemo.misses()).toBe(2);
    expect(mirror.analyzeMemo.size()).toBe(2);
    // A hit returns its OWN bytes, never another entry's: the repeat of the
    // Account request matches the Account response exactly, and a request
    // for a DIFFERENT declaration (different facts) yields different bytes.
    const accountAgain = serveOk(mirror, analyzeRequestAt("memo-d-2", identity, declaration, "Account"));
    expect(accountAgain.memoHit).toBe(true);
    expect(responseBytes(accountAgain.response)).toBe(
      responseBytes({ ...toAccount.response, requestId: "memo-d-2" })
    );
    const otherDeclaration = declarationId(g0, /export const other/);
    const otherResponse = serveOk(
      mirror,
      analyzeRequestAt("memo-d-3", identity, otherDeclaration, "Account")
    );
    expect(otherResponse.memoHit).toBe(false);
    expect(responseBytes({ ...otherResponse.response, requestId: "memo-d-2" })).not.toBe(
      responseBytes(accountAgain.response)
    );
    mirror.close();
  });

  it("(e) the entry cap bounds the memo even without a generation change", () => {
    const g0 = baseSnapshot();
    const mirror = new MirrorState();
    const identity = hydrateAt(mirror, g0);
    const declaration = declarationId(g0, /export interface User\s*\{/);

    for (let index = 0; index < MEMO_MAX_ENTRIES + 4; index += 1) {
      serveOk(mirror, analyzeRequestAt(`memo-e-${index}`, identity, declaration, `Name${index}`));
    }
    expect(mirror.analyzeMemo.size()).toBeLessThanOrEqual(MEMO_MAX_ENTRIES);
    // Eviction is oldest-first: the newest entry is still a hit.
    const newest = serveOk(
      mirror,
      analyzeRequestAt("memo-e-again", identity, declaration, `Name${MEMO_MAX_ENTRIES + 3}`)
    );
    expect(newest.memoHit).toBe(true);
    mirror.close();
  });
});
