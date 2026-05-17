import type { Db } from "./schema";

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

export function findNodeById(db: Db, id: string): NodeRow | undefined {
  const row = db
    .prepare(
      `
        SELECT id, kind, parent_id, child_index, payload
        FROM nodes
        WHERE id = ?
      `
    )
    .get(id);

  return rowToNode(row);
}

/**
 * Walk a node's parent chain to its enclosing `kind:"Module"` node and
 * return that module's payload, which is the POSIX module path (modules
 * are roots; their payload is the path — see ingest `nodeId(modulePath,
 * [], "Module")`). Used by the add_parameter manifest so the agent sees
 * which module each rewritten callsite is in.
 */
export function modulePathOf(db: Db, nodeId: string): string {
  let current = findNodeById(db, nodeId);
  if (!current) {
    throw new Error(`modulePathOf: node not found: ${nodeId}`);
  }
  const seen = new Set<string>();
  while (current.kind !== "Module") {
    if (current.parentId === null || seen.has(current.id)) {
      throw new Error(
        `modulePathOf: no Module ancestor for node ${nodeId}`
      );
    }
    seen.add(current.id);
    const parent = findNodeById(db, current.parentId);
    if (!parent) {
      throw new Error(
        `modulePathOf: dangling parent ${current.parentId} for ${current.id}`
      );
    }
    current = parent;
  }
  return current.payload;
}

export function loadModule(db: Db, moduleId: string): LoadedModule {
  const module = findNodeById(db, moduleId);

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

export function listChildren(db: Db, parentId: string): NodeRow[] {
  return db
    .prepare(
      `
        SELECT id, kind, parent_id, child_index, payload
        FROM nodes
        WHERE parent_id = ?
        ORDER BY child_index ASC
      `
    )
    .all(parentId)
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
