import Database from "better-sqlite3";

export type Db = Database.Database;

export interface NodeRow {
  id: string;
  kind: string;
  parentId: string | null;
  childIndex: number | null;
  payload: string;
}

export interface LoadedModule {
  module: NodeRow;
  children: NodeRow[];
}

export function openDb(path: string): Db {
  const db = new Database(path);

  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      parent_id TEXT,
      child_index INTEGER,
      payload TEXT
    )
  `);

  return db;
}

export function insertNodes(db: Db, nodes: NodeRow[]): void {
  const insert = db.prepare(`
    INSERT INTO nodes (id, kind, parent_id, child_index, payload)
    VALUES (@id, @kind, @parentId, @childIndex, @payload)
  `);

  const insertMany = db.transaction((rows: NodeRow[]) => {
    for (const row of rows) {
      insert.run(row);
    }
  });

  insertMany(nodes);
}

export function loadModule(db: Db, moduleId: string): LoadedModule {
  const module = rowToNode(
    db
      .prepare(
        `
          SELECT id, kind, parent_id, child_index, payload
          FROM nodes
          WHERE id = ?
        `
      )
      .get(moduleId)
  );

  if (!module) {
    throw new Error(`Module not found: ${moduleId}`);
  }

  const children = db
    .prepare(
      `
        SELECT id, kind, parent_id, child_index, payload
        FROM nodes
        WHERE parent_id = ?
        ORDER BY child_index ASC
      `
    )
    .all(moduleId)
    .map(rowToNodeRequired);

  return { module, children };
}

export function listModules(db: Db): NodeRow[] {
  return db
    .prepare(
      `
        SELECT id, kind, parent_id, child_index, payload
        FROM nodes
        WHERE kind = 'Module'
        ORDER BY id ASC
      `
    )
    .all()
    .map(rowToNodeRequired);
}

interface NodeDbRow {
  id: string;
  kind: string;
  parent_id: string | null;
  child_index: number | null;
  payload: string;
}

function rowToNode(row: unknown): NodeRow | undefined {
  if (!row) {
    return undefined;
  }

  const dbRow = row as NodeDbRow;
  return {
    id: dbRow.id,
    kind: dbRow.kind,
    parentId: dbRow.parent_id,
    childIndex: dbRow.child_index,
    payload: dbRow.payload
  };
}

function rowToNodeRequired(row: unknown): NodeRow {
  const node = rowToNode(row);
  if (!node) {
    throw new Error("Expected node row");
  }
  return node;
}
