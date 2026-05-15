// A small ordered key tracker used by the store to implement LRU eviction.
// We rely on `Map`'s insertion-order iteration: re-inserting a key moves
// it to the end, so the first key in iteration order is always the LRU.

export class LruIndex {
  private order = new Map<string, true>();

  /** Mark the key as most-recently used. Adds it if not present. */
  touch(key: string): void {
    if (this.order.has(key)) {
      this.order.delete(key);
    }
    this.order.set(key, true);
  }

  /** Remove the key entirely. No-op if absent. */
  remove(key: string): void {
    this.order.delete(key);
  }

  /** Return the least-recently-used key, or null if empty. */
  oldest(): string | null {
    const iter = this.order.keys().next();
    return iter.done ? null : iter.value;
  }

  /** Clear all tracked keys. */
  clear(): void {
    this.order.clear();
  }

  get size(): number {
    return this.order.size;
  }

  /** Iterate keys from oldest to newest. */
  *keysOldestFirst(): IterableIterator<string> {
    for (const key of this.order.keys()) {
      yield key;
    }
  }
}
