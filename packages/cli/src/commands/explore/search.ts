import {
  isVecAvailable,
  OpenAIEmbeddingProvider,
  semanticSearch,
  type Db
} from "@strata-code/store";
import {
  fail,
  kindLabel,
  ok,
  okJson,
  printTable,
  type CommandResult
} from "./format";

const EMBEDDINGS_HINT =
  "semantic search needs embeddings; set `STRATA_EMBED_API_KEY` and run `strata embed <corpusRoot> --db <path>`, then search against that db";

function embeddedDeclarationCount(db: Db): number {
  try {
    const row = db
      .prepare("SELECT count(*) AS n FROM node_embeddings")
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export async function runSearch(
  db: Db,
  query: string,
  k: number,
  json: boolean
): Promise<CommandResult> {
  if (!isVecAvailable(db)) {
    return fail(`sqlite-vec is unavailable in this build; ${EMBEDDINGS_HINT}`);
  }
  if (embeddedDeclarationCount(db) === 0) {
    return fail(`this store has no declaration embeddings; ${EMBEDDINGS_HINT}`);
  }
  const apiKey = process.env.STRATA_EMBED_API_KEY;
  if (!apiKey) {
    return fail(
      `STRATA_EMBED_API_KEY is not set (needed to embed the query); ${EMBEDDINGS_HINT}`
    );
  }

  const provider = new OpenAIEmbeddingProvider({ apiKey });
  const hits = await semanticSearch(db, provider, query, k);
  if (json) return okJson(hits);
  if (hits.length === 0) return ok(`no results for \`${query}\``);
  return ok(
    printTable(
      ["ID", "DISTANCE", "KIND", "NAME", "MODULE"],
      hits.map((hit) => [
        hit.id,
        hit.distance.toFixed(4),
        kindLabel(hit.kind),
        hit.name ?? "<unnamed>",
        hit.modulePath
      ])
    )
  );
}
