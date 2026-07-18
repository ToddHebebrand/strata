/**
 * resolveDeclarationNameIdentifier — bridge between the parsed payload and the
 * persisted Identifier child rows.
 *
 * The bug this fixes: `find_declarations` (and sibling functions) previously
 * used a SQL subquery that picked the *lowest-offset* Identifier child of a
 * declaration to identify "the declaration's name." But `emitIdentifiers` in
 * `@strata-code/ingest` uses `getChildren()`, which includes JSDoc nodes. For any
 * JSDoc'd declaration, the lowest-offset Identifier is a `@param`/`@returns`
 * tag word, not the declaration name itself.
 *
 * Fix-B: get_references, rename_symbol, discovery.ts, embed.ts, and
 * callsites.ts have been migrated to use this helper.
 */

import ts from "typescript";
import { findNodeById, type NodeRow } from "./nodes";
import type { Db } from "./schema";

interface IdentifierRow {
  id: string;
  kind: string;
  parent_id: string | null;
  child_index: number | null;
  payload: string;
}

/**
 * Given a declaration node's db id, resolve the Identifier child that
 * represents the declaration's *name* — as determined by parsing the payload
 * as TypeScript source, not by lowest-offset heuristic.
 *
 * Declaration kinds handled:
 *   - FunctionDeclaration  → statement.name
 *   - InterfaceDeclaration → statement.name
 *   - ClassDeclaration     → statement.name
 *   - TypeAliasDeclaration → statement.name
 *   - FirstStatement (i.e. `export const X = ...`) → first VariableDeclaration
 *     whose name is a simple Identifier. Multi-declarator and destructured
 *     cases (`export const { a, b } = …`) return undefined.
 *
 * Returns undefined when:
 *   - The declaration node does not exist in the DB.
 *   - The payload cannot be parsed as a recognizable declaration kind.
 *   - No persisted Identifier child matches the expected {text, offset}.
 */
export function resolveDeclarationNameIdentifier(
  db: Db,
  declarationId: string
): NodeRow | undefined {
  const declRow = findNodeById(db, declarationId);
  if (!declRow) {
    return undefined;
  }

  const payload = declRow.payload;

  // Parse the payload as a synthetic TypeScript source file. The payload is
  // exactly `statement.getFullText()` from ingest — it includes any leading
  // JSDoc trivia. We take the first statement from the synthetic file.
  const syntheticSrc = ts.createSourceFile(
    "dummy.ts",
    payload,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );

  const stmt = syntheticSrc.statements[0];
  if (!stmt) {
    return undefined;
  }

  // Extract the name identifier from the statement using the same logic as
  // pickDeclarationIdentifier in @strata-code/ingest/src/batch.ts, plus the
  // FirstStatement (VariableStatement) case that batch.ts doesn't need to
  // handle because it works through the TypeChecker, not structural matching.
  const nameIdent = pickNameIdentifier(syntheticSrc, stmt);
  if (!nameIdent) {
    return undefined;
  }

  // The offset stored by emitIdentifiers is:
  //   node.getStart(sourceFile) - statement.getFullStart()
  // getStart() strips leading trivia; getFullStart() is the raw start
  // (including leading trivia). Since the payload *is* the statement's full
  // text starting from getFullStart(), the relative offset is simply
  // nameIdent.getStart(syntheticSrc) - stmt.getFullStart().
  // (In the synthetic file, stmt.getFullStart() equals 0 only when the
  // payload starts at position 0 — which it does, since it is the full text
  // of the statement with its leading trivia.)
  const nameText = nameIdent.text;
  const nameOffset = nameIdent.getStart(syntheticSrc) - stmt.getFullStart();

  // Look up the persisted Identifier child whose payload matches {text, offset}.
  // We query by parent_id + kind and then filter in JS to avoid a JSON index
  // (acceptable for declaration-count N; optimization can come later).
  const rows = db
    .prepare(
      `SELECT id, kind, parent_id, child_index, payload
       FROM nodes
       WHERE parent_id = ? AND kind = 'Identifier' AND json_valid(payload)`
    )
    .all(declarationId) as IdentifierRow[];

  for (const row of rows) {
    let parsed: { text?: string; offset?: number };
    try {
      parsed = JSON.parse(row.payload) as { text?: string; offset?: number };
    } catch {
      continue;
    }
    if (parsed.text === nameText && parsed.offset === nameOffset) {
      return {
        id: row.id,
        kind: row.kind,
        parentId: row.parent_id,
        childIndex: row.child_index,
        payload: row.payload
      };
    }
  }

  return undefined;
}

/**
 * Extracts the name Identifier from a top-level statement node.
 * Mirrors the logic in @strata-code/ingest/src/batch.ts pickDeclarationIdentifier,
 * extended with the VariableStatement/FirstStatement case.
 *
 * We do NOT import from @strata-code/ingest to avoid a circular dependency
 * (ingest depends on store).
 */
function pickNameIdentifier(
  sourceFile: ts.SourceFile,
  stmt: ts.Statement
): ts.Identifier | undefined {
  // FunctionDeclaration, InterfaceDeclaration, ClassDeclaration,
  // TypeAliasDeclaration all have a `.name` property.
  if (
    ts.isFunctionDeclaration(stmt) ||
    ts.isInterfaceDeclaration(stmt) ||
    ts.isClassDeclaration(stmt) ||
    ts.isTypeAliasDeclaration(stmt)
  ) {
    if (stmt.name && ts.isIdentifier(stmt.name)) {
      return stmt.name;
    }
    return undefined;
  }

  // VariableStatement (persisted as "FirstStatement" due to TypeScript enum
  // alias): walk to the first VariableDeclaration whose name is a simple
  // Identifier. Destructured and multi-binding cases return undefined.
  if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        return decl.name;
      }
    }
    return undefined;
  }

  return undefined;
}
