import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);

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
  `);

  return db;
}
