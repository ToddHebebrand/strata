// JSON file persistence for the store. Atomic writes via a temp file
// + rename, which is the cheapest correctness story on POSIX.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { KvStore } from "./store.ts";
import type { SnapshotShape } from "./types.ts";

/** Save the store's current snapshot to disk. */
export async function saveToFile<V>(
  store: KvStore<V>,
  path: string,
): Promise<void> {
  const snapshot = store.snapshot();
  const serialized = JSON.stringify(snapshot, null, 2);

  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, serialized, "utf8");
  await rename(tempPath, path);
}

/** Load a snapshot from disk and restore it into the given store. */
export async function loadFromFile<V>(
  store: KvStore<V>,
  path: string,
): Promise<void> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as SnapshotShape<V>;
  if (parsed.version !== 1) {
    throw new Error(
      `unsupported snapshot version ${parsed.version} at ${path} (expected 1)`,
    );
  }
  store.restore(parsed);
}
