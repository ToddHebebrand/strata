import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata-code/ingest";
import {
  embedDeclarations,
  insertNodes,
  insertReferences,
  isVecAvailable,
  listModules,
  list_module_exports,
  OpenAIEmbeddingProvider,
  openDb
} from "@strata-code/store";

export interface RunEmbedInput {
  rootDir: string;
  dbPath: string;
}

export interface RunEmbedResult {
  ok: boolean;
  embedded: number;
  skipped: number;
  model?: string;
  reason?: string;
}

export async function runEmbed(input: RunEmbedInput): Promise<RunEmbedResult> {
  if (!process.env.STRATA_EMBED_API_KEY) {
    return {
      ok: false,
      embedded: 0,
      skipped: 0,
      reason: "STRATA_EMBED_API_KEY is not set."
    };
  }

  const modules = collectModules(input.rootDir);
  const batch = ingestBatch(modules);
  const db = openDb(input.dbPath);

  try {
    if (!isVecAvailable(db)) {
      return {
        ok: false,
        embedded: 0,
        skipped: 0,
        reason: "sqlite-vec extension did not load on this platform."
      };
    }

    const existingCount = (
      db.prepare("SELECT count(*) AS c FROM nodes").get() as { c: number }
    ).c;
    if (existingCount === 0) {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);
    }

    const provider = new OpenAIEmbeddingProvider();
    const declIds: string[] = [];
    for (const mod of listModules(db)) {
      for (const exp of list_module_exports(db, mod.id)) {
        declIds.push(exp.id);
      }
    }
    const result = await embedDeclarations(db, declIds, provider);
    return {
      ok: true,
      embedded: result.embedded,
      skipped: result.skipped,
      model: provider.model
    };
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
