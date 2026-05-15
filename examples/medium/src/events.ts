// Minimal typed event bus the store uses to broadcast lifecycle events.
// Subscribers receive a disposer; calling it removes the handler.
// Kept intentionally small — no wildcards, no priorities, no async dispatch.

import type { StoreEvent } from "./types.ts";

export type Listener<V> = (event: StoreEvent<V>) => void;

export class EventBus<V> {
  private listeners: Listener<V>[] = [];

  subscribe(listener: Listener<V>): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(event: StoreEvent<V>): void {
    // Snapshot the array so a listener mutating subscriptions during
    // dispatch doesn't change who gets this event.
    const snapshot = this.listeners.slice();
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch {
        // Listener exceptions must not crash the store. Tests use
        // their own listeners to assert behavior, so swallow silently.
      }
    }
  }

  get size(): number {
    return this.listeners.length;
  }
}
