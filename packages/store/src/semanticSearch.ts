import type { EmbeddingProvider } from "./embed";
import { findNodeById, listChildren, modulePathOf } from "./nodes";
import { isVecAvailable, type Db } from "./schema";

export interface SemanticHit {
  id: string;
  kind: string;
  name: string | null;
  modulePath: string;
  distance: number;
}

function vecToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

function identifierTextOf(db: Db, nodeId: string): string | null {
  for (const child of listChildren(db, nodeId)) {
    if (child.kind !== "Identifier") continue;
    try {
      const parsed = JSON.parse(child.payload) as { text?: string };
      if (typeof parsed.text === "string") return parsed.text;
    } catch {
      // not JSON, skip
    }
  }
  return null;
}

/**
 * Semantic search over declaration embeddings. Embeds the query via the
 * given provider, runs vec0 MATCH, and resolves hits back into structural
 * metadata (kind, name, module path). Throws if vec is unavailable.
 */
export async function semantic_search(
  db: Db,
  provider: EmbeddingProvider,
  query: string,
  k = 10
): Promise<SemanticHit[]> {
  if (!isVecAvailable(db)) {
    throw new Error(
      "semantic_search: sqlite-vec extension not loaded. Layer 2 unavailable."
    );
  }
  if (k <= 0) return [];
  const [vec] = await provider.embedBatch([query]);
  if (!vec) {
    throw new Error("semantic_search: embedding provider returned no vector.");
  }
  const rows = db
    .prepare(
      "SELECT node_id, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?"
    )
    .all(vecToBlob(vec), k) as { node_id: string; distance: number }[];

  const hits: SemanticHit[] = [];
  for (const row of rows) {
    const node = findNodeById(db, row.node_id);
    if (!node) continue;
    let modulePath = "<unknown>";
    try {
      modulePath = modulePathOf(db, node.id);
    } catch {
      // declaration's module ancestor missing; surface the hit anyway
    }
    hits.push({
      id: node.id,
      kind: node.kind,
      name: identifierTextOf(db, node.id),
      modulePath,
      distance: row.distance
    });
  }
  return hits;
}

export const semanticSearch = semantic_search;
