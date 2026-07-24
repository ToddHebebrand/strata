// Bridge-persistence slice, Task 7: savepoint candidate isolation on the
// persistent mirror, asserted by the full logical fingerprint.
//
// Gates (plan Task 7 Step 1):
//   (a) successful candidate — result byte-equal to the one-shot pipeline's
//       for the same request, pre/post fingerprints equal, MirrorState
//       (generation + sync digest) unchanged;
//   (b) failing candidate (type-error fixture) — failure payload identical
//       to one-shot's, fingerprints equal;
//   (c) thrown mid-pipeline exception (malformed intent AND an injected
//       throwing pipeline seam) — error reported, fingerprints equal, the
//       mirror keeps serving subsequent candidates;
//   (e) poison-state (review Minor 2) — a test pipeline that COMMITs behind
//       the savepoint is detected by the post-fingerprint; the worker-level
//       refusal path is covered in candidateIsolationWorker tests below;
//   (f) cross-candidate leakage — two mirror candidates back-to-back equal
//       two fresh one-shot runs, an analyze between them stays correct, and
//       the store's module-level transaction-overlay registry returns to its
//       baseline after every path.
// Gate (d) — crash injected mid-candidate — is a host/e2e concern: the Rust
// host gates (persistent.rs crash tests) plus the live-compare
// persistentBridge restart test prove respawn + rehydrate; the worker half
// here proves a killed-mid-candidate child leaves a FRESH worker fully
// serviceable.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ingestBatch,
  parseCanonicalU64,
  toKernelSnapshot,
  type KernelSnapshotV1
} from "@strata-code/ingest";
import { openTransactionOverlayCount, type Db } from "@strata-code/store";
import { describe, expect, it } from "vitest";
import { analyzeIntentInDb } from "../src/analyze";
import {
  buildValidateCandidate,
  buildValidateCandidateOnMirror,
  corruptingMirrorPipelineForTests,
  type BuildValidateCandidateResult
} from "../src/candidate";
import { mirrorFingerprint } from "../src/mirror-fingerprint";
import type { BuildValidateCandidateRequest, IntentRecord } from "../src/protocol";
import { canonicalSyncDigest } from "../src/sync-digest";
import {
  MirrorState,
  computeMirrorDigest,
  hydrateFrameSchema,
  type GraphIdentity,
  type MirrorCandidateRequest
} from "../src/sync";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(currentDir, "..");
const workerPath = path.join(packageRoot, "dist", "worker.js");
const corpusRoot = path.resolve(currentDir, "../../../examples/medium");
const sourceRoot = path.join(corpusRoot, "src");

function loadCorpus(root: string): { path: string; text: string }[] {
  const modules: { path: string; text: string }[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory).sort()) {
      const absolutePath = path.join(directory, entry);
      if (statSync(absolutePath).isDirectory()) {
        walk(absolutePath);
      } else if (entry.endsWith(".ts")) {
        modules.push({ path: absolutePath, text: readFileSync(absolutePath, "utf8") });
      }
    }
  }
  walk(root);
  return modules;
}

function mediumSnapshot(): KernelSnapshotV1 {
  return toKernelSnapshot(ingestBatch(loadCorpus(sourceRoot)), parseCanonicalU64("7"));
}

function declarationId(snapshot: KernelSnapshotV1, pattern: RegExp): string {
  const matches = snapshot.nodes.filter(
    (node) => node.parentId !== null && pattern.test(node.payload)
  );
  expect(matches).toHaveLength(1);
  return matches[0]!.id;
}

function renameIntent(
  snapshot: KernelSnapshotV1,
  changeSetId: string,
  newName: string
): IntentRecord {
  return {
    schemaVersion: 1,
    intentId: `${changeSetId}-intent`,
    changeSetId,
    baseGeneration: snapshot.generation,
    parameters: {
      type: "renameSymbol",
      declarationId: declarationId(snapshot, /export interface User\s*\{/),
      newName
    }
  };
}

function addParameterIntent(
  snapshot: KernelSnapshotV1,
  changeSetId: string,
  overrides: Partial<{ typeText: string; defaultValue: string | null }> = {}
): IntentRecord {
  return {
    schemaVersion: 1,
    intentId: `${changeSetId}-intent`,
    changeSetId,
    baseGeneration: snapshot.generation,
    parameters: {
      type: "addParameter",
      functionId: declarationId(snapshot, /export function greet\s*\(/),
      name: "excited",
      typeText: overrides.typeText ?? "boolean",
      position: 1,
      defaultValue: overrides.defaultValue !== undefined ? overrides.defaultValue : "false"
    }
  };
}

function oneShotRequest(
  snapshot: KernelSnapshotV1,
  tag: string,
  intents: IntentRecord[]
): BuildValidateCandidateRequest {
  return {
    protocolVersion: 1,
    requestId: `isolation-${tag}-request`,
    kind: "buildValidateCandidate",
    binding: {
      serviceEpoch: parseCanonicalU64("1"),
      graphGeneration: snapshot.generation,
      graphDigest:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    snapshot,
    attemptId: `isolation-${tag}-attempt`,
    scopeFingerprint:
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    changeSet: {
      changeSetId: intents[0]!.changeSetId,
      actor: "isolation-test-agent",
      reasoning: "candidate isolation gate",
      orderedIntents: intents
    },
    validationProfile: {
      mode: "tscOnly",
      sourceRoot,
      corpusRoot,
      behavioralFixtures: [],
      strictSrcOnlyTscScope: true
    }
  };
}

function mirrorRequestOf(
  request: BuildValidateCandidateRequest,
  identity: GraphIdentity
): MirrorCandidateRequest {
  const { snapshot: _snapshot, ...rest } = request;
  return {
    ...rest,
    kind: "buildValidateCandidateMirror",
    identity
  };
}

interface Mirror {
  state: MirrorState;
  db: Db;
  identity: GraphIdentity;
}

function hydratedMirror(snapshot: KernelSnapshotV1): Mirror {
  const identity: GraphIdentity = {
    generation: snapshot.generation,
    digest: canonicalSyncDigest(snapshot.generation, snapshot.nodes, snapshot.references)
  };
  const state = new MirrorState();
  const outcome = state.handleHydrate(
    hydrateFrameSchema.parse({
      requestId: "isolation-hydrate",
      kind: "hydrate",
      target: identity,
      snapshot
    })
  );
  expect(outcome).toEqual({ kind: "attest", identity });
  const db = state.databaseFor(identity);
  expect(db).not.toBeNull();
  return { state, db: db!, identity };
}

function servedResult(
  outcome: ReturnType<typeof buildValidateCandidateOnMirror>
): BuildValidateCandidateResult {
  if (outcome.kind !== "served") {
    throw new Error(`expected a served candidate, got poison: ${outcome.detail}`);
  }
  return outcome.result;
}

/** Asserts the full isolation contract around ONE mirror candidate. */
function runIsolated(
  mirror: Mirror,
  request: MirrorCandidateRequest,
  pipeline?: Parameters<typeof buildValidateCandidateOnMirror>[3]
): ReturnType<typeof buildValidateCandidateOnMirror> {
  const overlaysBefore = openTransactionOverlayCount();
  const pre = mirrorFingerprint(mirror.db, mirror.identity.generation);
  const outcome = buildValidateCandidateOnMirror(request, mirror.db, undefined, pipeline);
  const post = mirrorFingerprint(mirror.db, mirror.identity.generation);
  if (outcome.kind === "served") {
    expect(post).toBe(pre);
    // MirrorState unchanged: attested identity intact and the recomputed
    // sync digest still matches it.
    expect(mirror.state.attested()).toEqual(mirror.identity);
    expect(computeMirrorDigest(mirror.db, mirror.identity.generation)).toBe(
      mirror.identity.digest
    );
  }
  // No cross-candidate JS-state leakage: the store's module-level overlay
  // registry is back at its baseline on every path.
  expect(openTransactionOverlayCount()).toBe(overlaysBefore);
  return outcome;
}

describe("mirror candidate savepoint isolation (Task 7)", () => {
  // ONE ingest + ONE hydrated mirror shared by the sequential gates below —
  // exactly the persistent worker's situation (a single long-lived mirror
  // serving many candidates), which is itself part of what gate (f) proves.
  const snapshot = mediumSnapshot();
  const mirror = hydratedMirror(snapshot);

  it("gate (a): successful candidate equals one-shot and leaves the mirror byte-identical", () => {
    const request = oneShotRequest(snapshot, "rename", [
      renameIntent(snapshot, "isolation-rename-change-set", "Account")
    ]);
    const oneShot = buildValidateCandidate(request);
    const mirrored = servedResult(
      runIsolated(mirror, mirrorRequestOf(request, mirror.identity))
    );
    expect("delta" in mirrored).toBe(true);
    // Byte-compare the payloads (transport fields aside, this IS the whole
    // semantic response body both transports serialize).
    expect(JSON.stringify(mirrored)).toBe(JSON.stringify(oneShot));
  }, 120_000);

  it("gate (b): failing candidate (type error) reports identically to one-shot, fingerprints equal", () => {
    const request = oneShotRequest(snapshot, "type-error", [
      addParameterIntent(snapshot, "isolation-type-error-change-set", {
        typeText: "boolean",
        defaultValue: '"nope"'
      })
    ]);
    const oneShot = buildValidateCandidate(request);
    if ("delta" in oneShot) throw new Error("type-error fixture must fail validation");
    expect(oneShot.stage).toBe("validate");
    expect(oneShot.code).toBe("typescriptFailed");
    expect(oneShot.diagnostics.length).toBeGreaterThan(0);

    const mirrored = servedResult(
      runIsolated(mirror, mirrorRequestOf(request, mirror.identity))
    );
    expect(JSON.stringify(mirrored)).toBe(JSON.stringify(oneShot));
  }, 120_000);

  it("gate (c): thrown mid-pipeline exceptions unwind cleanly and the mirror keeps serving", () => {
    // Malformed intent: the store throws inside the pipeline (mutate stage),
    // and the pipeline's own error path reports it — identically one-shot.
    const missing = oneShotRequest(snapshot, "missing-decl", [
      {
        schemaVersion: 1,
        intentId: "isolation-missing-intent",
        changeSetId: "isolation-missing-change-set",
        baseGeneration: snapshot.generation,
        parameters: {
          type: "renameSymbol",
          declarationId: "no-such-declaration",
          newName: "Account"
        }
      }
    ]);
    const oneShot = buildValidateCandidate(missing);
    if ("delta" in oneShot) throw new Error("missing declaration must fail");
    expect(oneShot.stage).toBe("mutate");
    const mirrored = servedResult(
      runIsolated(mirror, mirrorRequestOf(missing, mirror.identity))
    );
    expect(JSON.stringify(mirrored)).toBe(JSON.stringify(oneShot));

    // Injected seam: a pipeline that dirties the mirror and then THROWS past
    // the pipeline's own error handling — the wrapper's finally must still
    // roll back, and the thrown error becomes a bounded error payload.
    const thrown = runIsolated(
      mirror,
      mirrorRequestOf(
        oneShotRequest(snapshot, "throwing", [
          renameIntent(snapshot, "isolation-throwing-change-set", "Account")
        ]),
        mirror.identity
      ),
      (_request, db) => {
        db.prepare("UPDATE nodes SET payload = payload || 'x'").run();
        throw new Error("injected mid-pipeline failure (test seam)");
      }
    );
    const failure = servedResult(thrown);
    if ("delta" in failure) throw new Error("throwing seam must not produce a delta");
    expect(failure.code).toBe("mirrorCandidateFailed");
    expect(failure.message).toContain("injected mid-pipeline failure");

    // The mirror still serves a subsequent successful candidate.
    const recovery = oneShotRequest(snapshot, "recovery", [
      renameIntent(snapshot, "isolation-recovery-change-set", "Account")
    ]);
    const recovered = servedResult(
      runIsolated(mirror, mirrorRequestOf(recovery, mirror.identity))
    );
    expect("delta" in recovered).toBe(true);
  }, 240_000);

  it("gate (e): a commit behind the savepoint is caught by the post-fingerprint (poison)", () => {
    const request = mirrorRequestOf(
      oneShotRequest(snapshot, "poison", [
        renameIntent(snapshot, "isolation-poison-change-set", "Account")
      ]),
      mirror.identity
    );
    const pre = mirrorFingerprint(mirror.db, mirror.identity.generation);
    const outcome = buildValidateCandidateOnMirror(
      request,
      mirror.db,
      undefined,
      corruptingMirrorPipelineForTests
    );
    if (outcome.kind !== "poisoned") throw new Error("corruption must poison");
    expect(outcome.detail).toContain("mirror fingerprint diverged");
    const post = mirrorFingerprint(mirror.db, mirror.identity.generation);
    expect(post).not.toBe(pre);
    // The sync digest alone would ALSO catch this particular corruption
    // (nodes payload); the fingerprint is the strictly-stronger assertion.
    expect(computeMirrorDigest(mirror.db, mirror.identity.generation)).not.toBe(
      mirror.identity.digest
    );
  }, 120_000);
});

describe("mirror candidate cross-candidate leakage (gate f)", () => {
  it("two back-to-back mirror candidates equal two fresh one-shot runs with a correct analyze between", () => {
    const snapshot = mediumSnapshot();
    const mirror = hydratedMirror(snapshot);
    const renameRequest = oneShotRequest(snapshot, "leak-rename", [
      renameIntent(snapshot, "isolation-leak-rename-change-set", "Account")
    ]);
    const parameterRequest = oneShotRequest(snapshot, "leak-parameter", [
      addParameterIntent(snapshot, "isolation-leak-parameter-change-set")
    ]);

    // Fresh one-shot references, each on its own throwaway database.
    const oneShotRename = buildValidateCandidate(renameRequest);
    const oneShotParameter = buildValidateCandidate(parameterRequest);

    const mirroredRename = servedResult(
      runIsolated(mirror, mirrorRequestOf(renameRequest, mirror.identity))
    );
    // An analyze between the two candidates still sees the untouched base
    // generation: the rename candidate's User -> Account must NOT have leaked.
    const analysis = analyzeIntentInDb(mirror.db, renameRequest.changeSet.orderedIntents[0]!);
    if (!("facts" in analysis)) {
      throw new Error(`analyze between candidates failed: ${JSON.stringify(analysis)}`);
    }
    expect(analysis.facts.type).toBe("renameSymbol");
    expect(analysis.facts.references.length).toBeGreaterThan(0);
    const mirroredParameter = servedResult(
      runIsolated(mirror, mirrorRequestOf(parameterRequest, mirror.identity))
    );

    expect(JSON.stringify(mirroredRename)).toBe(JSON.stringify(oneShotRename));
    expect(JSON.stringify(mirroredParameter)).toBe(JSON.stringify(oneShotParameter));
  }, 240_000);
});

describe("mirror fingerprint coverage", () => {
  it("is deterministic, generation-bound, and sensitive to every mutable table", () => {
    const snapshot = mediumSnapshot();
    const { db, identity } = hydratedMirror(snapshot);
    const base = mirrorFingerprint(db, identity.generation);
    expect(mirrorFingerprint(db, identity.generation)).toBe(base);
    expect(mirrorFingerprint(db, "8")).not.toBe(base);

    // nodes (graph content)
    db.prepare("UPDATE nodes SET payload = payload || ' ' WHERE id = (SELECT id FROM nodes LIMIT 1)").run();
    const afterNodes = mirrorFingerprint(db, identity.generation);
    expect(afterNodes).not.toBe(base);

    // transactions + operations (candidate execution writes these)
    db.prepare(
      "INSERT INTO transactions (tx_id, started_at, status, actor) VALUES ('t1', 1, 'open', 'a')"
    ).run();
    const afterTransactions = mirrorFingerprint(db, identity.generation);
    expect(afterTransactions).not.toBe(afterNodes);
    db.prepare(
      "INSERT INTO operations (op_id, tx_id, kind, params_json, affected_node_ids_json, actor, ts) " +
        "VALUES ('o1', 't1', 'RenameSymbol', '{}', '[]', 'a', 1)"
    ).run();
    const afterOperations = mirrorFingerprint(db, identity.generation);
    expect(afterOperations).not.toBe(afterTransactions);

    // auxiliary metadata tables
    db.prepare(
      "INSERT INTO embedding_meta (node_id, model, content_hash, embedded_at) VALUES ('n', 'm', 'h', 1)"
    ).run();
    expect(mirrorFingerprint(db, identity.generation)).not.toBe(afterOperations);
  });

  it("throws loudly on an unclassified table (future schema addition)", () => {
    const snapshot = mediumSnapshot();
    const { db, identity } = hydratedMirror(snapshot);
    db.exec("CREATE TABLE future_feature (id TEXT PRIMARY KEY)");
    expect(() => mirrorFingerprint(db, identity.generation)).toThrow(
      /coverage violation.*future_feature/
    );
  });
});

// ---------------------------------------------------------------------------
// Worker-level gates: the persistent loop's buildValidateCandidateMirror
// route, its refusal semantics, the poison refusal code, and the
// killed-mid-candidate recovery path. Test-side transport mirrors
// persistentLoop.test.ts.
// ---------------------------------------------------------------------------

class FrameClient {
  private pending = Buffer.alloc(0);
  private readonly frames: Buffer[] = [];
  private readonly waiters: {
    resolve: (frame: Buffer) => void;
    reject: (error: Error) => void;
  }[] = [];
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => {
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.length >= 4) {
        const length = this.pending.readUInt32LE(0);
        if (this.pending.length < 4 + length) break;
        const frame = this.pending.subarray(4, 4 + length);
        this.pending = this.pending.subarray(4 + length);
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(frame);
        else this.frames.push(frame);
      }
    });
    child.stdout.on("end", () => {
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(new Error("worker stdout ended while awaiting a frame"));
      }
    });
    child.stderr.on("data", () => {});
    this.exit = new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  }

  send(value: unknown): void {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length, 0);
    this.child.stdin.write(Buffer.concat([prefix, body]));
  }

  async roundTrip(value: unknown): Promise<any> {
    expect(this.frames).toHaveLength(0);
    this.send(value);
    const frame = await new Promise<Buffer>((resolve, reject) => {
      const queued = this.frames.shift();
      if (queued) resolve(queued);
      else this.waiters.push({ resolve, reject });
    });
    return JSON.parse(frame.toString("utf8"));
  }
}

function spawnPersistentWorker(env: NodeJS.ProcessEnv = {}): FrameClient {
  const child = spawn(process.execPath, [workerPath, "--persistent"], {
    cwd: packageRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env }
  });
  return new FrameClient(child);
}

async function hydrateWorker(
  client: FrameClient,
  snapshot: KernelSnapshotV1
): Promise<GraphIdentity> {
  const identity: GraphIdentity = {
    generation: snapshot.generation,
    digest: canonicalSyncDigest(snapshot.generation, snapshot.nodes, snapshot.references)
  };
  const hydrated = await client.roundTrip({
    requestId: "worker-hydrate",
    kind: "hydrate",
    target: identity,
    snapshot
  });
  expect(hydrated).toEqual({ requestId: "worker-hydrate", kind: "attest", identity });
  return identity;
}

describe("persistent worker mirror candidates (Task 7, loop level)", () => {
  it("serves a snapshot-free candidate from the mirror, refuses mismatched identities, and recovers after a mid-candidate kill", async () => {
    const snapshot = mediumSnapshot();
    let client = spawnPersistentWorker();
    try {
      const identity = await hydrateWorker(client, snapshot);
      const request = oneShotRequest(snapshot, "worker-rename", [
        renameIntent(snapshot, "worker-rename-change-set", "Account")
      ]);
      const oneShot = buildValidateCandidate(request);
      if (!("delta" in oneShot)) throw new Error("reference candidate must succeed");

      // Identity mismatch → refuse, mirror untouched.
      const refused = await client.roundTrip({
        ...mirrorRequestOf(request, { ...identity, generation: parseCanonicalU64("8") }),
        binding: { ...request.binding, graphGeneration: parseCanonicalU64("8") },
        changeSet: {
          ...request.changeSet,
          orderedIntents: request.changeSet.orderedIntents.map((intent) => ({
            ...intent,
            baseGeneration: parseCanonicalU64("8")
          }))
        }
      });
      expect(refused).toEqual({
        requestId: request.requestId,
        kind: "refuse",
        reason: "gap",
        have: identity
      });

      // Snapshot-free mirror candidate: byte-identical semantic result.
      const served = await client.roundTrip(mirrorRequestOf(request, identity));
      expect(served).toMatchObject({
        requestId: request.requestId,
        kind: "buildValidateCandidate",
        ok: true
      });
      expect(served.result).toEqual(JSON.parse(JSON.stringify(oneShot)));
      expect(served.binding).toEqual({
        ...request.binding,
        attemptId: request.attemptId,
        scopeFingerprint: request.scopeFingerprint
      });

      // Gate (d), worker half: kill mid-candidate, then a FRESH worker (the
      // host's lazy respawn) hydrates and serves the same candidate.
      client.send(mirrorRequestOf(request, identity));
      client.child.kill("SIGKILL");
      await client.exit;

      client = spawnPersistentWorker();
      await hydrateWorker(client, snapshot);
      const recovered = await client.roundTrip(mirrorRequestOf(request, identity));
      expect(recovered).toMatchObject({ ok: true });
      expect(recovered.result).toEqual(JSON.parse(JSON.stringify(oneShot)));

      const ack = await client.roundTrip({ requestId: "worker-shutdown", kind: "shutdown" });
      expect(ack).toEqual({ requestId: "worker-shutdown", kind: "shutdownAck" });
      expect((await client.exit).code).toBe(0);
    } finally {
      client.child.kill();
    }
  }, 300_000);

  it("poison-state (gate e): corrupting seam poisons the worker, which refuses ALL subsequent requests", async () => {
    const snapshot = mediumSnapshot();
    const client = spawnPersistentWorker({ STRATA_TEST_MIRROR_CANDIDATE_CORRUPT: "1" });
    try {
      const identity = await hydrateWorker(client, snapshot);
      const request = oneShotRequest(snapshot, "worker-poison", [
        renameIntent(snapshot, "worker-poison-change-set", "Account")
      ]);

      const poisonedResponse = await client.roundTrip(mirrorRequestOf(request, identity));
      expect(poisonedResponse).toMatchObject({
        requestId: request.requestId,
        kind: "error",
        code: "mirrorPoisoned"
      });
      expect(poisonedResponse.message).toContain("fingerprint diverged");

      // EVERY subsequent request is refused with the distinct poison code —
      // analyze, sync, and candidate alike.
      const analyzeAfter = await client.roundTrip({
        protocolVersion: 1,
        requestId: "poisoned-analyze",
        kind: "analyzeIntentMirror",
        binding: request.binding,
        identity,
        intent: request.changeSet.orderedIntents[0]!
      });
      expect(analyzeAfter).toMatchObject({
        requestId: "poisoned-analyze",
        kind: "error",
        code: "mirrorPoisoned"
      });
      const syncAfter = await client.roundTrip({
        requestId: "poisoned-sync",
        kind: "hydrate",
        target: identity,
        snapshot
      });
      expect(syncAfter).toMatchObject({
        requestId: "poisoned-sync",
        kind: "error",
        code: "mirrorPoisoned"
      });

      // A clean shutdown still works (the host's kill path is graceful-first).
      const ack = await client.roundTrip({ requestId: "poisoned-shutdown", kind: "shutdown" });
      expect(ack).toEqual({ requestId: "poisoned-shutdown", kind: "shutdownAck" });
      expect((await client.exit).code).toBe(0);
    } finally {
      client.child.kill();
    }
  }, 300_000);
});
