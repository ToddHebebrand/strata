/**
 * Worker-side mirror synchronization (bridge-persistence slice, Task 6).
 *
 * The persistent worker holds ONE long-lived `:memory:` mirror database
 * across requests, kept exact by the daemon's attested, PUBLISHED-only sync
 * protocol:
 *
 * - `hydrate` frames replace the whole mirror with the carried snapshot;
 * - `sync` frames apply an ordered, contiguous batch of published deltas
 *   inside one SQLite transaction (BEGIN → apply in order, asserting the
 *   pre-generation each step → recompute the canonical sync digest → equal
 *   to the target → COMMIT + attest; anything else → ROLLBACK + refuse,
 *   leaving the mirror byte-for-byte at its previously attested state).
 *
 * Refusals are checked BEFORE the database is touched wherever possible
 * (gap/ahead/base-digest mismatch), and the reason vocabulary is exactly the
 * protocol's: `gap` (worker behind or missing state), `digest-mismatch`
 * (mirror content cannot reach the target), `ahead` (worker attestation past
 * the frame's base — forward-only: the mirror is never rolled back).
 *
 * Delta application mirrors `GraphGeneration::apply` (crates/strata-kernel/
 * src/graph.rs) over the store schema (packages/store/src/schema.ts):
 * `nodes` keyed by `id`, `node_references` keyed by `from_node_id` — upserts
 * replace by key, deletes are no-ops when absent, exactly like the kernel's
 * BTreeMap insert/remove. Referential soundness is not enforced per change
 * (the kernel validated the published generation); the digest comparison at
 * the end is the fail-closed equality proof.
 */

import { z } from "zod";
import type { Db } from "@strata-code/store";
import { canonicalSyncDigest, type MirrorNode, type MirrorReference } from "./sync-digest";
import { hydrateSnapshot } from "./snapshot";
import {
  MAX_PROTOCOL_ARRAY_ITEMS,
  bridgeBindingSchema,
  canonicalU64Schema,
  changeSetSchema,
  intentRecordSchema,
  kernelGraphDeltaV1Schema,
  kernelSnapshotV1Schema,
  validationProfileSchema,
  type KernelGraphDeltaV1
} from "./protocol";

const requestIdSchema = z.string().min(1);
const syncDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const hash64Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** The wire graph identity: generation as a canonical decimal string plus
 * the canonical sync digest (lowercase hex SHA-256). */
export const graphIdentitySchema = z
  .object({
    generation: canonicalU64Schema,
    digest: syncDigestSchema
  })
  .strict();

export type GraphIdentity = z.infer<typeof graphIdentitySchema>;

/** Full-hydration frame: replace the mirror with this exact snapshot. */
export const hydrateFrameSchema = z
  .object({
    requestId: requestIdSchema,
    kind: z.literal("hydrate"),
    target: graphIdentitySchema,
    snapshot: kernelSnapshotV1Schema
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.snapshot.generation !== frame.target.generation) {
      context.addIssue({
        code: "custom",
        path: ["snapshot", "generation"],
        message: "hydrate snapshot generation does not match the target identity"
      });
    }
  });

export type HydrateFrame = z.infer<typeof hydrateFrameSchema>;

/** Delta-sync frame: ordered contiguous published deltas from base to target. */
export const syncFrameSchema = z
  .object({
    requestId: requestIdSchema,
    kind: z.literal("sync"),
    base: graphIdentitySchema,
    target: graphIdentitySchema,
    deltas: z.array(kernelGraphDeltaV1Schema).min(1).max(MAX_PROTOCOL_ARRAY_ITEMS)
  })
  .strict();

export type SyncFrame = z.infer<typeof syncFrameSchema>;

/**
 * Mirror-served analyze request (Task 6): the analyzeIntent request minus
 * the snapshot, plus the graph identity the worker must hold attested. The
 * worker refuses (never guesses) when its attested identity differs.
 */
export const mirrorAnalyzeRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal("analyzeIntentMirror"),
    binding: bridgeBindingSchema,
    identity: graphIdentitySchema,
    intent: intentRecordSchema
  })
  .strict()
  .superRefine((request, context) => {
    if (request.identity.generation !== request.binding.graphGeneration) {
      context.addIssue({
        code: "custom",
        path: ["identity", "generation"],
        message: "identity generation does not match binding"
      });
    }
    if (request.intent.baseGeneration !== request.identity.generation) {
      context.addIssue({
        code: "custom",
        path: ["intent", "baseGeneration"],
        message: "intent generation does not match identity"
      });
    }
  });

export type MirrorAnalyzeRequest = z.infer<typeof mirrorAnalyzeRequestSchema>;

/**
 * Mirror-served candidate request (Task 7): the buildValidateCandidate
 * request minus the snapshot, plus the graph identity the worker must hold
 * attested (naming follows `analyzeIntentMirror`). Candidate execution runs
 * against the persistent mirror under savepoint-rollback isolation; the
 * worker refuses (never guesses) when its attested identity differs.
 */
export const mirrorCandidateRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal("buildValidateCandidateMirror"),
    binding: bridgeBindingSchema,
    identity: graphIdentitySchema,
    attemptId: requestIdSchema,
    scopeFingerprint: hash64Schema,
    changeSet: changeSetSchema,
    validationProfile: validationProfileSchema
  })
  .strict()
  .superRefine((request, context) => {
    if (request.identity.generation !== request.binding.graphGeneration) {
      context.addIssue({
        code: "custom",
        path: ["identity", "generation"],
        message: "identity generation does not match binding"
      });
    }
    request.changeSet.orderedIntents.forEach((intent, index) => {
      if (intent.changeSetId !== request.changeSet.changeSetId) {
        context.addIssue({
          code: "custom",
          path: ["changeSet", "orderedIntents", index, "changeSetId"],
          message: "intent change set id does not match"
        });
      }
      if (intent.baseGeneration !== request.identity.generation) {
        context.addIssue({
          code: "custom",
          path: ["changeSet", "orderedIntents", index, "baseGeneration"],
          message: "intent generation does not match identity"
        });
      }
    });
  });

export type MirrorCandidateRequest = z.infer<typeof mirrorCandidateRequestSchema>;

export type RefusalReason = "gap" | "digest-mismatch" | "ahead";

export type SyncOutcome =
  | { kind: "attest"; identity: GraphIdentity }
  | { kind: "refuse"; reason: RefusalReason; have: GraphIdentity | null };

/** Internal marker: a mid-batch generation-chain break is a `gap` refusal,
 * everything else that throws during application is `digest-mismatch`. */
class GenerationChainError extends Error {}

/**
 * The worker's long-lived mirror: one database plus the identity it last
 * attested. Attestation state changes ONLY on a verified hydrate/sync
 * outcome; a refused frame leaves both the database and the attestation
 * exactly as they were (proven by the rollback gates in sync.test.ts).
 */
export class MirrorState {
  private db: Db | null = null;
  private attestedIdentity: GraphIdentity | null = null;
  private poisonDetail: string | null = null;

  attested(): GraphIdentity | null {
    return this.attestedIdentity;
  }

  /**
   * Task-7 poison latch: set when a post-candidate fingerprint diverged from
   * its pre-candidate value (savepoint isolation failed). A poisoned mirror
   * can never be trusted again in this process — the worker loop refuses
   * EVERY subsequent request with the distinct `mirrorPoisoned` code so the
   * host kills this worker and lazily respawns + full-rehydrates a fresh one.
   */
  poisonedDetail(): string | null {
    return this.poisonDetail;
  }

  markPoisoned(detail: string): void {
    this.poisonDetail = detail;
  }

  /** The mirror database, ONLY if the attested identity equals `identity`. */
  databaseFor(identity: GraphIdentity): Db | null {
    if (
      this.poisonDetail === null &&
      this.db !== null &&
      this.attestedIdentity !== null &&
      this.attestedIdentity.generation === identity.generation &&
      this.attestedIdentity.digest === identity.digest
    ) {
      return this.db;
    }
    return null;
  }

  /** Refusal reason for a mirror request whose identity does not match. */
  mismatchReason(identity: GraphIdentity): RefusalReason {
    if (this.attestedIdentity === null) return "gap";
    const have = BigInt(this.attestedIdentity.generation);
    const want = BigInt(identity.generation);
    if (have > want) return "ahead";
    if (have < want) return "gap";
    return "digest-mismatch";
  }

  close(): void {
    this.attestedIdentity = null;
    if (this.db !== null) {
      try {
        this.db.close();
      } finally {
        this.db = null;
      }
    }
  }

  /** `hydrate` frame: replace the whole mirror; attest or refuse. */
  handleHydrate(frame: HydrateFrame): SyncOutcome {
    // The old mirror is gone either way: a hydrate is only sent when the
    // daemon considers the worker state unusable.
    this.close();
    let db: Db;
    try {
      db = hydrateSnapshot(frame.snapshot);
    } catch {
      return { kind: "refuse", reason: "digest-mismatch", have: null };
    }
    const digest = computeMirrorDigest(db, frame.target.generation);
    if (digest !== frame.target.digest) {
      db.close();
      return { kind: "refuse", reason: "digest-mismatch", have: null };
    }
    this.db = db;
    this.attestedIdentity = { ...frame.target };
    return { kind: "attest", identity: this.attestedIdentity };
  }

  /**
   * `sync` frame: transactional ordered delta application. Base mismatches
   * refuse WITHOUT touching the database; application failures and digest
   * mismatches ROLLBACK, leaving the previously attested mirror intact.
   */
  handleSync(frame: SyncFrame): SyncOutcome {
    const have = this.attestedIdentity;
    if (this.db === null || have === null) {
      return { kind: "refuse", reason: "gap", have: null };
    }
    const haveGeneration = BigInt(have.generation);
    const baseGeneration = BigInt(frame.base.generation);
    if (haveGeneration > baseGeneration) {
      return { kind: "refuse", reason: "ahead", have };
    }
    if (haveGeneration < baseGeneration) {
      return { kind: "refuse", reason: "gap", have };
    }
    if (have.digest !== frame.base.digest) {
      return { kind: "refuse", reason: "digest-mismatch", have };
    }

    const db = this.db;
    db.exec("BEGIN");
    try {
      let generation = baseGeneration;
      for (const delta of frame.deltas) {
        if (BigInt(delta.baseGeneration) !== generation) {
          throw new GenerationChainError(
            `delta base generation ${delta.baseGeneration} does not continue ${generation}`
          );
        }
        applyDeltaChanges(db, delta);
        generation += 1n;
      }
      if (generation !== BigInt(frame.target.generation)) {
        throw new GenerationChainError(
          `batch ends at generation ${generation}, target is ${frame.target.generation}`
        );
      }
      const digest = computeMirrorDigest(db, frame.target.generation);
      if (digest !== frame.target.digest) {
        db.exec("ROLLBACK");
        return { kind: "refuse", reason: "digest-mismatch", have };
      }
      db.exec("COMMIT");
      this.attestedIdentity = { ...frame.target };
      return { kind: "attest", identity: this.attestedIdentity };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // BEGIN failed or the transaction is already gone; the digest-based
        // attestation model keeps this safe: attested state is unchanged and
        // the daemon's next frame (hydrate) rebuilds the mirror.
      }
      return {
        kind: "refuse",
        reason: error instanceof GenerationChainError ? "gap" : "digest-mismatch",
        have
      };
    }
  }
}

/**
 * Recomputed (never cached) canonical sync digest over the ACTUAL database
 * content — the `MirrorState` recomputation the plan mandates for
 * attestation. Reads the same columns `exportSnapshot` reads; sorting is the
 * digest function's own contract.
 */
export function computeMirrorDigest(db: Db, generation: string): string {
  const nodes = db
    .prepare(
      `SELECT id, kind, parent_id AS parentId, child_index AS childIndex, payload
       FROM nodes`
    )
    .all() as MirrorNode[];
  const references = db
    .prepare(
      `SELECT from_node_id AS fromNodeId, to_node_id AS toNodeId, kind
       FROM node_references`
    )
    .all() as MirrorReference[];
  return canonicalSyncDigest(generation, nodes, references);
}

/**
 * One delta's changes, with `GraphGeneration::apply` semantics on the mirror
 * tables: upserts replace by primary key, deletes ignore absent keys.
 */
function applyDeltaChanges(db: Db, delta: KernelGraphDeltaV1): void {
  const upsertNode = db.prepare(
    `INSERT INTO nodes (id, kind, parent_id, child_index, payload)
     VALUES (@id, @kind, @parentId, @childIndex, @payload)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind,
       parent_id = excluded.parent_id,
       child_index = excluded.child_index,
       payload = excluded.payload`
  );
  const deleteNode = db.prepare(`DELETE FROM nodes WHERE id = ?`);
  const upsertReference = db.prepare(
    `INSERT INTO node_references (from_node_id, to_node_id, kind)
     VALUES (@fromNodeId, @toNodeId, @kind)
     ON CONFLICT(from_node_id) DO UPDATE SET
       to_node_id = excluded.to_node_id,
       kind = excluded.kind`
  );
  const deleteReference = db.prepare(
    `DELETE FROM node_references WHERE from_node_id = ?`
  );

  for (const change of delta.changes) {
    switch (change.type) {
      case "upsertNode":
        upsertNode.run({
          id: change.node.id,
          kind: change.node.kind,
          parentId: change.node.parentId,
          childIndex: change.node.childIndex,
          payload: change.node.payload
        });
        break;
      case "deleteNode":
        deleteNode.run(change.nodeId);
        break;
      case "upsertReference":
        upsertReference.run({
          fromNodeId: change.reference.fromNodeId,
          toNodeId: change.reference.toNodeId,
          kind: change.reference.kind
        });
        break;
      case "deleteReference":
        deleteReference.run(change.fromNodeId);
        break;
    }
  }
}
