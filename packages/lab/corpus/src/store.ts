// The core in-memory key-value store.
//
// Responsibilities:
//   - hold key -> Entry mappings
//   - enforce per-entry TTLs (lazily on access + via sweep())
//   - enforce a max size via LRU eviction
//   - emit lifecycle events via an EventBus
//   - track aggregate statistics
//
// Persistence and the CLI live in sibling modules.

import { EventBus } from "./events.ts";
import { LruIndex } from "./lru.ts";
import {
  type Clock,
  type Entry,
  type PutOptions,
  type SnapshotShape,
  type StoreStats,
  systemClock,
} from "./types.ts";

export interface StoreOptions {
  maxEntries?: number;
  defaultTtlMs?: number;
  clock?: Clock;
}

export class KvStore<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly lru = new LruIndex();
  private readonly bus = new EventBus<V>();
  private readonly clock: Clock;
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number | undefined;
  private stats: StoreStats = {
    size: 0,
    hits: 0,
    misses: 0,
    expirations: 0,
    evictions: 0,
    inserts: 0,
    deletes: 0,
  };

  constructor(options: StoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1024;
    this.defaultTtlMs = options.defaultTtlMs;
    this.clock = options.clock ?? systemClock;
    if (this.maxEntries <= 0) {
      throw new RangeError(`maxEntries must be positive (got ${this.maxEntries})`);
    }
  }

  /** Subscribe to store lifecycle events. Returns an unsubscribe fn. */
  subscribe(listener: (event: import("./types.ts").StoreEvent<V>) => void): () => void {
    return this.bus.subscribe(listener);
  }

  /** Number of live (non-expired) entries, post-sweep. */
  size(): number {
    this.sweep();
    return this.entries.size;
  }

  /** Return a defensive copy of the current stats. */
  getStats(): StoreStats {
    return { ...this.stats, size: this.entries.size };
  }

  /** Insert or replace a key. Touches LRU; emits a "put" event. */
  put(key: string, value: V, options: PutOptions = {}): void {
    const now = this.clock.now();
    const ttlMs = options.ttlMs ?? this.defaultTtlMs;
    const expiresAt = ttlMs === undefined ? null : now + ttlMs;

    const previous = this.entries.get(key);
    const entry: Entry<V> = {
      key,
      value,
      insertedAt: now,
      expiresAt,
      tags: options.tags ? [...options.tags] : [],
      hits: previous?.hits ?? 0,
    };

    this.entries.set(key, entry);
    this.lru.touch(key);
    if (!previous) {
      this.stats.inserts++;
    }
    this.enforceCapacity();
    this.bus.emit({ type: "put", key, value });
  }

  /** Get a value. Returns undefined for missing or expired entries. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.stats.misses++;
      this.bus.emit({ type: "miss", key });
      return undefined;
    }
    if (this.isExpired(entry)) {
      this.removeInternal(key, "expired");
      this.stats.misses++;
      this.bus.emit({ type: "miss", key });
      return undefined;
    }
    // Bump hit count and move to MRU position.
    this.entries.set(key, { ...entry, hits: entry.hits + 1 });
    this.lru.touch(key);
    this.stats.hits++;
    this.bus.emit({ type: "hit", key });
    return entry.value;
  }

  /** Read metadata for a key without bumping LRU or counters. */
  peek(key: string): Entry<V> | undefined {
    const entry = this.entries.get(key);
    if (!entry || this.isExpired(entry)) return undefined;
    return entry;
  }

  /** Returns true iff the key exists and is not expired. */
  has(key: string): boolean {
    return this.peek(key) !== undefined;
  }

  /** Manually delete a key. Returns true if the key was present. */
  delete(key: string): boolean {
    if (!this.entries.has(key)) return false;
    this.removeInternal(key, "manual");
    return true;
  }

  /** Drop every entry that carries the given tag. */
  invalidateTag(tag: string): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.tags.includes(tag)) {
        this.removeInternal(key, "manual");
        removed++;
      }
    }
    return removed;
  }

  /** Drop everything. Emits a single "clear" event. */
  clear(): void {
    this.entries.clear();
    this.lru.clear();
    this.bus.emit({ type: "clear" });
  }

  /** Remove all expired entries proactively. Returns the count removed. */
  sweep(): number {
    const now = this.clock.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.removeInternal(key, "expired");
        removed++;
      }
    }
    return removed;
  }

  /** Iterate live entries oldest-first (good for snapshots). */
  *entriesOldestFirst(): IterableIterator<Entry<V>> {
    this.sweep();
    for (const key of this.lru.keysOldestFirst()) {
      const entry = this.entries.get(key);
      if (entry) yield entry;
    }
  }

  /** Build a serializable snapshot of the current state. */
  snapshot(): SnapshotShape<V> {
    return {
      version: 1,
      takenAt: this.clock.now(),
      entries: Array.from(this.entriesOldestFirst()),
    };
  }

  /** Replace the current contents from a snapshot. */
  restore(snapshot: SnapshotShape<V>): void {
    this.entries.clear();
    this.lru.clear();
    const now = this.clock.now();
    for (const entry of snapshot.entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) continue;
      this.entries.set(entry.key, entry);
      this.lru.touch(entry.key);
    }
  }

  // ----- internals -------------------------------------------------------

  private isExpired(entry: Entry<V>): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= this.clock.now();
  }

  private removeInternal(
    key: string,
    reason: "manual" | "expired" | "evicted",
  ): void {
    if (!this.entries.delete(key)) return;
    this.lru.remove(key);
    if (reason === "expired") this.stats.expirations++;
    else if (reason === "evicted") this.stats.evictions++;
    else this.stats.deletes++;
    this.bus.emit({ type: "delete", key, reason });
  }

  private enforceCapacity(): void {
    while (this.entries.size > this.maxEntries) {
      const victim = this.lru.oldest();
      if (victim === null) break;
      this.removeInternal(victim, "evicted");
    }
  }
}
