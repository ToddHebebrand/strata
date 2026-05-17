// Shared types for the kvstore example.
// Keeping these in one place lets the rest of the codebase import
// from a single module instead of cross-importing implementation files.

/** Unix epoch milliseconds. */
export type Millis = number;

/**
 * Options controlling a single put() call.
 *
 * - `ttlMs`: how long until the entry expires. Omit for "never expires."
 * - `tags`: free-form labels used for grouped invalidation.
 */
export interface PutOptions {
  ttlMs?: number;
  tags?: readonly string[];
}

/** A stored entry. The store owns its lifecycle; consumers see read-only copies. */
export interface Entry<V> {
  readonly key: string;
  readonly value: V;
  readonly insertedAt: Millis;
  readonly expiresAt: Millis | null;
  readonly tags: readonly string[];
  readonly hits: number;
}

export interface StoreStats {
  size: number;
  hits: number;
  misses: number;
  expirations: number;
  evictions: number;
  inserts: number;
  deletes: number;
}

export type StoreEvent<V> =
  | { type: "put"; key: string; value: V }
  | { type: "delete"; key: string; reason: "manual" | "expired" | "evicted" }
  | { type: "hit"; key: string }
  | { type: "miss"; key: string }
  | { type: "clear" };

/**
 * Pluggable clock so tests can advance time deterministically.
 * The production clock is just `Date.now`.
 */
export interface Clock {
  now(): Millis;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** Result of a load operation from a persistence backend. */
export interface SnapshotShape<V> {
  version: 1;
  takenAt: Millis;
  entries: ReadonlyArray<Entry<V>>;
}
