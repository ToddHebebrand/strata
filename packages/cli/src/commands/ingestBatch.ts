import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import { insertNodes, insertReferences, openDb } from "@strata/store";

export interface RunIngestBatchInput {
  rootDir: string;
  dbPath: string;
}

export function runIngestBatch(input: RunIngestBatchInput): { ok: boolean } {
  const modules = collectModules(input.rootDir);
  const batch = ingestBatch(modules);
  const db = openDb(input.dbPath);

  try {
    db.exec(`
      DELETE FROM node_references;
      DELETE FROM operations;
      DELETE FROM transactions;
      DELETE FROM nodes;
    `);
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);
    return { ok: true };
  } finally {
    db.close();
  }
}

function collectModules(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const absolutePath = path.join(dir, entry);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        walk(absolutePath);
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
