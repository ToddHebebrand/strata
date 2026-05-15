// Exercises: async functions, async generators, for-await-of,
// Promise.all / Promise.allSettled / Promise.race, AbortController,
// AsyncIterable producers, and structured error handling around awaits.

import { setTimeout as delay } from "node:timers/promises";

export interface FetchResult<T> {
  ok: boolean;
  value?: T;
  error?: Error;
  attempts: number;
}

/**
 * Run an async producer with retries and exponential backoff.
 * Bails out early if the supplied AbortSignal fires.
 */
export async function withRetry<T>(
  produce: () => Promise<T>,
  options: { retries?: number; baseMs?: number; signal?: AbortSignal } = {},
): Promise<FetchResult<T>> {
  const retries = options.retries ?? 3;
  const baseMs = options.baseMs ?? 25;
  let attempts = 0;
  let lastError: Error | undefined;

  for (let i = 0; i <= retries; i++) {
    attempts++;
    if (options.signal?.aborted) {
      return { ok: false, error: new Error("aborted"), attempts };
    }
    try {
      const value = await produce();
      return { ok: true, value, attempts };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i < retries) {
        await delay(baseMs * 2 ** i, undefined, { signal: options.signal });
      }
    }
  }
  return { ok: false, error: lastError, attempts };
}

/** Yields integers between [start, end), with optional delay between values. */
export async function* range(
  start: number,
  end: number,
  stepMs = 0,
): AsyncGenerator<number, void, void> {
  for (let i = start; i < end; i++) {
    if (stepMs > 0) await delay(stepMs);
    yield i;
  }
}

/** Consume an async iterable into an array. */
export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) {
    out.push(item);
  }
  return out;
}

/** Concurrent map with a configurable concurrency window. */
export async function mapConcurrent<T, U>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<U>,
  concurrency = 4,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let next = 0;

  async function pump(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  }

  // Spin up `concurrency` workers (or fewer if items are sparse).
  const pumps = Array.from({ length: Math.min(concurrency, items.length) }, () =>
    pump(),
  );
  await Promise.all(pumps);
  return results;
}

/** Race a promise against a timeout. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = delay(ms, "timeout", { signal: ctrl.signal }).then(() => {
    throw new Error(`timed out after ${ms}ms`);
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    ctrl.abort();
  }
}
