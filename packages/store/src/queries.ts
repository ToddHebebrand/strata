import { findNodeById, listChildren, type NodeRow } from "./nodes";
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
  const params: string[] = [];
  let sql = `
    SELECT id, kind, parent_id, child_index, payload
    FROM nodes
    WHERE 1 = 1
  `;

  if (input.kind) {
    sql += " AND kind = ?";
    params.push(KIND_TO_STATEMENT_KIND[input.kind]);
  } else {
    const kinds = Object.values(KIND_TO_STATEMENT_KIND);
    sql += ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
    params.push(...kinds);
  }

  const declarations = db
    .prepare(sql)
    .all(...params)
    .map(rowToNode);

  if (!input.name) {
    return declarations;
  }

  return declarations.filter((declaration) => {
    const identifier = listChildren(db, declaration.id).find(
      (child) => child.kind === "Identifier"
    );
    if (!identifier) {
      return false;
    }

    const payload = JSON.parse(identifier.payload) as { text: string };
    return payload.text === input.name;
  });
}

export function get_references(db: Db, declarationId: string): Reference[] {
  const declaration = findNodeById(db, declarationId);
  if (!declaration) {
    return [];
  }

  const declarationIdentifier = listChildren(db, declaration.id).find(
    (child) => child.kind === "Identifier"
  );
  if (!declarationIdentifier) {
    return [];
  }

  return getReferencesByTo(db, declarationIdentifier.id);
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
