import { findNodeById, type NodeRow } from "./nodes";
import { getReferencesByTo, type Reference } from "./references";
import type { Db } from "./schema";

export type DeclarationKind =
  | "interface"
  | "type-alias"
  | "class"
  | "function"
  | "variable";

export interface FindDeclarationsInput {
  name?: string;
  kind?: DeclarationKind;
}

// NOTE: `variable` maps to "FirstStatement" (not "VariableStatement") because
// ingest stores `export const X` as kind `"FirstStatement"`. SyntaxKind.
// FirstStatement and SyntaxKind.VariableStatement share enum value 244, and
// TypeScript's reverse-lookup (`ts.SyntaxKind[244]`) returns "FirstStatement"
// because that alias is assigned last in the JS reverse map. The previous
// mapping ("VariableStatement") never matched any persisted row, so neither
// the kind-filtered nor the no-kind name lookup (which uses Object.values of
// this map) could surface const decls. See 2026-05-26 Codex review and the
// preceding LAB-NOTES entries.
const KIND_TO_STATEMENT_KIND: Record<DeclarationKind, string> = {
  interface: "InterfaceDeclaration",
  "type-alias": "TypeAliasDeclaration",
  class: "ClassDeclaration",
  function: "FunctionDeclaration",
  variable: "FirstStatement"
};

export function find_declarations(
  db: Db,
  input: FindDeclarationsInput
): NodeRow[] {
  const kindList: string[] = input.kind
    ? [KIND_TO_STATEMENT_KIND[input.kind]]
    : Object.values(KIND_TO_STATEMENT_KIND);
  const kindPlaceholders = kindList.map(() => "?").join(", ");

  // When a name filter is present, push it into SQL via a join to the
  // Identifier child + json_extract on its payload. This replaces an
  // O(N_decls + 1) walk that did `listChildren` for every candidate just
  // to read the identifier text — fine on the bench corpus, expensive on
  // real codebases with hundreds of declarations per kind.
  if (input.name) {
    const rows = db
      .prepare(
        `
          SELECT d.id, d.kind, d.parent_id, d.child_index, d.payload
          FROM nodes d
          JOIN nodes i
            ON i.id = (
              SELECT i2.id
              FROM nodes i2
              WHERE i2.parent_id = d.id
                AND i2.kind = 'Identifier'
                AND json_valid(i2.payload)
              ORDER BY CAST(
                CASE
                  WHEN json_valid(i2.payload) THEN json_extract(i2.payload, '$.offset')
                  ELSE NULL
                END AS INTEGER
              ) ASC,
              i2.id ASC
              LIMIT 1
            )
          WHERE d.kind IN (${kindPlaceholders})
            AND CASE
              WHEN json_valid(i.payload) THEN json_extract(i.payload, '$.text')
              ELSE NULL
            END = ?
        `
      )
      .all(...kindList, input.name);
    return rows.map(rowToNode);
  }

  return db
    .prepare(
      `
        SELECT id, kind, parent_id, child_index, payload
        FROM nodes
        WHERE kind IN (${kindPlaceholders})
      `
    )
    .all(...kindList)
    .map(rowToNode);
}

export function get_references(db: Db, declarationId: string): Reference[] {
  const declaration = findNodeById(db, declarationId);
  if (!declaration) {
    return [];
  }

  // One targeted SQL instead of listChildren+filter: skip materializing every
  // sibling row just to read the Identifier child's id.
  const row = db
    .prepare(
      `SELECT id FROM nodes WHERE parent_id = ? AND kind = 'Identifier' LIMIT 1`
    )
    .get(declarationId) as { id: string } | undefined;
  if (!row) {
    return [];
  }

  return getReferencesByTo(db, row.id);
}

export const findDeclarations = find_declarations;
export const getReferences = get_references;

interface NodeDbRow {
  id: string;
  kind: string;
  parent_id: string | null;
  child_index: number | null;
  payload: string;
}

function rowToNode(row: unknown): NodeRow {
  const dbRow = row as NodeDbRow;
  return {
    id: dbRow.id,
    kind: dbRow.kind,
    parentId: dbRow.parent_id,
    childIndex: dbRow.child_index,
    payload: dbRow.payload
  };
}
