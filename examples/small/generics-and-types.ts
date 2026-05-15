// Exercises: generic functions and classes, conditional types,
// mapped types, template literal types, key remapping, type guards,
// inference with `infer`, default type parameters, and variance.

/** Strip readonly from every property in T. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Make every property optional, recursively. */
export type DeepPartial<T> = T extends object
  ? { [K in keyof T]?: DeepPartial<T[K]> }
  : T;

/** Pull the element type out of an array or readonly array. */
export type ElementOf<T> = T extends readonly (infer E)[] ? E : never;

/** Build event-handler property names: "click" -> "onClick". */
export type Handlers<Events extends string> = {
  [E in Events as `on${Capitalize<E>}`]: (event: E) => void;
};

/** Pick only the keys whose value type extends V. */
export type KeysMatching<T, V> = {
  [K in keyof T]-?: T[K] extends V ? K : never;
}[keyof T];

export interface User {
  id: string;
  name: string;
  age: number;
  isAdmin: boolean;
}

// Resolves to "id" | "name".
export type StringKeysOfUser = KeysMatching<User, string>;

/** Identity function that preserves narrow literal types. */
export function identity<const T>(value: T): T {
  return value;
}

/** Group an array by a derived key. */
export function groupBy<T, K extends PropertyKey>(
  items: readonly T[],
  keyFn: (item: T) => K,
): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const key = keyFn(item);
    (out[key] ??= []).push(item);
  }
  return out;
}

/** Type guard: is the value a non-null object? */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Asserts non-null; narrows in the caller's scope. */
export function assertDefined<T>(
  value: T | null | undefined,
  message = "value was nullish",
): asserts value is T {
  if (value === null || value === undefined) {
    throw new TypeError(message);
  }
}

/** Tiny typed event emitter using mapped types. */
export class TypedEmitter<EventMap extends Record<string, unknown>> {
  // Stored as `unknown` so we can index by an arbitrary key.
  private listeners: Partial<{
    [K in keyof EventMap]: Array<(payload: EventMap[K]) => void>;
  }> = {};

  on<K extends keyof EventMap>(
    event: K,
    handler: (payload: EventMap[K]) => void,
  ): () => void {
    const bucket = (this.listeners[event] ??= []);
    bucket.push(handler);
    return () => {
      this.listeners[event] = bucket.filter((h) => h !== handler) as typeof bucket;
    };
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    for (const handler of this.listeners[event] ?? []) {
      handler(payload);
    }
  }
}
