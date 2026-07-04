import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { ingestBatch } from "@strata/ingest";
import { insertNodes, insertReferences, openDb, type Db } from "@strata/store";
import path from "node:path";

export interface OpenedSource {
  db: Db;
  /** True when the source was a corpus directory ingested into :memory:. */
  ephemeral: boolean;
}

const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist"]);

/**
 * Auto-detect an explore <source>: a directory is ingested into an ephemeral
 * in-memory store (zero setup; IDs are deterministic across invocations for
 * an unchanged tree), a file is opened as a persisted Strata db.
 */
export function openOrIngest(source: string): OpenedSource {
  if (!existsSync(source)) {
    throw new Error(`source path does not exist: ${source}`);
  }
  if (!statSync(source).isDirectory()) {
    return { db: openDb(source), ephemeral: false };
  }
  const modules = collectTsModules(source);
  if (modules.length === 0) {
    throw new Error(`no .ts modules found under ${source}`);
  }
  const batch = ingestBatch(modules);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  return { db, ephemeral: true };
}

function collectTsModules(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const absolutePath = path.join(dir, entry);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry)) walk(absolutePath);
      } else if (entry.endsWith(".ts")) {
        out.push({
          path: absolutePath,
          text: readFileSync(absolutePath, "utf8")
        });
      }
    }
  }

  walk(rootDir);
  return out;
}
