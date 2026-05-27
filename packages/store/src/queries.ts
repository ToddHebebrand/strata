import { findNodeById, type NodeRow } from "./nodes";
import { getReferencesByTo, type Reference } from "./references";
import type { Db } from "./schema";
import { resolveDeclarationNameIdentifier } from "./declarationName";

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

  // When a name filter is present, fetch all candidates by kind and then use
  // resolveDeclarationNameIdentifier to determine the true declaration name
  // from the parsed payload. This avoids the previous "lowest-offset
  // Identifier child" SQL heuristic which incorrectly matched JSDoc @param
  // tag identifiers (they appear at lower offsets than the declaration name
  // because getChildren() includes JSDoc nodes). O(N_decls) payload parses;
  // acceptable for now — a persisted name column can optimize later if needed.
  if (input.name) {
    const candidates = db
      .prepare(
        `
          SELECT id, kind, parent_id, child_index, payload
          FROM nodes
          WHERE kind IN (${kindPlaceholders})
        `
      )
      .all(...kindList)
      .map(rowToNode);

    return candidates.filter((candidate) => {
      const nameIdent = resolveDeclarationNameIdentifier(db, candidate.id);
      if (!nameIdent) return false;
      let parsed: { text?: string };
      try {
        parsed = JSON.parse(nameIdent.payload) as { text?: string };
      } catch {
        return false;
      }
      return parsed.text === input.name;
    });
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

  // Use resolveDeclarationNameIdentifier so that JSDoc'd declarations resolve
  // to the actual declaration name identifier, not the lowest-offset Identifier
  // child (which for JSDoc'd decls is a @param tag word with 0 references).
  const nameIdent = resolveDeclarationNameIdentifier(db, declarationId);
  if (!nameIdent) {
    return [];
  }

  return getReferencesByTo(db, nameIdent.id);
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
