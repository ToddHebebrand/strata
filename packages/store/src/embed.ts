import { createHash } from "node:crypto";
import { findNodeById, modulePathOf } from "./nodes";
import { isVecAvailable, type Db } from "./schema";
import { resolveDeclarationNameIdentifier } from "./declarationName";

export interface EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

const OPENAI_ENDPOINT = "https://api.openai.com/v1/embeddings";
const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const DEFAULT_OPENAI_DIM = 1536;
const OPENAI_BATCH_SIZE = 100;

export interface OpenAIEmbeddingProviderOptions {
  apiKey?: string;
  model?: string;
  dim?: number;
  endpoint?: string;
  /** Inject for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIEmbeddingProviderOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.STRATA_EMBED_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OpenAIEmbeddingProvider: STRATA_EMBED_API_KEY is not set."
      );
    }
    this.apiKey = apiKey;
    this.model = opts.model ?? DEFAULT_OPENAI_MODEL;
    this.dim = opts.dim ?? DEFAULT_OPENAI_DIM;
    this.endpoint = opts.endpoint ?? OPENAI_ENDPOINT;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += OPENAI_BATCH_SIZE) {
      const slice = texts.slice(i, i + OPENAI_BATCH_SIZE);
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({ model: this.model, input: slice })
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `OpenAI embeddings request failed (${res.status}): ${body.slice(0, 200)}`
        );
      }
      const json = (await res.json()) as {
        data: { embedding: number[]; index: number }[];
      };
      const ordered = [...json.data].sort((a, b) => a.index - b.index);
      for (const row of ordered) {
        if (row.embedding.length !== this.dim) {
          throw new Error(
            `OpenAI embedding had ${row.embedding.length} dims; expected ${this.dim}`
          );
        }
        out.push(Float32Array.from(row.embedding));
      }
    }
    return out;
  }
}

/**
 * Build the deterministic text representation of a declaration for
 * embedding. Per design § Layer 2 — signature + module path + ref counts +
 * a small body excerpt. NOT naked code: structural context first, source
 * excerpt last, so semantically similar declarations cluster together.
 */
export function buildDeclarationEmbeddingText(
  db: Db,
  declarationId: string
): string {
  const decl = findNodeById(db, declarationId);
  if (!decl) {
    throw new Error(`buildDeclarationEmbeddingText: node not found: ${declarationId}`);
  }

  const modulePath = (() => {
    try {
      return modulePathOf(db, declarationId);
    } catch {
      return "<unknown>";
    }
  })();

  // Use resolveDeclarationNameIdentifier so that JSDoc'd declarations resolve
  // to the actual declaration name identifier, not the lowest-offset Identifier
  // child (a @param tag word for JSDoc'd decls).
  const identifier = resolveDeclarationNameIdentifier(db, declarationId);
  let name: string | null = null;
  if (identifier) {
    try {
      const parsed = JSON.parse(identifier.payload) as { text?: string };
      if (typeof parsed.text === "string") name = parsed.text;
    } catch {
      // payload not JSON, fine
    }
  }

  // Reference count: how many places point at this declaration's identifier.
  let refCount = 0;
  if (identifier) {
    const row = db
      .prepare(
        "SELECT count(*) AS c FROM node_references WHERE to_node_id = ?"
      )
      .get(identifier.id) as { c: number };
    refCount = row.c;
  }

  // Body excerpt: first line of payload (typically the signature),
  // followed by a small slice of remaining text.
  const payload = decl.payload ?? "";
  const firstNewline = payload.indexOf("\n");
  const signatureLine =
    firstNewline === -1 ? payload : payload.slice(0, firstNewline);
  const bodyExcerpt = payload.slice(0, 400);

  return [
    `module: ${modulePath}`,
    `kind: ${decl.kind}`,
    `name: ${name ?? "<anonymous>"}`,
    `references: ${refCount}`,
    `signature: ${signatureLine.trim()}`,
    `excerpt:\n${bodyExcerpt}`
  ].join("\n");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function vecToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

export interface EmbedDeclarationsResult {
  embedded: number;
  skipped: number;
}

/**
 * Embed the given declaration IDs and persist them to `node_embeddings` +
 * `embedding_meta`. Skips declarations whose (model, content_hash) already
 * matches what's stored. Throws if vec isn't available.
 */
export async function embedDeclarations(
  db: Db,
  declarationIds: readonly string[],
  provider: EmbeddingProvider
): Promise<EmbedDeclarationsResult> {
  if (!isVecAvailable(db)) {
    throw new Error(
      "embedDeclarations: sqlite-vec extension not loaded. Layer 2 unavailable."
    );
  }
  if (declarationIds.length === 0) {
    return { embedded: 0, skipped: 0 };
  }

  const getMeta = db.prepare(
    "SELECT model, content_hash FROM embedding_meta WHERE node_id = ?"
  );

  type Pending = { id: string; text: string; hash: string };
  const pending: Pending[] = [];
  let skipped = 0;

  for (const id of declarationIds) {
    const text = buildDeclarationEmbeddingText(db, id);
    const hash = sha256(`${provider.model}\0${text}`);
    const existing = getMeta.get(id) as
      | { model: string; content_hash: string }
      | undefined;
    if (
      existing &&
      existing.model === provider.model &&
      existing.content_hash === hash
    ) {
      skipped += 1;
      continue;
    }
    pending.push({ id, text, hash });
  }

  if (pending.length === 0) {
    return { embedded: 0, skipped };
  }

  // Provider batches internally; we hand it the whole list.
  const vectors = await provider.embedBatch(pending.map((p) => p.text));
  if (vectors.length !== pending.length) {
    throw new Error(
      `embedDeclarations: provider returned ${vectors.length} vectors for ${pending.length} inputs`
    );
  }

  const deleteVec = db.prepare(
    "DELETE FROM node_embeddings WHERE node_id = ?"
  );
  const insertVec = db.prepare(
    "INSERT INTO node_embeddings(node_id, embedding) VALUES (?, ?)"
  );
  const upsertMeta = db.prepare(
    `INSERT INTO embedding_meta(node_id, model, content_hash, embedded_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       model = excluded.model,
       content_hash = excluded.content_hash,
       embedded_at = excluded.embedded_at`
  );

  const now = Date.now();
  const writeAll = db.transaction(() => {
    for (let i = 0; i < pending.length; i += 1) {
      const p = pending[i]!;
      const vec = vectors[i]!;
      if (vec.length !== provider.dim) {
        throw new Error(
          `embedDeclarations: vector dim ${vec.length} != provider.dim ${provider.dim}`
        );
      }
      deleteVec.run(p.id);
      insertVec.run(p.id, vecToBlob(vec));
      upsertMeta.run(p.id, provider.model, p.hash, now);
    }
  });
  writeAll();

  return { embedded: pending.length, skipped };
}
