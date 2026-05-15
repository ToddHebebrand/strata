import type { Db } from "./schema";

export type ReferenceKind = "value" | "type" | "namespace";

export interface Reference {
  fromNodeId: string;
  toNodeId: string;
  kind: ReferenceKind;
}

export function insertReferences(db: Db, refs: Reference[]): void {
  const insert = db.prepare(
    `INSERT INTO node_references (from_node_id, to_node_id, kind)
     VALUES (@fromNodeId, @toNodeId, @kind)`
  );

  const insertMany = db.transaction((rows: Reference[]) => {
    for (const row of rows) {
      insert.run(row);
    }
  });

  insertMany(refs);
}

export function getReferencesByTo(db: Db, toNodeId: string): Reference[] {
  return db
    .prepare(
      `SELECT from_node_id AS fromNodeId, to_node_id AS toNodeId, kind
       FROM node_references WHERE to_node_id = ?`
    )
    .all(toNodeId) as Reference[];
}

export function getReferenceFrom(db: Db, fromNodeId: string): Reference | undefined {
  const row = db
    .prepare(
      `SELECT from_node_id AS fromNodeId, to_node_id AS toNodeId, kind
       FROM node_references WHERE from_node_id = ?`
    )
    .get(fromNodeId);

  return (row as Reference | undefined) ?? undefined;
}
