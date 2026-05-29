import ts from "typescript";
import path from "node:path";
import { findNodeById, insertNodes, listChildren, listModules, modulePathOf } from "./nodes";
import type { NodeRow } from "./nodes";
import type { Db } from "./schema";
import { nodeId } from "./ids";
import { appendChildStatement } from "./appendChildStatement";
import { add_import } from "./addImport";
import { resolveDeclarationNameIdentifier } from "./declarationName";
import {
  queuePendingOp,
  queueTextSpanEdit,
  trackDeletedEdgeForRestore,
  trackDeletedNodeForRestore,
  trackInsertedNode,
  type TxHandle
} from "./transactions";
import type { Reference } from "./references";
import { analyzeMove, type ImporterRewrite } from "./moveAnalysis";

export interface MoveDeclarationManifest {
  newDeclarationId: string;
  name: string;
  sourceModulePath: string;
  targetModulePath: string;
  importersRewritten: { modulePath: string; style: ImporterRewrite["style"] }[];
  sourceBackImportAdded: boolean;
}

/**
 * Normalize a module path key for importer lookup. Mirrors how rendered keys
 * and stored module payloads relate: `path.resolve` is idempotent on the
 * absolute paths the store uses, and slash-normalization keeps Windows-style
 * separators aligned with analyzeMove's `normalizePath` output.
 */
function normalizeKey(p: string): string {
  return path.resolve(p).replaceAll("\\", "/");
}

/**
 * Find the importer's ImportDeclaration by its STORED child index. analyzeMove
 * derived `importStatementIndex` from the importer module's top-level statement
 * order; ingest stores top-level statements at matching 0-based child indices,
 * so the two coordinate systems align.
 */
function nthImportDeclaration(db: Db, moduleId: string, statementIndex: number) {
  return listChildren(db, moduleId).find(
    (c) => c.childIndex === statementIndex && c.kind === "ImportDeclaration"
  );
}

/**
 * Remove `name` (and one adjacent comma) from a `{ ... }` import payload,
 * returning a PAYLOAD-RELATIVE span edit. Re-parses the importer's stored
 * statement text in isolation so all offsets are relative to that payload, not
 * the rendered module.
 */
function computeBindingRemoval(
  payload: string,
  name: string
): { start: number; end: number; oldText: string; newText: string } | null {
  const sf = ts.createSourceFile("__imp__.ts", payload, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const stmt = sf.statements[0];
  if (!stmt || !ts.isImportDeclaration(stmt) || !stmt.importClause?.namedBindings) return null;
  const named = stmt.importClause.namedBindings;
  if (!ts.isNamedImports(named)) return null;
  const els = named.elements;
  const idx = els.findIndex((e) => e.name.text === name);
  if (idx < 0) return null;
  let start = els[idx]!.getStart(sf);
  let end = els[idx]!.getEnd();
  if (idx < els.length - 1) end = els[idx + 1]!.getStart(sf);
  else if (idx > 0) start = els[idx - 1]!.getEnd();
  return { start, end, oldText: payload.slice(start, end), newText: "" };
}

/**
 * Build a back-import statement for the source module: a `.ts`-extensioned
 * relative specifier from the source module to the target (matches
 * examples/medium's import style).
 */
function relativeImport(fromModulePath: string, toModulePath: string, name: string): string {
  const fromDir = path.dirname(normalizeKey(fromModulePath));
  let rel = path.relative(fromDir, normalizeKey(toModulePath)).replaceAll("\\", "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return `import { ${name} } from "${rel}";`;
}

/**
 * move_declaration apply — recreate-in-target + delete-from-source.
 *
 * The move mechanism: recreate the declaration in the target module (a new
 * target-derived ID via class-1 insertion through appendChildStatement), then
 * delete it from the source (the declaration node + its Identifier children +
 * their reference edges, all tracked for rollback). Returns the manifest
 * skeleton.
 *
 * The analyzeMove gate runs BEFORE any node insertion/deletion: on a rejected
 * move (non-self-contained, not exported, collision, …) this throws and leaves
 * the store untouched.
 *
 * Importer rewrites + the source back-import: each importer's stored
 * ImportDeclaration payload is edited in PAYLOAD-RELATIVE coordinates
 * (path-rewrite replaces the specifier; split-out removes the binding and
 * adds a new import to the importer pointing at the target), and the source
 * module gets a back-import iff it still uses the symbol after the move.
 */
export function move_declaration(
  db: Db,
  tx: TxHandle,
  declarationId: string,
  targetModuleId: string,
  renderedByPath: Map<string, string>,
  options: ts.CompilerOptions
): MoveDeclarationManifest {
  const decl = findNodeById(db, declarationId);
  if (!decl) throw new Error(`move_declaration: declaration not found: ${declarationId}`);
  if (decl.parentId === null || decl.childIndex === null) {
    throw new Error(`move_declaration: ${declarationId} is not a top-level declaration`);
  }
  const target = findNodeById(db, targetModuleId);
  if (!target || target.kind !== "Module") {
    throw new Error(`move_declaration: target ${targetModuleId} is not a Module`);
  }
  const sourceModulePath = modulePathOf(db, declarationId);
  const targetModulePath = target.payload;
  if (decl.parentId === targetModuleId) {
    throw new Error(`move_declaration: declaration already lives in the target module`);
  }

  const nameId = resolveDeclarationNameIdentifier(db, declarationId);
  if (!nameId) throw new Error(`move_declaration: declaration ${declarationId} has no name identifier`);
  const name = (JSON.parse(nameId.payload) as { text: string }).text;

  // Analyze BEFORE any mutation. analyzeMove throws-by-return: on rejection we
  // throw and the store is untouched (no insert, no delete).
  const analysis = analyzeMove(renderedByPath, options, {
    sourcePath: sourceModulePath,
    declChildIndex: decl.childIndex,
    name,
    targetPath: targetModulePath
  });
  if (!analysis.ok) throw new Error(analysis.reason);

  // Recreate in target (class-1 insertion). Use the STORED kind (decl.kind),
  // not analysis.declKind (the parsed ts.SyntaxKind name) — only the stored
  // kind matches a clean re-ingest of the rendered text. Keep a leading
  // blank-line separator so the rendered statement is visually separated.
  const normalized = decl.payload.startsWith("\n")
    ? decl.payload
    : `\n\n${decl.payload.replace(/^\s+/, "")}`;
  const newDeclarationId = appendChildStatement(db, tx, targetModuleId, decl.kind, normalized);

  // Delete from source: the declaration node + its Identifier children + their
  // reference edges, AND re-index the surviving siblings (statements with
  // childIndex > deletedIndex, plus the EndOfFileTrivia node) DOWN by one.
  //
  // A node's id is `nodeId(modulePath, [childIndex], kind)`, so removing the
  // decl at index K leaves a gap: surviving siblings keep stale ids at their
  // old (too-high) childIndex. A clean re-ingest of the now-shorter module
  // would place them one slot lower. Without re-indexing, (a) the EOF node's id
  // is stale → re-ingest equivalence fails, and (b) at commit, refreshReferenceEdges
  // resolves a surviving sibling at its CORRECT (lowered) index → a fresh edge
  // references an id absent from `nodes` → FOREIGN KEY constraint failed.
  //
  // This is symmetric to appendChildStatement's EOF up-shift on insert.
  const sourceModuleId = decl.parentId; // source module id (NOT the target)
  const deletedIndex = decl.childIndex; // the freed slot

  const idChildren = listChildren(db, declarationId).filter((c) => c.kind === "Identifier");
  const deletedIds = [...idChildren, decl].map((ch) => ch.id);

  // Surviving siblings: every source-module child past the decl, ascending by
  // childIndex. This INCLUDES the EndOfFileTrivia node and any surviving
  // statements. (Use the SOURCE module id, not the target.)
  const survivors = listChildren(db, sourceModuleId)
    .filter((c) => c.childIndex !== null && c.childIndex > deletedIndex)
    .sort((a, b) => a.childIndex! - b.childIndex!);

  // Capture every reference edge touching any decl-subtree node about to be
  // deleted, in a single query, BEFORE the delete — so rollback can re-insert
  // them verbatim. A single SELECT over the full id set (rather than per-node)
  // naturally de-duplicates edges whose BOTH endpoints are in the delete set
  // (e.g. an internal edge from one identifier to the decl name); a per-node
  // capture would double-count those.
  const placeholders = deletedIds.map(() => "?").join(", ");
  const capturedEdges = db
    .prepare(
      `SELECT from_node_id AS fromNodeId, to_node_id AS toNodeId, kind
       FROM node_references
       WHERE from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders})`
    )
    .all(...deletedIds, ...deletedIds) as Reference[];
  trackDeletedEdgeForRestore(tx, capturedEdges);

  const delEdges = db.prepare(
    `DELETE FROM node_references WHERE from_node_id = ? OR to_node_id = ?`
  );
  const delNode = db.prepare(`DELETE FROM nodes WHERE id = ?`);

  // Plan the re-indexed survivor rows BEFORE any deletion so we can capture each
  // survivor's old row + its Identifier children + their edges for rollback.
  interface SurvivorPlan {
    oldNode: NodeRow;
    oldIdentifiers: NodeRow[];
    newRow: NodeRow;
  }
  const survivorPlans: SurvivorPlan[] = survivors.map((s) => {
    const newChildIndex = s.childIndex! - 1;
    const newId = nodeId(sourceModulePath, [newChildIndex], s.kind);
    const oldIdentifiers = listChildren(db, s.id).filter((c) => c.kind === "Identifier");
    return {
      oldNode: s,
      oldIdentifiers,
      newRow: {
        id: newId,
        kind: s.kind,
        parentId: sourceModuleId,
        childIndex: newChildIndex,
        payload: s.payload // payload UNCHANGED
      }
    };
  });

  // Capture survivor edges for rollback: every edge touching a survivor node or
  // any of its Identifier children. (refreshReferenceEdges re-resolves these at
  // commit since the survivor is re-inserted as a tracked-inserted node and the
  // source module is dirty; but rollback must restore the pre-move edges.)
  const survivorEdgeIds = survivorPlans.flatMap((p) => [
    p.oldNode.id,
    ...p.oldIdentifiers.map((i) => i.id)
  ]);
  if (survivorEdgeIds.length > 0) {
    const sph = survivorEdgeIds.map(() => "?").join(", ");
    const survivorEdges = db
      .prepare(
        `SELECT from_node_id AS fromNodeId, to_node_id AS toNodeId, kind
         FROM node_references
         WHERE from_node_id IN (${sph}) OR to_node_id IN (${sph})`
      )
      .all(...survivorEdgeIds, ...survivorEdgeIds) as Reference[];
    trackDeletedEdgeForRestore(tx, survivorEdges);
  }

  // Collision-freedom: DELETE every old row first (decl subtree + every survivor
  // node and its identifiers), THEN INSERT every re-indexed survivor row. Since
  // all old rows are gone before any new row goes in, no derived id can collide
  // with a still-present old row regardless of index order.
  const drop = db.transaction(() => {
    // 1. Delete the decl node + its Identifier children + their edges.
    for (const ch of [...idChildren, decl]) {
      trackDeletedNodeForRestore(tx, ch);
      delEdges.run(ch.id, ch.id);
      delNode.run(ch.id);
    }
    // 2. Delete every survivor's old row + its Identifier children + their edges.
    for (const plan of survivorPlans) {
      for (const ident of plan.oldIdentifiers) {
        trackDeletedNodeForRestore(tx, ident);
        delEdges.run(ident.id, ident.id);
        delNode.run(ident.id);
      }
      trackDeletedNodeForRestore(tx, plan.oldNode);
      delEdges.run(plan.oldNode.id, plan.oldNode.id);
      delNode.run(plan.oldNode.id);
    }
    // 3. Insert every re-indexed survivor row (no Identifier children emitted
    //    here: planMaterialization + emitIdentifiersForInserted re-emit them at
    //    the corrected childIndex at commit, and refreshReferenceEdges re-resolves
    //    their edges over the now-dirty source module. The EndOfFileTrivia node is
    //    skipped for identifier emission by planMaterialization — re-inserting it
    //    at the corrected index just fixes its stale id, which is all it needs).
    for (const plan of survivorPlans) {
      insertNodes(db, [plan.newRow]);
      trackInsertedNode(tx, plan.newRow.id);
    }
  });
  drop();

  // Importer rewrites + back-import. analyzeMove emitted OFFSET-FREE intents in
  // rendered-MODULE coordinates; here we apply them against each importer's
  // STORED ImportDeclaration payload (the statement's own text), recomputing
  // payload-relative offsets so the two-coordinate discipline holds.
  const moduleByPath = new Map<string, string>();
  for (const m of listModules(db)) moduleByPath.set(normalizeKey(m.payload), m.id);

  // analyzeMove ran FIRST and validated the move; every rewrite it promised is
  // reported in the manifest. If apply cannot carry out a promised rewrite, the
  // analyze/apply coordinate systems disagree — a bug — and a silent skip would
  // produce a HALF-APPLIED move whose manifest misreports success. Prefer LOUD
  // failure: throw with the rewrite coordinates so the mismatch is debuggable.
  for (const rw of analysis.importerRewrites) {
    const importerModuleId = moduleByPath.get(normalizeKey(rw.importerPath));
    if (!importerModuleId) {
      throw new Error(
        `move_declaration: importer module not found in store for promised rewrite: ${rw.importerPath}`
      );
    }
    const importStmt = nthImportDeclaration(db, importerModuleId, rw.importStatementIndex);
    if (!importStmt) {
      throw new Error(
        `move_declaration: import statement #${rw.importStatementIndex} not found in ${rw.importerPath} for promised rewrite`
      );
    }
    if (rw.style === "path-rewrite") {
      const at = importStmt.payload.indexOf(rw.oldSpecifier!);
      if (at < 0) {
        throw new Error(
          `move_declaration: specifier ${rw.oldSpecifier} not found in import payload for ${rw.importerPath}`
        );
      }
      queueTextSpanEdit(tx, importStmt.id, {
        start: at,
        end: at + rw.oldSpecifier!.length,
        oldText: rw.oldSpecifier!,
        newText: rw.newSpecifier!
      });
    } else {
      // split-out: remove the binding from this import's payload + add a new import.
      // Throw BEFORE add_import if the binding can't be located: otherwise the
      // old binding is left in place AND a duplicate import is appended,
      // producing a tsc conflict.
      const removal = computeBindingRemoval(importStmt.payload, rw.removeName!);
      if (!removal) {
        throw new Error(
          `move_declaration: could not locate binding ${rw.removeName} to remove in import payload for ${rw.importerPath}`
        );
      }
      queueTextSpanEdit(tx, importStmt.id, removal);
      add_import(db, tx, importerModuleId, rw.newImportText!);
    }
  }

  let sourceBackImportAdded = false;
  if (analysis.sourceStillUses) {
    const srcModuleId = decl.parentId; // still the source module id
    const rel = relativeImport(sourceModulePath, targetModulePath, name);
    add_import(db, tx, srcModuleId, rel);
    sourceBackImportAdded = true;
  }

  queuePendingOp(tx, {
    kind: "MoveDeclaration",
    paramsJson: JSON.stringify({
      declaration_id: declarationId,
      new_node_id: newDeclarationId,
      name,
      source: sourceModulePath,
      target: targetModulePath,
      importer_count: analysis.importerRewrites.length
    }),
    affectedNodeIdsJson: JSON.stringify([newDeclarationId, declarationId]),
    reasoning: null
  });

  return {
    newDeclarationId,
    name,
    sourceModulePath,
    targetModulePath,
    importersRewritten: analysis.importerRewrites.map((r) => ({
      modulePath: r.importerPath,
      style: r.style
    })),
    sourceBackImportAdded
  };
}

export const moveDeclaration = move_declaration;
