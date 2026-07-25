/**
 * Exact-generation semantic-fact memoization for mirror-served analyzeIntent
 * requests (bridge-persistence slice, Task 10).
 *
 * The five per-mutation analyze trips (submitAnalysis / claimAnalysis /
 * preCandidateAnalysis / postCandidateAnalysis, plus the unattributed
 * submit-time re-analysis) all serialize the SAME wire intent at the same
 * published generation — only the transport `requestId` differs
 * (crates/strata-kernel/src/bridge/provider.rs `wire_intent`, router.rs
 * `analyze_via_mirror`). This memo lets the persistent worker serve the
 * repeats from the first trip's exact response instead of re-walking the
 * mirror graph.
 *
 * KEY COMPOSITION — canonical JSON (keys sorted at every depth) of the FULL
 * mirror-analyze request minus its transport fields. Enumerated from
 * `mirrorAnalyzeRequestSchema` (sync.ts):
 *   - excluded (transport): `protocolVersion`, `requestId`, `kind`;
 *   - included: `binding` {serviceEpoch, graphGeneration, graphDigest} (the
 *     response echoes it byte-for-byte), `identity` {generation, digest}
 *     (the attested generation + attested sync digest — the serve path only
 *     consults the memo AFTER `MirrorState.databaseFor` proved the request
 *     identity equals the attested identity, so keying on `identity` IS
 *     keying on the attestation), and `intent` {schemaVersion, intentId,
 *     changeSetId, baseGeneration, parameters.*} in full.
 * The mirror-analyze request has NO other fields: no validation profile, no
 * config — `validationProfile` exists only on candidate requests, which are
 * NEVER memoized (the memo is consulted exclusively by
 * `serveMirrorAnalyzeCore` in worker.ts).
 *
 * VALUE — the exact semantic response object previously produced (success or
 * semantic analyze error; never transport/loop errors, which are thrown past
 * the memo). A hit is re-bound to the new requestId and re-serialized through
 * the same `bridgeResponseSchema.parse` path, so the emitted body bytes are
 * identical to the memoized trip's minus the requestId. Metrics are appended
 * AFTER the semantic frame is chosen (worker.ts `boundedResponseFrame`), so
 * memoized values never contain another request's metrics.
 *
 * INVALIDATION — cleared on ANY mirror change through MirrorState's single
 * `setAttested` choke point (every successful sync apply, every hydrate,
 * close) plus `markPoisoned`. Because every entry therefore shares the ONE
 * currently attested generation, clear-on-generation-change is the primary
 * bounding policy; `MEMO_MAX_ENTRIES` with oldest-first eviction is a
 * belt-and-braces cap for pathological many-distinct-intents-per-generation
 * workloads (steady state holds ~1 distinct entry per mutation).
 */
import type { BridgeResponse } from "./protocol";

/** Belt-and-braces cap; the primary policy is clear-on-generation-change. */
export const MEMO_MAX_ENTRIES = 32;

/** Structural view of the memoizable request parts (kept type-only loose to
 * avoid a runtime import cycle with sync.ts, which owns the schema). */
interface MemoizableRequest {
  binding: unknown;
  identity: unknown;
  intent: unknown;
}

/** Deterministic JSON: object keys sorted at every depth. */
function canonicalJson(value: unknown): string {
  const sortKeys = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortKeys);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, entry]) => [key, sortKeys(entry)])
      );
    }
    return input;
  };
  return JSON.stringify(sortKeys(value));
}

export class AnalyzeMemo {
  /** Insertion-ordered, so eviction under the cap drops the oldest entry. */
  private readonly entries = new Map<string, BridgeResponse>();
  private hitCount = 0;
  private missCount = 0;

  keyFor(request: MemoizableRequest): string {
    return canonicalJson({
      binding: request.binding,
      identity: request.identity,
      intent: request.intent
    });
  }

  lookup(key: string): BridgeResponse | undefined {
    const cached = this.entries.get(key);
    if (cached === undefined) {
      this.missCount += 1;
      return undefined;
    }
    this.hitCount += 1;
    return cached;
  }

  store(key: string, response: BridgeResponse): void {
    if (!this.entries.has(key) && this.entries.size >= MEMO_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, response);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  /** Test-seam counters (gate a/b/d observability — never metrics fields). */
  hits(): number {
    return this.hitCount;
  }

  misses(): number {
    return this.missCount;
  }
}
