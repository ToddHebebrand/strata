import ts from "typescript";
import path from "node:path";
import { findNodeById, listChildren, listModules, modulePathOf } from "./nodes";
import type { Db } from "./schema";
import { removeChildStatement } from "./removeChildStatement";
import { resolveDeclarationNameIdentifier } from "./declarationName";
import { queuePendingOp, queueTextSpanEdit, type TxHandle } from "./transactions";
import { analyzeInline, type ImporterStrip, type SubstitutionIntent } from "./inlineAnalysis";

export interface InlineFunctionManifest {
  name: string;
  callSitesInlined: number;
  modulesTouched: string[];
  importersStripped: { modulePath: string; style: ImporterStrip["style"] }[];
  removedDeclarationId: string;
}

function normalizeKey(p: string): string {
  return path.resolve(p).replaceAll("\\", "/");
}

/**
 * Locate every `name(args)` CallExpression (plain identifier callee) in a stored
 * statement payload, returning PAYLOAD-RELATIVE spans in source order. Mirrors
 * the two-coordinate discipline: analysis works in rendered-module coordinates
 * and emits offset-free intents; here we re-parse the statement's own payload to
 * find the splice spans.
 */
function locateCallSpansInPayload(
  payload: string,
  name: string
): { start: number; end: number; text: string }[] {
  const sf = ts.createSourceFile("__call__.ts", payload, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const spans: { start: number; end: number; text: string }[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
      const start = n.getStart(sf);
      const end = n.getEnd();
      spans.push({ start, end, text: payload.slice(start, end) });
    }
    n.forEachChild(walk);
  };
  walk(sf);
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

/**
 * Remove `name` (and one adjacent comma) from a `{ ... }` import payload,
 * returning a PAYLOAD-RELATIVE span edit. Re-parses the importer's stored
 * statement text in isolation so offsets are payload-relative. Mirrors
 * move_declaration's private computeBindingRemoval (kept local to keep move
 * untouched; identical semantics).
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
 * inline_function apply — replace every call site of an expression-body function
 * with its body (args substituted, parenthesized), delete the declaration, and
 * strip it from importers, all in one open transaction.
 *
 * The analyzeInline gate runs BEFORE any mutation: on a rejection (non-self-
 * contained, impure args, non-call use, …) this throws and leaves the store
 * untouched (all-or-nothing).
 *
 * Ordering / id-stability discipline: statement ids are position-derived, so a
 * removal re-indexes later siblings (new ids). We therefore execute ALL
 * structural removals first — the declaration (removeChildStatement on its
 * module) and every sole-binding importer (removeChildStatement on the
 * importer) — recording each removed index per module, THEN queue the call-site
 * payload edits at each call site's CURRENT (post-removal) statement index. This
 * keeps the "importer that imports AND calls the function" case coherent: the
 * import (index 0) is removed, the call statement settles to its lowered index,
 * and the splice lands on the right node id. Mixed importers are payload edits
 * (computeBindingRemoval) that don't re-index.
 */
export function inline_function(
  db: Db,
  tx: TxHandle,
  functionId: string,
  renderedByPath: Map<string, string>,
  options: ts.CompilerOptions
): InlineFunctionManifest {
  const fn = findNodeById(db, functionId);
  if (!fn) throw new Error(`inline_function: declaration not found: ${functionId}`);
  if (fn.parentId === null || fn.childIndex === null) {
    throw new Error(`inline_function: ${functionId} is not a top-level declaration`);
  }
  const fnModulePath = modulePathOf(db, functionId);

  const nameId = resolveDeclarationNameIdentifier(db, functionId);
  if (!nameId) throw new Error(`inline_function: ${functionId} has no name identifier`);
  const name = (JSON.parse(nameId.payload) as { text: string }).text;

  const analysis = analyzeInline(renderedByPath, options, {
    functionPath: fnModulePath,
    functionChildIndex: fn.childIndex,
    name
  });
  if (!analysis.ok) throw new Error(analysis.reason);

  // Module-path -> module id map for call-site + importer lookups.
  const moduleByPath = new Map<string, string>();
  for (const m of listModules(db)) moduleByPath.set(normalizeKey(m.payload), m.id);

  // --- Phase A: plan structural removals (record removed index per module). ---
  // The declaration always removes its own statement.
  const removalByModule = new Map<string, number>();
  removalByModule.set(normalizeKey(fnModulePath), fn.childIndex);

  interface BindingRemoval {
    importerModuleId: string;
    importStatementIndex: number;
    modulePath: string;
  }
  const removedStatementImporters: { importerModuleId: string; importStatementIndex: number; modulePath: string; moduleKey: string }[] = [];
  const removedBindingImporters: BindingRemoval[] = [];

  for (const strip of analysis.importerStrips) {
    const moduleKey = normalizeKey(strip.importerPath);
    const importerModuleId = moduleByPath.get(moduleKey);
    if (!importerModuleId) {
      throw new Error(`inline_function: importer module not found for promised strip: ${strip.importerPath}`);
    }
    const modulePath = findNodeById(db, importerModuleId)!.payload;
    if (strip.style === "removed-statement") {
      removalByModule.set(moduleKey, strip.importStatementIndex);
      removedStatementImporters.push({ importerModuleId, importStatementIndex: strip.importStatementIndex, modulePath, moduleKey });
    } else {
      removedBindingImporters.push({ importerModuleId, importStatementIndex: strip.importStatementIndex, modulePath });
    }
  }

  // --- Phase B: execute structural removals (declaration + sole-binding imports). ---
  removeChildStatement(db, tx, fn.parentId, fn.childIndex);
  for (const imp of removedStatementImporters) {
    removeChildStatement(db, tx, imp.importerModuleId, imp.importStatementIndex);
  }

  // --- Phase C: mixed-importer binding removals (payload edits, no re-index). ---
  // These run on statements whose ids are stable (binding removal doesn't shift
  // sibling indices). Resolve the import statement by its CURRENT index, which is
  // its original index minus 1 iff a removed-statement strip in the SAME module
  // preceded it (at most one removal per module, so this is exact).
  for (const imp of removedBindingImporters) {
    const moduleKey = normalizeKey(imp.modulePath);
    const removed = removalByModule.get(moduleKey);
    // A removed-binding importer is, by construction, NOT itself a removed-
    // statement importer; but another statement in the same module could have
    // been removed. removalByModule only holds the decl (other module) or a
    // sole-import (which would BE this statement) — so for a mixed import the
    // adjustment is 0 in practice; computed defensively.
    const currentIndex = removed !== undefined && removed < imp.importStatementIndex
      ? imp.importStatementIndex - 1
      : imp.importStatementIndex;
    const stmt = listChildren(db, imp.importerModuleId).find((c) => c.childIndex === currentIndex);
    if (!stmt) {
      throw new Error(`inline_function: import statement #${currentIndex} not found in ${imp.modulePath} for binding removal`);
    }
    const removal = computeBindingRemoval(stmt.payload, name);
    if (!removal) {
      throw new Error(`inline_function: could not locate binding ${name} to remove in ${imp.modulePath}`);
    }
    queueTextSpanEdit(tx, stmt.id, removal);
  }

  // --- Phase D: call-site substitutions at CURRENT (post-removal) indices. ---
  const touched = new Set<string>();
  touched.add(fnModulePath);
  for (const imp of removedStatementImporters) touched.add(imp.modulePath);
  for (const imp of removedBindingImporters) touched.add(imp.modulePath);

  // Group call-site intents by (moduleKey, originalIndex), preserving source
  // order (multiple calls in one statement → multiple intents, left-to-right).
  const groups = new Map<string, { moduleKey: string; originalIndex: number; intents: SubstitutionIntent[] }>();
  for (const cs of analysis.callSites) {
    const moduleKey = normalizeKey(cs.callSitePath);
    const gkey = `${moduleKey}#${cs.callSiteStatementIndex}`;
    let g = groups.get(gkey);
    if (!g) {
      g = { moduleKey, originalIndex: cs.callSiteStatementIndex, intents: [] };
      groups.set(gkey, g);
    }
    g.intents.push(cs);
  }

  for (const g of groups.values()) {
    const modId = moduleByPath.get(g.moduleKey);
    if (!modId) throw new Error(`inline_function: call-site module not found: ${g.moduleKey}`);
    const removed = removalByModule.get(g.moduleKey);
    const currentIndex = removed !== undefined && removed < g.originalIndex
      ? g.originalIndex - 1
      : g.originalIndex;
    const stmt = listChildren(db, modId).find((c) => c.childIndex === currentIndex);
    if (!stmt) {
      throw new Error(`inline_function: call-site statement #${currentIndex} not found in ${g.moduleKey}`);
    }
    const spans = locateCallSpansInPayload(stmt.payload, name);
    if (spans.length !== g.intents.length) {
      throw new Error(
        `inline_function: expected ${g.intents.length} call(s) to ${name} in ${g.moduleKey} statement #${currentIndex} but found ${spans.length}`
      );
    }
    // Pair span[k] (source order) with intent[k] (source order).
    spans.forEach((span, k) => {
      queueTextSpanEdit(tx, stmt.id, {
        start: span.start,
        end: span.end,
        oldText: span.text,
        newText: g.intents[k]!.replacementText
      });
    });
    touched.add(modulePathOf(db, stmt.id));
  }

  const importersStripped: { modulePath: string; style: ImporterStrip["style"] }[] = [
    ...removedStatementImporters.map((i) => ({ modulePath: i.modulePath, style: "removed-statement" as const })),
    ...removedBindingImporters.map((i) => ({ modulePath: i.modulePath, style: "removed-binding" as const }))
  ];

  queuePendingOp(tx, {
    kind: "InlineFunction",
    paramsJson: JSON.stringify({
      function_id: functionId,
      name,
      call_sites: analysis.callSites.length,
      importers: analysis.importerStrips.length
    }),
    affectedNodeIdsJson: JSON.stringify([functionId]),
    reasoning: null
  });

  return {
    name,
    callSitesInlined: analysis.callSites.length,
    modulesTouched: [...touched],
    importersStripped,
    removedDeclarationId: functionId
  };
}

export const inlineFunction = inline_function;
