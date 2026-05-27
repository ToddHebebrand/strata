import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "./embed";
import { findNodeById, listChildren, modulePathOf } from "./nodes";
import { isVecAvailable, type Db } from "./schema";

const PROMPT_MAX_CHARS = 200;

function vecToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function describeAffectedNode(
  db: Db,
  nodeId: string
): { modulePath: string | null; declName: string | null } {
  const node = findNodeById(db, nodeId);
  if (!node) {
    return { modulePath: null, declName: null };
  }

  let modulePath: string | null = null;
  try {
    modulePath = modulePathOf(db, nodeId);
  } catch {
    modulePath = null;
  }

  let declName: string | null = null;
  let cursor = node;
  for (let depth = 0; depth < 16; depth += 1) {
    if (isDeclarationKind(cursor.kind)) {
      const identifier = listChildren(db, cursor.id).find(
        (child) => child.kind === "Identifier"
      );
      if (identifier) {
        declName = identifierText(identifier.payload);
      }
      break;
    }
    if (cursor.kind === "Identifier" && cursor.parentId) {
      const parent = findNodeById(db, cursor.parentId);
      if (parent && isDeclarationKind(parent.kind)) {
        declName = identifierText(cursor.payload);
        break;
      }
    }
    if (!cursor.parentId) break;
    const parent = findNodeById(db, cursor.parentId);
    if (!parent) break;
    cursor = parent;
  }

  if (declName === null && node.kind === "Identifier") {
    declName = identifierText(node.payload);
  }

  return { modulePath, declName };
}

function isDeclarationKind(kind: string): boolean {
  return (
    kind === "FunctionDeclaration" ||
    kind === "InterfaceDeclaration" ||
    kind === "TypeAliasDeclaration" ||
    kind === "ClassDeclaration" ||
    kind === "FirstStatement"
  );
}

function identifierText(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { text?: string };
    return typeof parsed.text === "string" ? parsed.text : null;
  } catch {
    return null;
  }
}

interface OpRow {
  kind: string;
  affected_node_ids_json: string;
}

interface TxRow {
  triggering_prompt: string | null;
}

export interface CommitPattern {
  prompt: string;
  ops: string[];
  modules: string[];
  declarations: string[];
}

/**
 * Build the structured pattern for one committed transaction. Canonical form
 * (persisted as JSON in commit_pattern_meta.pattern_json); the embedding text
 * is derived from this via renderCommitPatternForEmbedding.
 */
export function buildCommitPattern(db: Db, txId: string): CommitPattern {
  const txRow = db
    .prepare("SELECT triggering_prompt FROM transactions WHERE tx_id = ?")
    .get(txId) as TxRow | undefined;
  const prompt = (txRow?.triggering_prompt ?? "").slice(0, PROMPT_MAX_CHARS);

  const opRows = db
    .prepare(
      "SELECT kind, affected_node_ids_json FROM operations WHERE tx_id = ? ORDER BY ts ASC, op_id ASC"
    )
    .all(txId) as OpRow[];

  const ops = opRows.map((row) => row.kind);

  const modules = new Set<string>();
  const declarations = new Set<string>();
  for (const op of opRows) {
    let ids: string[];
    try {
      ids = JSON.parse(op.affected_node_ids_json) as string[];
    } catch {
      ids = [];
    }
    for (const id of ids) {
      const { modulePath, declName } = describeAffectedNode(db, id);
      if (modulePath) modules.add(modulePath);
      if (declName) declarations.add(declName);
    }
  }

  return {
    prompt,
    ops,
    modules: [...modules].sort(),
    declarations: [...declarations].sort()
  };
}

/**
 * Render the structured commit pattern as the human-readable text fed to the
 * embedding model. Deterministic and one-way: there is no parser for the
 * reverse direction — the canonical structured form is stored as JSON.
 */
export function renderCommitPatternForEmbedding(p: CommitPattern): string {
  return [
    `Prompt: ${p.prompt}`,
    `Ops: ${p.ops.join(", ")}`,
    `Modules: ${p.modules.join(", ")}`,
    `Declarations: ${p.declarations.join(", ")}`
  ].join("\n");
}

/**
 * Embed a single committed transaction's pattern into
 * `commit_pattern_embeddings` + `commit_pattern_meta`. Idempotent: skips when
 * the (model, content_hash) pair already matches. Caller is responsible for
 * gating on vec availability and embedding-provider presence.
 */
export async function embedCommitPattern(
  db: Db,
  txId: string,
  provider: EmbeddingProvider
): Promise<void> {
  if (!isVecAvailable(db)) {
    throw new Error(
      "embedCommitPattern: sqlite-vec extension not loaded. Layer 3 unavailable."
    );
  }

  const pattern = buildCommitPattern(db, txId);
  const embedText = renderCommitPatternForEmbedding(pattern);
  const hash = sha256(`${provider.model}\0${embedText}`);

  const existing = db
    .prepare(
      "SELECT model, content_hash FROM commit_pattern_meta WHERE tx_id = ?"
    )
    .get(txId) as { model: string; content_hash: string } | undefined;
  if (
    existing &&
    existing.model === provider.model &&
    existing.content_hash === hash
  ) {
    return;
  }

  const [vec] = await provider.embedBatch([embedText]);
  if (!vec) {
    throw new Error(
      "embedCommitPattern: provider returned no vector for the pattern text."
    );
  }
  if (vec.length !== provider.dim) {
    throw new Error(
      `embedCommitPattern: vector dim ${vec.length} != provider.dim ${provider.dim}`
    );
  }

  const now = Date.now();
  const patternJson = JSON.stringify(pattern);
  const writeAll = db.transaction(() => {
    db.prepare("DELETE FROM commit_pattern_embeddings WHERE tx_id = ?").run(txId);
    db.prepare(
      "INSERT INTO commit_pattern_embeddings(tx_id, embedding) VALUES (?, ?)"
    ).run(txId, vecToBlob(vec));
    db.prepare(
      `INSERT INTO commit_pattern_meta(tx_id, model, content_hash, embedded_at, pattern_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tx_id) DO UPDATE SET
         model = excluded.model,
         content_hash = excluded.content_hash,
         embedded_at = excluded.embedded_at,
         pattern_json = excluded.pattern_json`
    ).run(txId, provider.model, hash, now, patternJson);
  });
  writeAll();
}

export interface PastTaskHit {
  txId: string;
  prompt: string;
  ops: string[];
  modules: string[];
  declarations: string[];
  /** 1 - distance, clamped to [0, 1] for human-readable display. */
  similarity: number;
}

/**
 * Retrieve up to `k` past commit patterns whose embedding is closest to the
 * embedding of the new task prompt. Returns an empty array on cold start
 * (no rows in `commit_pattern_embeddings`) — never throws on empty.
 */
export async function retrieveSimilarPastTasks(
  db: Db,
  provider: EmbeddingProvider,
  taskPrompt: string,
  k = 5
): Promise<PastTaskHit[]> {
  if (!isVecAvailable(db)) {
    return [];
  }
  if (k <= 0) return [];

  const countRow = db
    .prepare("SELECT count(*) AS c FROM commit_pattern_embeddings")
    .get() as { c: number };
  if (countRow.c === 0) return [];

  const [queryVec] = await provider.embedBatch([taskPrompt]);
  if (!queryVec) return [];

  const rows = db
    .prepare(
      "SELECT tx_id, distance FROM commit_pattern_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?"
    )
    .all(vecToBlob(queryVec), k) as { tx_id: string; distance: number }[];

  const hits: PastTaskHit[] = [];
  const getMeta = db.prepare(
    "SELECT pattern_json FROM commit_pattern_meta WHERE tx_id = ?"
  );
  for (const row of rows) {
    const meta = getMeta.get(row.tx_id) as
      | { pattern_json: string }
      | undefined;
    if (!meta) continue;
    let parsed: CommitPattern;
    try {
      parsed = JSON.parse(meta.pattern_json) as CommitPattern;
    } catch {
      continue;
    }
    const similarity = Math.max(0, Math.min(1, 1 - row.distance));
    hits.push({
      txId: row.tx_id,
      prompt: parsed.prompt ?? "",
      ops: parsed.ops ?? [],
      modules: parsed.modules ?? [],
      declarations: parsed.declarations ?? [],
      similarity
    });
  }
  return hits;
}
