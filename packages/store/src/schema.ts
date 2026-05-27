import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export type Db = Database.Database;

/** Embedding dimension. Matches OpenAI text-embedding-3-small. */
export const EMBEDDING_DIM = 1536;

const VEC_AVAILABLE = Symbol.for("strata.vecAvailable");

interface VecAttachedDb {
  [VEC_AVAILABLE]?: boolean;
}

export function openDb(path: string): Db {
  const db = new Database(path);

  // Layer 2: best-effort load of the sqlite-vec extension. Some platforms
  // (or non-loadable better-sqlite3 builds) will throw; in that case Layer 2
  // is disabled gracefully and Layer 1 still works.
  let vecAvailable = false;
  try {
    sqliteVec.load(db);
    const probe = db.prepare("SELECT vec_version() AS v").get() as
      | { v: string }
      | undefined;
    vecAvailable = typeof probe?.v === "string";
  } catch {
    vecAvailable = false;
  }
  (db as unknown as VecAttachedDb)[VEC_AVAILABLE] = vecAvailable;

  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      parent_id TEXT,
      child_index INTEGER,
      payload TEXT
    );
    CREATE INDEX IF NOT EXISTS nodes_parent_kind_idx ON nodes(parent_id, kind);

    CREATE TABLE IF NOT EXISTS node_references (
      from_node_id TEXT NOT NULL PRIMARY KEY,
      to_node_id   TEXT NOT NULL,
      kind         TEXT NOT NULL,
      FOREIGN KEY (from_node_id) REFERENCES nodes(id),
      FOREIGN KEY (to_node_id)   REFERENCES nodes(id)
    );
    CREATE INDEX IF NOT EXISTS node_references_to_idx
      ON node_references(to_node_id);

    CREATE TABLE IF NOT EXISTS transactions (
      tx_id        TEXT PRIMARY KEY,
      started_at   INTEGER NOT NULL,
      committed_at INTEGER,
      status       TEXT NOT NULL,
      actor        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operations (
      op_id                  TEXT PRIMARY KEY,
      tx_id                  TEXT NOT NULL,
      kind                   TEXT NOT NULL,
      params_json            TEXT NOT NULL,
      affected_node_ids_json TEXT NOT NULL,
      actor                  TEXT NOT NULL,
      ts                     INTEGER NOT NULL,
      reasoning              TEXT,
      FOREIGN KEY (tx_id) REFERENCES transactions(tx_id)
    );
    CREATE INDEX IF NOT EXISTS operations_tx_idx ON operations(tx_id);

    CREATE TABLE IF NOT EXISTS embedding_meta (
      node_id      TEXT PRIMARY KEY,
      model        TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedded_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commit_pattern_meta (
      tx_id        TEXT PRIMARY KEY,
      model        TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedded_at  INTEGER NOT NULL,
      pattern_json TEXT NOT NULL
    );
  `);

  // Layer 3: idempotent migration. CREATE TABLE IF NOT EXISTS only fires on
  // first creation, so existing DBs miss new columns; ALTER TABLE here is
  // guarded by a PRAGMA probe so re-opening an already-migrated DB is a
  // no-op.
  if (!hasColumn(db, "transactions", "triggering_prompt")) {
    db.exec(`ALTER TABLE transactions ADD COLUMN triggering_prompt TEXT`);
  }

  // pattern_text → pattern_json rename: old stores hold the line-format string;
  // RENAME COLUMN preserves the data, then writers populate the structured form
  // on next embed and readers JSON.parse it. Pre-migration rows that still hold
  // the line-format text deserialize to an empty pattern in retrieve and are
  // skipped — acceptable since they re-embed on the next commit.
  if (
    hasColumn(db, "commit_pattern_meta", "pattern_text") &&
    !hasColumn(db, "commit_pattern_meta", "pattern_json")
  ) {
    db.exec(
      `ALTER TABLE commit_pattern_meta RENAME COLUMN pattern_text TO pattern_json`
    );
  }

  if (vecAvailable) {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS node_embeddings USING vec0(
         node_id TEXT PRIMARY KEY,
         embedding FLOAT[${EMBEDDING_DIM}]
       );`
    );
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS commit_pattern_embeddings USING vec0(
         tx_id TEXT PRIMARY KEY,
         embedding FLOAT[${EMBEDDING_DIM}]
       );`
    );
  }

  return db;
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return rows.some((row) => row.name === column);
}

/**
 * True iff the sqlite-vec extension successfully loaded for this DB handle.
 * Layer 2 features (`node_embeddings`, `semantic_search`) require this; when
 * false, callers should fall back to Layer 1 behavior.
 */
export function isVecAvailable(db: Db): boolean {
  return (db as unknown as VecAttachedDb)[VEC_AVAILABLE] === true;
}
