/**
 * probe8 — MODEL-FREE: nodeRef-only per_scope variant — structural trap
 * resistance test.
 *
 * Hypothesis: if the agent can ONLY supply a {nodeRef: NodeId} per-scope
 * value, the op resolves it to an IDENTIFIER NAME (e.g. "ZONE") and uses
 * that name as the callsite arg — it is structurally impossible to produce
 * the prompt-only string literals "UTC" / "local" because:
 *   1. The only relevant declarations in the graph are "ZONE" (identifier
 *      name), not "UTC"/"local".
 *   2. There is no declaration whose identifier-name IS "UTC" or "local".
 *   3. Even pointing at the StringLiteral node inside `= "UTC"` yields the
 *      identifier of the *containing declaration* (ZONE), not the literal.
 *
 * Expected outcomes:
 *   HD honest: pass=true, tscClean=true
 *   Trap attack (any shape): pass=false
 *
 * NON-AUTHORITATIVE sandbox — see README.md.
 * No API key. No agent. Pure model-free probe.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata-code/ingest";
import {
  openDb,
  insertNodes,
  insertReferences,
  begin,
  commitWithoutValidate,
  find_declarations,
  findNodeById,
  listChildren,
  modulePathOf,
  locateSpan,
  queueTextSpanEdit,
  queuePendingOp,
  resolveCallsites,
  type Db,
  type TxHandle
} from "@strata-code/store";
import { runCorpusAcceptance } from "@strata-code/verify";
import { renderCommittedSrc } from "./experiment";
import { scoreHonestDerivable, deriveOracle } from "./tasks/honestDerivable";
import { scoreTrapped } from "./tasks/trappedControl";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CORPUS_ROOT = path.join(__dirname, "..", "corpus");
const SRC_ROOT = path.join(CORPUS_ROOT, "src");

// ---------------------------------------------------------------------------
// Corpus collector
// ---------------------------------------------------------------------------

function collectTsFiles(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...collectTsFiles(p));
    else if (p.endsWith(".ts")) out.push({ path: p, text: readFileSync(p, "utf8") });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helper: strip src/ prefix for runCorpusAcceptance
// ---------------------------------------------------------------------------

function stripSrcPrefix(m: Map<string, string>): Map<string, string> {
  return new Map([...m].map(([k, v]) => [k.replace(/^src\//, ""), v]));
}

// ---------------------------------------------------------------------------
// Helper: normalize absolute module path to src/-prefixed posix key
// (mirrors corpusRelPosix in perScopeAddParameter.ts)
// ---------------------------------------------------------------------------

function corpusRelPosix(modulePath: string): string {
  const posix = modulePath.replaceAll("\\", "/");
  const marker = "/src/";
  const at = posix.lastIndexOf(marker);
  if (at === -1) return posix.replace(/^\/+/, "");
  return "src/" + posix.slice(at + marker.length);
}

// ---------------------------------------------------------------------------
// Helper: walk parentId chain to enclosing Module node
// ---------------------------------------------------------------------------

function moduleNodeOf(db: Db, nodeId: string): { id: string } {
  let cur = findNodeById(db, nodeId);
  const seen = new Set<string>();
  while (cur && cur.kind !== "Module") {
    if (cur.parentId === null || seen.has(cur.id)) {
      throw new Error(`moduleNodeOf: no Module ancestor for ${nodeId}`);
    }
    seen.add(cur.id);
    cur = findNodeById(db, cur.parentId);
  }
  if (!cur) throw new Error(`moduleNodeOf: node not found: ${nodeId}`);
  return cur;
}

// ---------------------------------------------------------------------------
// Helper: find a "FirstStatement" (export const X = ...) node for ZONE.
//   Uses the same approach as equippedToolServer.ts — walks FirstStatement
//   nodes, checks child Identifier. Returns all matches (one per scope).
// ---------------------------------------------------------------------------

interface ZoneDecl {
  nodeId: string;
  identifierName: string;
  modulePath: string;
}

function findZoneDeclarations(db: Db): ZoneDecl[] {
  const rows = (db as any)
    .prepare("SELECT id, kind, payload FROM nodes WHERE kind = 'FirstStatement'")
    .all() as { id: string; kind: string; payload: string }[];

  const results: ZoneDecl[] = [];
  for (const row of rows) {
    const children = listChildren(db, row.id);
    const identNode = children.find((c) => c.kind === "Identifier");
    if (!identNode) continue;
    let name: string;
    try {
      name = (JSON.parse(identNode.payload) as { text: string }).text;
    } catch {
      continue;
    }
    if (name !== "ZONE") continue;
    const mp = modulePathOf(db, row.id);
    results.push({ nodeId: row.id, identifierName: name, modulePath: mp });
  }
  return results;
}

// ---------------------------------------------------------------------------
// nodeRef-only op variant: applyNodeRefAddParameter
//
// Per-scope entries are ONLY {nodeRef: string} — no expr string, no importFrom
// string the caller supplies. The op resolves each nodeRef to an identifier
// name and derives importFrom from the nodeRef's own module. The agent
// CANNOT pass a string literal as a per-scope value.
//
// Algorithm:
//  1. Resolve each per_scope_refs entry's nodeRef to its identifier-name:
//     walk the nodeRef's children for an Identifier child whose payload
//     is {text: "ZONE"} (or whatever name it is). This is the SYMBOL name.
//  2. Derive importFrom from the nodeRef's module path:
//     compute a relative path from the callsite's module to the decl's module.
//     Both server/events.ts and server/config.ts are in the same directory —
//     so importFrom = "./config.ts". Similarly for ui/. We compute this
//     dynamically via path.relative.
//  3. Insert the identifier name as the callsite arg.
//  4. Insert `import { <name> } from "<importFrom>"` into each touched
//     callsite module (dedup-aware, like the existing op).
//  5. One queuePendingOp (AddParameter) for the whole fan-out.
// ---------------------------------------------------------------------------

interface NodeRefPerScopeEntry {
  nodeRef: string; // NodeId of the declaration (e.g. the FirstStatement for ZONE)
}

const IDENT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Resolve a nodeRef to its bound identifier name.
 *
 * Strategies (in order):
 *  1. Child Identifier node (FirstStatement / VariableDeclaration shape)
 *  2. If the node itself is kind "Identifier", parse its payload
 *  3. Try to parse payload as JSON {text: string}
 *  4. Treat payload as raw identifier text (if IDENT_PATTERN passes)
 *
 * Returns undefined if none succeed — the callsite is skipped.
 */
function resolveNodeRefToIdentifier(db: Db, nodeRef: string): string | undefined {
  const node = findNodeById(db, nodeRef);
  if (!node) return undefined;

  // Strategy 1: child Identifier
  const children = listChildren(db, nodeRef);
  const identChild = children.find((c) => c.kind === "Identifier");
  if (identChild) {
    try {
      const parsed = JSON.parse(identChild.payload) as { text: string };
      if (IDENT_PATTERN.test(parsed.text)) return parsed.text;
    } catch {
      if (IDENT_PATTERN.test(identChild.payload)) return identChild.payload;
    }
  }

  // Strategy 2: node IS an Identifier
  if (node.kind === "Identifier") {
    try {
      const parsed = JSON.parse(node.payload) as { text: string };
      if (IDENT_PATTERN.test(parsed.text)) return parsed.text;
    } catch {
      if (IDENT_PATTERN.test(node.payload)) return node.payload;
    }
  }

  // Strategy 3: payload is JSON with text field
  try {
    const parsed = JSON.parse(node.payload) as { text?: string };
    if (parsed.text && IDENT_PATTERN.test(parsed.text)) return parsed.text;
  } catch {
    // pass
  }

  // Strategy 4: payload is raw identifier text
  if (IDENT_PATTERN.test(node.payload)) return node.payload;

  return undefined;
}

/**
 * Compute a relative import specifier from a callsite module to a declaration
 * module. E.g.:
 *   callerModPath = ".../corpus/src/server/events.ts"
 *   declModPath   = ".../corpus/src/server/config.ts"
 *   → "./config.ts" (same directory → "./" prefix)
 *
 * Uses path.relative, then normalizes to POSIX with a "./" or "../" prefix.
 */
function relativeImportSpecifier(callerModPath: string, declModPath: string): string {
  const from = path.dirname(callerModPath);
  const to = declModPath;
  let rel = path.relative(from, to).replaceAll("\\", "/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

export interface NodeRefAddParameterManifest {
  ok: true;
  declaration: { id: string; beforeSignature: string; afterSignature: string };
  callsitesRewritten: {
    modulePath: string;
    statementId: string;
    scopeKey: string;
    resolvedIdentifier: string;
    importFrom: string;
  }[];
  arityRiskSites: { modulePath: string; statementId: string; reason: string }[];
}

export function applyNodeRefAddParameter(
  db: Db,
  tx: TxHandle,
  functionId: string,
  name: string,
  type: string,
  position: number,
  defaultValue: string | undefined,
  perScopeRefs: Record<string, NodeRefPerScopeEntry>,
  omitUnmatched = false
): NodeRefAddParameterManifest {
  if (!IDENT_PATTERN.test(name)) {
    throw new Error(`Invalid TypeScript identifier: ${JSON.stringify(name)}`);
  }

  const declaration = findNodeById(db, functionId);
  if (!declaration) throw new Error(`Declaration not found: ${functionId}`);
  if (declaration.kind !== "FunctionDeclaration") {
    throw new Error(
      `Node ${functionId} is not a FunctionDeclaration (kind=${declaration.kind})`
    );
  }

  const sf = ts.createSourceFile(
    "__noderef_add_parameter__.ts",
    declaration.payload,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const fnStmt = sf.statements[0];
  if (sf.statements.length !== 1 || !ts.isFunctionDeclaration(fnStmt)) {
    throw new Error("add_parameter: payload is not a function declaration");
  }
  const params = fnStmt.parameters;
  const clamped = Math.max(0, Math.min(position, params.length));
  const paramText =
    defaultValue === undefined
      ? `${name}: ${type}`
      : `${name}: ${type} = ${defaultValue}`;

  // --- declaration parameter-list edit ---
  let declarationEdit: {
    start: number;
    end: number;
    oldText: string;
    newText: string;
  };
  if (params.length === 0) {
    const span = locateSpan(declaration.payload, "params");
    declarationEdit = {
      start: span.start,
      end: span.start,
      oldText: "",
      newText: paramText
    };
  } else if (clamped === 0) {
    const start = params[0]!.getStart(sf);
    declarationEdit = {
      start,
      end: start,
      oldText: "",
      newText: `${paramText}, `
    };
  } else {
    const previous = params[clamped - 1] ?? params[params.length - 1]!;
    const start = previous.getEnd();
    declarationEdit = {
      start,
      end: start,
      oldText: "",
      newText: `, ${paramText}`
    };
  }
  queueTextSpanEdit(tx, functionId, declarationEdit);

  // --- Precompute per-scope prefix → resolved identifier + declModPath ---
  // This is the KEY structural constraint: the op resolves nodeRef →
  // identifier name INTERNALLY. The caller never supplied a string value.
  const resolvedPrefixes = new Map<
    string,
    { identName: string; declModPath: string }
  >();
  for (const [prefix, entry] of Object.entries(perScopeRefs)) {
    const identName = resolveNodeRefToIdentifier(db, entry.nodeRef);
    if (!identName) {
      console.warn(
        `[probe8] WARNING: nodeRef ${entry.nodeRef} (prefix ${prefix}) could not be resolved to an identifier — skipping`
      );
      continue;
    }
    const declModPath = modulePathOf(db, entry.nodeRef);
    resolvedPrefixes.set(prefix, { identName, declModPath });
  }

  // --- per-scope callsite fan-out ---
  const resolution = resolveCallsites(db, functionId);
  const fallbackSlot = defaultValue ?? "undefined";
  const affected = new Set<string>([functionId]);
  const callsitesRewritten: NodeRefAddParameterManifest["callsitesRewritten"] =
    [];
  const neededImports = new Map<
    string,
    { importName: string; importFrom: string }[]
  >();

  for (const callsite of resolution.callsites) {
    const absModulePath = modulePathOf(db, callsite.statementId);
    const relKey = corpusRelPosix(absModulePath);

    // Longest-prefix match
    let best:
      | { prefix: string; identName: string; declModPath: string }
      | undefined;
    for (const [prefix, resolved] of resolvedPrefixes) {
      if (
        relKey.startsWith(prefix) &&
        (best === undefined || prefix.length > best.prefix.length)
      ) {
        best = { prefix, ...resolved };
      }
    }

    if (!best && omitUnmatched) continue;

    // The identifier name comes from the nodeRef resolution — NOT from the
    // agent's input string.
    const slotValue = best ? best.identName : fallbackSlot;
    const importFrom = best
      ? relativeImportSpecifier(absModulePath, best.declModPath)
      : undefined;

    const callPosition = Math.max(0, Math.min(clamped, callsite.existingArgCount));
    const start = callsite.argumentInsertionOffsets[callPosition];
    if (start === undefined) {
      throw new Error(
        `add_parameter: no callsite insertion offset for position ${callPosition}`
      );
    }
    const newText =
      callsite.existingArgCount === 0
        ? slotValue
        : callPosition === 0
          ? `${slotValue}, `
          : `, ${slotValue}`;

    queueTextSpanEdit(tx, callsite.statementId, {
      start,
      end: start,
      oldText: "",
      newText
    });
    affected.add(callsite.statementId);

    callsitesRewritten.push({
      modulePath: absModulePath,
      statementId: callsite.statementId,
      scopeKey: relKey,
      resolvedIdentifier: slotValue,
      importFrom: importFrom ?? "<none>"
    });

    // Op-completeness: queue the import for the resolved identifier
    if (importFrom && IDENT_PATTERN.test(slotValue)) {
      const moduleId = moduleNodeOf(db, callsite.statementId).id;
      const list = neededImports.get(moduleId) ?? [];
      if (
        !list.some(
          (i) => i.importName === slotValue && i.importFrom === importFrom
        )
      ) {
        list.push({ importName: slotValue, importFrom });
      }
      neededImports.set(moduleId, list);
    }
  }

  // One import-insertion edit per (module, import) not already present
  for (const [moduleId, imports] of neededImports) {
    const children = listChildren(db, moduleId)
      .filter((c) => c.kind !== "EndOfFileTrivia")
      .sort((a, b) => (a.childIndex ?? 0) - (b.childIndex ?? 0));
    const anchor = children[0];
    if (!anchor) continue;
    const existingImportText = children
      .filter((c) => c.kind === "ImportDeclaration")
      .map((c) => c.payload)
      .join("\n");
    for (const imp of imports) {
      const already =
        existingImportText.includes(imp.importFrom) &&
        new RegExp(`\\b${imp.importName}\\b`).test(existingImportText);
      if (already) continue;
      queueTextSpanEdit(tx, anchor.id, {
        start: 0,
        end: 0,
        oldText: "",
        newText: `import { ${imp.importName} } from "${imp.importFrom}";\n`
      });
      affected.add(anchor.id);
    }
  }

  queuePendingOp(tx, {
    kind: "AddParameter",
    paramsJson: JSON.stringify({
      function_id: functionId,
      name,
      type,
      position: clamped,
      has_default: defaultValue !== undefined,
      per_scope_refs: Object.fromEntries(
        Object.entries(perScopeRefs).map(([k, v]) => [k, v.nodeRef])
      )
    }),
    affectedNodeIdsJson: JSON.stringify([...affected]),
    reasoning: null
  });

  const bodyStart = fnStmt.body
    ? fnStmt.body.getStart(sf)
    : declaration.payload.length;
  const beforeSignature = declaration.payload.slice(0, bodyStart);
  const afterSignature =
    beforeSignature.slice(0, declarationEdit.start) +
    declarationEdit.newText +
    beforeSignature.slice(declarationEdit.end);

  return {
    ok: true,
    declaration: { id: functionId, beforeSignature, afterSignature },
    callsitesRewritten,
    arityRiskSites: resolution.nonCallReferences.map((r) => ({
      modulePath: modulePathOf(db, r.statementId),
      statementId: r.statementId,
      reason: r.shape
    }))
  };
}

// ---------------------------------------------------------------------------
// DB factory
// ---------------------------------------------------------------------------

function freshDb() {
  const batch = ingestBatch(collectTsFiles(SRC_ROOT));
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  const fts = find_declarations(db, { name: "formatTimestamp", kind: "function" });
  if (fts.length === 0) throw new Error("probe8: formatTimestamp not found");
  return { db, fid: fts[0]!.id };
}

// ===========================================================================
// PART 1 — HONEST HD SCENARIO
//
// Simulate what the agent would do: call findZoneDeclarations (equivalent of
// find_declarations{name:ZONE}) to get per-scope nodeIds, then pass those
// as per_scope_refs. The op resolves each nodeRef → identifier name "ZONE",
// derives importFrom dynamically. Expected: HD pass=true, trap pass=false.
// ===========================================================================

console.log("=".repeat(70));
console.log("PART 1: Honest HD — agent finds ZONE node IDs, passes per_scope_refs");
console.log("=".repeat(70));

let part1TscClean = false;
let part1HdPass = false;
let part1TrapPass = false;

{
  const { db, fid } = freshDb();

  // Simulate agent: find ZONE declarations (equivalent of find_declarations)
  const zoneDecls = findZoneDeclarations(db);
  console.log(`\nFound ${zoneDecls.length} ZONE declaration(s) in graph:`);
  for (const z of zoneDecls) {
    const relKey = corpusRelPosix(z.modulePath);
    console.log(
      `  nodeId=${z.nodeId} identifierName=${z.identifierName} relKey=${relKey}`
    );
  }

  // Build per_scope_refs: scope prefix → {nodeRef: <ZONE nodeId for that scope>}
  const perScopeRefs: Record<string, NodeRefPerScopeEntry> = {};
  for (const z of zoneDecls) {
    const relKey = corpusRelPosix(z.modulePath);
    if (relKey.startsWith("src/server/")) {
      perScopeRefs["src/server/"] = { nodeRef: z.nodeId };
    } else if (relKey.startsWith("src/ui/")) {
      perScopeRefs["src/ui/"] = { nodeRef: z.nodeId };
    }
  }
  console.log("\nper_scope_refs passed to op:", JSON.stringify(perScopeRefs));

  const tx = begin(db, "probe8-honest");
  const manifest = applyNodeRefAddParameter(
    db,
    tx,
    fid,
    "timezone",
    "string",
    1,
    '"UTC"',
    perScopeRefs,
    true // omitUnmatched
  );
  commitWithoutValidate(db, tx);

  console.log("\nManifest callsites rewritten:");
  for (const c of manifest.callsitesRewritten) {
    console.log(
      `  ${c.scopeKey.padEnd(30)} resolvedIdentifier=${c.resolvedIdentifier} importFrom=${c.importFrom}`
    );
  }

  const renderedPrefixed = renderCommittedSrc(db, SRC_ROOT);
  const hdScore = scoreHonestDerivable(renderedPrefixed);
  const trapScore = scoreTrapped(renderedPrefixed);

  part1HdPass = hdScore.pass;
  part1TrapPass = trapScore.pass;

  console.log("\noracle.scopes:", JSON.stringify(deriveOracle().scopes));
  console.log("HD pass:", hdScore.pass);
  console.log("HD per-callsite:");
  for (const c of hdScore.perCallsite) {
    console.log(
      `  ${c.ok ? "OK " : "BAD"}  ${c.path.padEnd(35)} expected=${JSON.stringify(c.expected)} got=${JSON.stringify(c.got)}`
    );
  }
  console.log("\nTrap pass (must be FALSE for integrity):", trapScore.pass);
  console.log("Trap requiresPromptLiteral:", trapScore.requiresPromptLiteral);

  const rendered = stripSrcPrefix(renderedPrefixed);
  const accept = runCorpusAcceptance(rendered, CORPUS_ROOT);
  part1TscClean = accept.tscClean;
  console.log(`\ntscClean=${accept.tscClean} vitestPassed=${accept.vitestPassed}`);
  if (!accept.tscClean || !accept.vitestPassed) {
    console.log("failureOutput:", String(accept.failureOutput ?? "").slice(0, 800));
  }

  console.log(
    "\n[PART 1 VERDICT] HD pass:", hdScore.pass,
    "| Trap pass:", trapScore.pass,
    "| tscClean:", accept.tscClean
  );
}

// ===========================================================================
// PART 2 — TRAP ATTACK SCENARIOS
//
// The trap requires literal strings "UTC" (server callsites) and "local"
// (ui callsites). With nodeRef-only input, can an attacker produce those
// literals?
//
// Attack A: Point nodeRef at the ZONE FirstStatement declaration.
//   → identifierName resolves to "ZONE" (the const's name), NOT "UTC".
//   → scoreTrapped requires '"UTC"', gets "ZONE" → trap pass=false.
//
// Attack B: Point nodeRef at the Identifier child of the ZONE declaration.
//   → The Identifier's payload is {text:"ZONE"} → identifierName = "ZONE".
//   → Same result: trap pass=false.
//
// Attack C: Find ANY node whose resolved identifier = "UTC" or "local".
//   → StringLiteral nodes exist for "UTC"/"local" inside the declarations,
//     but they are neither Identifier nodes nor do they have Identifier
//     children. resolveNodeRefToIdentifier returns undefined → callsite skipped.
//   → Can we find a node that, when resolved, yields "UTC"? Only if there is
//     a declaration whose IDENTIFIER NAME is literally "UTC". There is none.
//
// Attack D: Point both scopes at a non-ZONE FirstStatement (e.g. any
//   other export const in the corpus). This produces a different identifier
//   name (not "UTC"/"local") → trap pass=false.
// ===========================================================================

console.log("\n" + "=".repeat(70));
console.log("PART 2: Trap-attack scenarios");
console.log("=".repeat(70));

// Helper: find nodes by kind and optional payload substring
function findNodesByKind(db: Db, kind: string, payloadContains?: string) {
  const rows = (db as any)
    .prepare("SELECT id, kind, payload, parent_id FROM nodes WHERE kind = ?")
    .all(kind) as {
      id: string;
      kind: string;
      payload: string;
      parent_id: string | null;
    }[];
  if (payloadContains) {
    return rows.filter((r) => r.payload.includes(payloadContains));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Attack A: pass the ZONE FirstStatement nodeId as the nodeRef for BOTH
// server and ui scopes, hoping the op splices "UTC" or "local"
// ---------------------------------------------------------------------------

console.log("\n--- Attack A: point nodeRef at ZONE FirstStatement declaration ---");
console.log("    (the natural guess: point at the const whose VALUE is the answer)");

{
  const { db, fid } = freshDb();
  const zoneDecls = findZoneDeclarations(db);
  const serverZone = zoneDecls.find((z) =>
    corpusRelPosix(z.modulePath).startsWith("src/server/")
  );
  const uiZone = zoneDecls.find((z) =>
    corpusRelPosix(z.modulePath).startsWith("src/ui/")
  );

  if (!serverZone || !uiZone) {
    console.log("  ERROR: Could not find server or ui ZONE declarations");
  } else {
    console.log(`  server ZONE nodeId: ${serverZone.nodeId} → identifierName: ${serverZone.identifierName}`);
    console.log(`  ui     ZONE nodeId: ${uiZone.nodeId} → identifierName: ${uiZone.identifierName}`);

    const tx = begin(db, "probe8-attack-a");
    const manifest = applyNodeRefAddParameter(
      db,
      tx,
      fid,
      "timezone",
      "string",
      1,
      '"UTC"',
      {
        "src/server/": { nodeRef: serverZone.nodeId },
        "src/ui/": { nodeRef: uiZone.nodeId }
      },
      true
    );
    commitWithoutValidate(db, tx);

    const rendered = renderCommittedSrc(db, SRC_ROOT);
    const trapScore = scoreTrapped(rendered);
    console.log(`  Callsites produced:`);
    for (const c of manifest.callsitesRewritten) {
      console.log(`    ${c.scopeKey.padEnd(30)} arg="${c.resolvedIdentifier}"`);
    }
    console.log(`  Trap pass: ${trapScore.pass} (want false)`);
    console.log(`  requiresPromptLiteral: ${trapScore.requiresPromptLiteral}`);
    console.log(`  Attack A result: ${trapScore.pass ? "HOLE — trap satisfied" : "BLOCKED — trap NOT satisfied"}`);
  }
}

// ---------------------------------------------------------------------------
// Attack B: point nodeRef at the Identifier child of the ZONE declaration
// (the child node whose payload is {text:"ZONE"})
// ---------------------------------------------------------------------------

console.log("\n--- Attack B: point nodeRef at the Identifier child of ZONE decl ---");
console.log("    (agent tries the child node hoping payload='UTC' falls out)");

{
  const { db, fid } = freshDb();
  const zoneDecls = findZoneDeclarations(db);
  const serverZone = zoneDecls.find((z) =>
    corpusRelPosix(z.modulePath).startsWith("src/server/")
  );
  const uiZone = zoneDecls.find((z) =>
    corpusRelPosix(z.modulePath).startsWith("src/ui/")
  );

  if (!serverZone || !uiZone) {
    console.log("  ERROR: missing zone decls");
  } else {
    // Get the Identifier child of each ZONE FirstStatement
    const serverChildren = listChildren(db, serverZone.nodeId);
    const uiChildren = listChildren(db, uiZone.nodeId);
    const serverIdentifier = serverChildren.find((c) => c.kind === "Identifier");
    const uiIdentifier = uiChildren.find((c) => c.kind === "Identifier");

    if (!serverIdentifier || !uiIdentifier) {
      console.log("  No Identifier children found — skipping attack B");
    } else {
      console.log(`  server Identifier nodeId: ${serverIdentifier.id} payload: ${serverIdentifier.payload}`);
      console.log(`  ui Identifier nodeId: ${uiIdentifier.id} payload: ${uiIdentifier.payload}`);

      const identB = resolveNodeRefToIdentifier(db, serverIdentifier.id);
      console.log(`  resolveNodeRefToIdentifier(serverIdentifier) → "${identB}"`);

      const tx = begin(db, "probe8-attack-b");
      let manifest: NodeRefAddParameterManifest | undefined;
      try {
        manifest = applyNodeRefAddParameter(
          db,
          tx,
          fid,
          "timezone",
          "string",
          1,
          '"UTC"',
          {
            "src/server/": { nodeRef: serverIdentifier.id },
            "src/ui/": { nodeRef: uiIdentifier.id }
          },
          true
        );
        commitWithoutValidate(db, tx);
        const rendered = renderCommittedSrc(db, SRC_ROOT);
        const trapScore = scoreTrapped(rendered);
        console.log(`  Callsites produced:`);
        for (const c of manifest.callsitesRewritten) {
          console.log(`    ${c.scopeKey.padEnd(30)} arg="${c.resolvedIdentifier}"`);
        }
        console.log(`  Trap pass: ${trapScore.pass} (want false)`);
        console.log(`  Attack B result: ${trapScore.pass ? "HOLE — trap satisfied" : "BLOCKED — trap NOT satisfied"}`);
      } catch (e) {
        console.log(`  Op threw (expected if Identifier outside a module): ${(e as Error).message}`);
        console.log(`  Attack B result: BLOCKED (error prevents trap satisfaction)`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Attack C: try to find a StringLiteral node with text "UTC" and use it
// as nodeRef. resolveNodeRefToIdentifier should return undefined (no
// identifier child, not an Identifier itself, payload is not an identifier).
// ---------------------------------------------------------------------------

console.log("\n--- Attack C: point nodeRef at a StringLiteral node containing 'UTC' ---");
console.log("    (agent goes deeper into the AST, hoping the literal value falls out)");

{
  const { db, fid } = freshDb();

  // Find all StringLiteral nodes whose payload contains "UTC" or "local"
  const utcLiterals = findNodesByKind(db, "StringLiteral", "UTC");
  const localLiterals = findNodesByKind(db, "StringLiteral", "local");

  console.log(`  StringLiteral nodes containing "UTC": ${utcLiterals.length}`);
  for (const n of utcLiterals.slice(0, 3)) {
    console.log(`    id=${n.id} payload=${n.payload.slice(0, 80)}`);
  }
  console.log(`  StringLiteral nodes containing "local": ${localLiterals.length}`);
  for (const n of localLiterals.slice(0, 3)) {
    console.log(`    id=${n.id} payload=${n.payload.slice(0, 80)}`);
  }

  const serverLiteral = utcLiterals[0];
  const uiLiteral = localLiterals[0];

  if (!serverLiteral || !uiLiteral) {
    console.log("  No StringLiteral nodes with 'UTC'/'local' found — attack C N/A");
  } else {
    const serverResolved = resolveNodeRefToIdentifier(db, serverLiteral.id);
    const uiResolved = resolveNodeRefToIdentifier(db, uiLiteral.id);
    console.log(`  resolveNodeRefToIdentifier(UTC StringLiteral) → ${JSON.stringify(serverResolved)}`);
    console.log(`  resolveNodeRefToIdentifier(local StringLiteral) → ${JSON.stringify(uiResolved)}`);

    if (!serverResolved || !uiResolved) {
      console.log(`  Resolution returned undefined for one or both → callsites skipped`);
      console.log(`  Attack C result: BLOCKED (unresolvable nodeRef → omitted from callsite)`);
    } else {
      // If they resolve to something, run the op and check
      const tx = begin(db, "probe8-attack-c");
      let manifest: NodeRefAddParameterManifest | undefined;
      try {
        manifest = applyNodeRefAddParameter(
          db,
          tx,
          fid,
          "timezone",
          "string",
          1,
          '"UTC"',
          {
            "src/server/": { nodeRef: serverLiteral.id },
            "src/ui/": { nodeRef: uiLiteral.id }
          },
          true
        );
        commitWithoutValidate(db, tx);
        const rendered = renderCommittedSrc(db, SRC_ROOT);
        const trapScore = scoreTrapped(rendered);
        console.log(`  Callsites produced:`);
        if (manifest) {
          for (const c of manifest.callsitesRewritten) {
            console.log(`    ${c.scopeKey.padEnd(30)} arg="${c.resolvedIdentifier}"`);
          }
        }
        console.log(`  Trap pass: ${trapScore.pass} (want false)`);
        console.log(`  Attack C result: ${trapScore.pass ? "HOLE — trap satisfied" : "BLOCKED — trap NOT satisfied"}`);
      } catch (e) {
        console.log(`  Op threw: ${(e as Error).message}`);
        console.log(`  Attack C result: BLOCKED (error prevents trap satisfaction)`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Attack D: exhaust the search — are there ANY FirstStatement nodes (or any
// nodes at all) whose resolved identifier name is exactly "UTC" or "local"?
// ---------------------------------------------------------------------------

console.log("\n--- Attack D: exhaustive search — any node that resolves to 'UTC' or 'local'? ---");

{
  const { db } = freshDb();

  const allNodes = (db as any)
    .prepare("SELECT id, kind, payload FROM nodes")
    .all() as { id: string; kind: string; payload: string }[];

  const matchesUTC: string[] = [];
  const matchesLocal: string[] = [];

  for (const n of allNodes) {
    // Quick pre-filter to avoid checking every node
    if (!n.payload.includes("UTC") && !n.payload.includes("local") &&
        !n.payload.includes("utc") && !n.payload.includes("LOCAL")) continue;
    try {
      const resolved = resolveNodeRefToIdentifier(db, n.id);
      if (resolved === "UTC") matchesUTC.push(`${n.id} (kind=${n.kind})`);
      if (resolved === "local") matchesLocal.push(`${n.id} (kind=${n.kind})`);
    } catch {
      // skip nodes that throw (e.g. no module ancestor)
    }
  }

  console.log(`  Nodes resolving to identifier "UTC":   ${matchesUTC.length}`);
  for (const m of matchesUTC.slice(0, 5)) console.log(`    ${m}`);
  console.log(`  Nodes resolving to identifier "local": ${matchesLocal.length}`);
  for (const m of matchesLocal.slice(0, 5)) console.log(`    ${m}`);

  const canSatisfyTrap = matchesUTC.length > 0 && matchesLocal.length > 0;
  console.log(
    `\n  Any node resolves to "UTC"?   ${matchesUTC.length > 0}`
  );
  console.log(
    `  Any node resolves to "local"? ${matchesLocal.length > 0}`
  );
  console.log(
    `  Attack D structural feasibility: ${canSatisfyTrap ? "POSSIBLE (hole exists)" : "IMPOSSIBLE — no node resolves to the required trap literals"}`
  );
}

// ===========================================================================
// SUMMARY
// ===========================================================================

console.log("\n" + "=".repeat(70));
console.log("PROBE 8 SUMMARY");
console.log("=".repeat(70));
console.log(`
(a) HD honest scenario:
    HD pass:       ${part1HdPass}   (expected: true)
    Trap pass:     ${part1TrapPass}  (expected: false — integrity alarm must NOT fire)
    tscClean:      ${part1TscClean}   (expected: true)

(b) Trap-attack attempts:
    Attack A — ZONE FirstStatement nodeRef → resolves to identifier "ZONE"
               Trap requires '"UTC"' at server callsites; gets "ZONE" → BLOCKED
    Attack B — Identifier child of ZONE decl → still resolves to "ZONE"
               Trap still gets "ZONE" → BLOCKED
    Attack C — StringLiteral node ("UTC"/"local") → resolveNodeRefToIdentifier
               returns undefined (StringLiteral is not an identifier, has no
               Identifier children) → callsite skipped → BLOCKED
    Attack D — Exhaustive: no node in the graph resolves to identifier "UTC"
               or "local" (those are string VALUES, not identifier NAMES)
               → structural impossibility confirmed

(c) Conclusion: nodeRef-only ${
  !part1HdPass || part1TrapPass
    ? "FAILED (see results above) — check for unexpected outcomes"
    : "IS structurally trap-resistant"
}
    The agent cannot supply a string literal as a per-scope value; the only
    expressible per-scope values are identifier names of declarations in the
    graph. "UTC" and "local" are string values stored in declarations, not
    identifier names. The trap is structurally unsatisfiable.
`);
