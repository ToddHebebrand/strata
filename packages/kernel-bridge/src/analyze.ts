import { compareCodeUnits, type KernelReferenceV1 } from "@strata/ingest";
import {
  findNodeById,
  getReferencesByTo,
  listModules,
  modulePathOf,
  normalizePath,
  resolveCallsites,
  resolveDeclarationNameIdentifier,
  type Db,
  type NodeRow
} from "@strata/store";
import { posix } from "node:path";
import ts from "typescript";
import {
  semanticFactsSchema,
  type AnalyzeIntentRequest,
  type BridgeDiagnostic,
  type BridgeErrorPayload,
  type IntentRecord,
  type SemanticFacts
} from "./protocol";
import { hydrateSnapshot } from "./snapshot";

const MAX_DIAGNOSTIC_MESSAGE_CODE_UNITS = 1_000;

export interface AnalyzeIntentSuccess {
  facts: SemanticFacts;
}

export type AnalyzeIntentResult = AnalyzeIntentSuccess | BridgeErrorPayload;

interface GraphIndex {
  nodes: NodeRow[];
  references: KernelReferenceV1[];
  nodeById: Map<string, NodeRow>;
  moduleIdByNodeId: Map<string, string>;
  moduleIdByPath: Map<string, string>;
}

class AnalyzeFailure extends Error {
  constructor(
    readonly code: string,
    readonly diagnostics: BridgeDiagnostic[],
    message: string
  ) {
    super(message);
  }
}

export function analyzeIntent(request: AnalyzeIntentRequest): AnalyzeIntentResult {
  let db: Db;
  try {
    db = hydrateSnapshot(request.snapshot);
  } catch (error) {
    return errorPayload("hydrate", "invalidSnapshot", error, []);
  }

  try {
    return analyzeIntentInDb(db, request.intent);
  } finally {
    db.close();
  }
}

/**
 * Analyze a hydrated scratch graph. Exported so corruption tests can exercise
 * fail-closed semantic behavior without weakening the canonical snapshot schema.
 */
export function analyzeIntentInDb(
  db: Db,
  intent: IntentRecord
): AnalyzeIntentResult {
  try {
    const facts =
      intent.parameters.type === "renameSymbol"
        ? analyzeRename(db, intent.parameters.declarationId)
        : analyzeAddParameter(
            db,
            intent.parameters.functionId,
            intent.parameters.typeText,
            intent.parameters.defaultValue
          );
    return { facts: semanticFactsSchema.parse(facts) };
  } catch (error) {
    if (error instanceof AnalyzeFailure) {
      return errorPayload(
        "analyze",
        error.code,
        error,
        canonicalDiagnostics(error.diagnostics)
      );
    }
    return errorPayload("analyze", "semanticAnalysisFailed", error, []);
  }
}

function analyzeRename(db: Db, declarationId: string): SemanticFacts {
  const declaration = requireNode(db, declarationId, "declaration");
  const name = requireDeclarationName(db, declarationId);
  const references = canonicalReferences(getReferencesByTo(db, name.id));
  const unresolved = references.flatMap((reference) =>
    unresolvedReferenceDiagnostic(db, reference)
  );
  if (unresolved.length > 0) {
    throw new AnalyzeFailure(
      "unresolvedReference",
      unresolved,
      "semantic analysis found an unresolved reference"
    );
  }

  const writableStatementIds = canonicalIds([
    declaration.id,
    ...references.map((reference) => findNodeById(db, reference.fromNodeId)!.parentId!)
  ]);
  const validation = validationDependencies(db, [
    declaration.id,
    name.id,
    ...references.flatMap((reference) => [
      reference.fromNodeId,
      reference.toNodeId,
      findNodeById(db, reference.fromNodeId)!.parentId!
    ])
  ]);

  return {
    type: "renameSymbol",
    declarationId: declaration.id,
    declarationNameIdentifierId: name.id,
    references,
    writableStatementIds,
    ...validation
  };
}

function analyzeAddParameter(
  db: Db,
  functionId: string,
  typeText: string,
  defaultValue: string | null
): SemanticFacts {
  const declaration = requireNode(
    db,
    functionId,
    "function",
    "FunctionDeclaration"
  );
  const name = requireDeclarationName(db, functionId);
  const resolution = resolveCallsites(db, functionId);
  if (resolution.unresolvedReferences.length > 0) {
    throw new AnalyzeFailure(
      "unresolvedReference",
      resolution.unresolvedReferences.map((unresolved) => ({
        nodeId: unresolved.referenceNodeId,
        modulePath: safeModulePath(db, unresolved.referenceNodeId),
        message: normalizeDiagnosticMessage(unresolved.reason),
        code: 2304
      })),
      "semantic analysis found an unresolved reference"
    );
  }

  const incoming = canonicalReferences(getReferencesByTo(db, name.id));
  const callReferenceIds = new Set(
    resolution.callsites.map((callsite) => callsite.referenceNodeId)
  );
  const arityRiskStatementIds = canonicalIds(
    resolution.nonCallReferences.map((reference) => reference.statementId)
  );
  const arityRiskStatements = new Set(arityRiskStatementIds);
  const directCallReferences = incoming.filter((reference) =>
    callReferenceIds.has(reference.fromNodeId)
  );
  const arityRiskReferences = incoming.filter((reference) => {
    const source = findNodeById(db, reference.fromNodeId);
    return (
      source !== undefined &&
      source.parentId !== null &&
      !callReferenceIds.has(reference.fromNodeId) &&
      arityRiskStatements.has(source.parentId)
    );
  });
  const functionBodyReadReferences = canonicalReferences(
    allReferences(db).filter((reference) => {
      const source = findNodeById(db, reference.fromNodeId);
      return source?.parentId === functionId;
    })
  );
  const writableStatementIds = canonicalIds([
    declaration.id,
    ...resolution.callsites.map((callsite) => callsite.statementId)
  ]);
  const contentDependencyDeclarationIds = resolveContentDependencies(
    db,
    functionId,
    typeText,
    defaultValue
  );
  const validation = validationDependencies(db, [
    ...contentDependencyDeclarationIds,
    declaration.id,
    name.id,
    ...directCallReferences.flatMap((reference) => [
      reference.fromNodeId,
      reference.toNodeId
    ]),
    ...writableStatementIds,
    ...arityRiskReferences.flatMap((reference) => [
      reference.fromNodeId,
      reference.toNodeId
    ]),
    ...arityRiskStatementIds,
    ...functionBodyReadReferences.flatMap((reference) => [
      reference.fromNodeId,
      reference.toNodeId
    ])
  ]);

  return {
    type: "addParameter",
    functionId: declaration.id,
    declarationNameIdentifierId: name.id,
    directCallReferences,
    writableStatementIds,
    arityRiskReferences,
    arityRiskStatementIds,
    unresolvedReferenceDiagnostics: [],
    functionBodyReadReferences,
    contentDependencyDeclarationIds,
    ...validation
  };
}

interface ContentName {
  root: string;
  member?: string;
}

/**
 * Names the module-level declarations an addParameter's typeText and
 * defaultValue will reference once executed, resolved purely against the
 * graph (spec 2026-07-17 Changes 2/2a). Bare identifiers resolve in the
 * function's own module and through named imports; single-member namespace
 * accesses resolve through namespace imports. Every same-named declaration
 * is pinned (interface merging, overloads). Unresolvable names contribute
 * nothing — the candidate build's tsc validation is the fail-closed
 * backstop, and a fresh-decision response could not name a symbol that
 * never existed in the graph.
 */
function resolveContentDependencies(
  db: Db,
  functionId: string,
  typeText: string,
  defaultValue: string | null
): string[] {
  const names = collectContentNames(typeText, defaultValue);
  if (names.length === 0) return [];
  const graph = buildGraphIndex(db);
  const moduleId = graph.moduleIdByNodeId.get(functionId);
  if (!moduleId) return [];

  const statementsOf = (owner: string): NodeRow[] =>
    graph.nodes.filter((node) => node.parentId === owner);
  const declarationsNamed = (owner: string, name: string): string[] =>
    statementsOf(owner)
      .filter((statement) => {
        const identifier = resolveDeclarationNameIdentifier(db, statement.id);
        if (!identifier) return false;
        try {
          return (JSON.parse(identifier.payload) as { text: string }).text === name;
        } catch {
          return false;
        }
      })
      .map((statement) => statement.id);

  const importerPath = normalizePath(
    graph.nodeById.get(moduleId)?.payload ?? ""
  );
  const resolveSpecifier = (specifier: string): string | undefined => {
    if (!specifier.startsWith(".")) return undefined;
    const base = posix.normalize(posix.join(posix.dirname(importerPath), specifier));
    for (const candidate of [
      base,
      base.replace(/\.js$/, ".ts"),
      `${base}.ts`,
      posix.join(base, "index.ts")
    ]) {
      const target = graph.moduleIdByPath.get(normalizePath(candidate));
      if (target) return target;
    }
    return undefined;
  };

  // root binding → target module and exported name (null = namespace import,
  // resolved per member at the use site).
  const importBindings = new Map<
    string,
    { targetModuleId: string; exportedName: string | null }
  >();
  for (const statement of statementsOf(moduleId)) {
    if (statement.kind !== "ImportDeclaration") continue;
    const file = ts.createSourceFile(
      "import.ts",
      statement.payload,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const parsed = file.statements[0];
    if (
      !parsed ||
      !ts.isImportDeclaration(parsed) ||
      !ts.isStringLiteralLike(parsed.moduleSpecifier)
    ) {
      continue;
    }
    const targetModuleId = resolveSpecifier(parsed.moduleSpecifier.text);
    if (!targetModuleId || !parsed.importClause) continue;
    const bindings = parsed.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      importBindings.set(bindings.name.text, { targetModuleId, exportedName: null });
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        importBindings.set(element.name.text, {
          targetModuleId,
          exportedName: (element.propertyName ?? element.name).text
        });
      }
    }
  }

  const pinned = new Set<string>();
  for (const { root, member } of names) {
    for (const id of declarationsNamed(moduleId, root)) pinned.add(id);
    const binding = importBindings.get(root);
    if (!binding) continue;
    const exported = binding.exportedName ?? member;
    if (!exported) continue;
    for (const id of declarationsNamed(binding.targetModuleId, exported)) {
      pinned.add(id);
    }
  }
  return canonicalIds([...pinned]);
}

function collectContentNames(
  typeText: string,
  defaultValue: string | null
): ContentName[] {
  const names: ContentName[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ts.isIdentifier(node.name)
    ) {
      names.push({ root: node.expression.text, member: node.name.text });
      return;
    }
    if (ts.isQualifiedName(node) && ts.isIdentifier(node.left)) {
      names.push({ root: node.left.text, member: node.right.text });
      return;
    }
    if (ts.isIdentifier(node)) {
      names.push({ root: node.text });
      return;
    }
    node.forEachChild(visit);
  };
  const parse = (text: string): void => {
    const file = ts.createSourceFile(
      "content.ts",
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    file.statements.forEach(visit);
  };
  parse(`type __ContentProbe = ${typeText};`);
  if (defaultValue !== null) parse(`const __contentProbe = (${defaultValue});`);
  // The probe wrappers' own binding names never resolve to module-level
  // declarations, so they need no special-casing.
  return names;
}

/**
 * The validation circle is statement-granular (spec 2026-07-17 Change 1):
 * each seed pins its enclosing module-level statement plus that statement's
 * full descendant subtree, and the references leaving those nodes. Within
 * the current intent vocabulary (renameSymbol, addParameter), any change
 * that alters the resolution of a name one of these statements uses rewrites
 * the statement itself (reference propagation covers imports too), so no
 * module closure or import/export-surface pin is required; intents that
 * would break that property must extend validation pinning first
 * (decisions.md 2026-07-17).
 */
function validationDependencies(
  db: Db,
  seedNodeIds: readonly string[]
): Pick<
  Extract<SemanticFacts, { type: "renameSymbol" }>,
  "validationDependencyNodeIds" | "validationDependencyReferenceFromNodeIds"
> {
  const graph = buildGraphIndex(db);
  const childrenByParent = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.parentId === null) continue;
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node.id);
    childrenByParent.set(node.parentId, siblings);
  }

  const pinned = new Set<string>();
  for (const nodeId of seedNodeIds) {
    let current = graph.nodeById.get(nodeId);
    if (!current || !graph.moduleIdByNodeId.get(nodeId)) {
      throw new AnalyzeFailure(
        "unresolvedReference",
        [{ nodeId, modulePath: null, message: "node has no module", code: 2304 }],
        "semantic analysis found an unresolved reference"
      );
    }
    while (
      current.parentId !== null &&
      graph.nodeById.get(current.parentId)?.kind !== "Module"
    ) {
      current = graph.nodeById.get(current.parentId)!;
    }
    const stack = [current.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (pinned.has(id)) continue;
      pinned.add(id);
      for (const child of childrenByParent.get(id) ?? []) stack.push(child);
    }
  }

  const validationDependencyNodeIds = canonicalIds([...pinned]);
  const selectedNodes = new Set(validationDependencyNodeIds);
  const validationDependencyReferenceFromNodeIds = canonicalIds(
    graph.references
      .filter((reference) => selectedNodes.has(reference.fromNodeId))
      .map((reference) => reference.fromNodeId)
  );

  return {
    validationDependencyNodeIds,
    validationDependencyReferenceFromNodeIds
  };
}

function buildGraphIndex(db: Db): GraphIndex {
  const nodes = allNodes(db);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const moduleIdByNodeId = new Map<string, string>();
  const moduleIdByPath = new Map<string, string>();
  for (const module of listModules(db)) {
    moduleIdByPath.set(normalizePath(module.payload), module.id);
  }

  const resolveModuleId = (nodeId: string): string | undefined => {
    const cached = moduleIdByNodeId.get(nodeId);
    if (cached) return cached;
    let current = nodeById.get(nodeId);
    const visited: string[] = [];
    const seen = new Set<string>();
    while (current && current.kind !== "Module") {
      if (seen.has(current.id) || current.parentId === null) return undefined;
      seen.add(current.id);
      visited.push(current.id);
      current = nodeById.get(current.parentId);
    }
    if (!current) return undefined;
    moduleIdByNodeId.set(current.id, current.id);
    for (const visitedId of visited) moduleIdByNodeId.set(visitedId, current.id);
    return current.id;
  };
  for (const node of nodes) resolveModuleId(node.id);

  return {
    nodes,
    references: allReferences(db),
    nodeById,
    moduleIdByNodeId,
    moduleIdByPath
  };
}

function allNodes(db: Db): NodeRow[] {
  return (db
    .prepare(
      `SELECT id, kind, parent_id AS parentId, child_index AS childIndex, payload
       FROM nodes`
    )
    .all() as NodeRow[]).sort((a, b) => compareCodeUnits(a.id, b.id));
}

function allReferences(db: Db): KernelReferenceV1[] {
  return canonicalReferences(
    db
      .prepare(
        `SELECT from_node_id AS fromNodeId, to_node_id AS toNodeId, kind
         FROM node_references`
      )
      .all() as KernelReferenceV1[]
  );
}

function unresolvedReferenceDiagnostic(
  db: Db,
  reference: KernelReferenceV1
): BridgeDiagnostic[] {
  const source = findNodeById(db, reference.fromNodeId);
  if (!source) {
    return [{
      nodeId: reference.fromNodeId,
      modulePath: null,
      message: "missing-reference-node",
      code: 2304
    }];
  }
  if (!source.parentId || !findNodeById(db, source.parentId)) {
    return [{
      nodeId: reference.fromNodeId,
      modulePath: safeModulePath(db, reference.fromNodeId),
      message: "missing-statement",
      code: 2304
    }];
  }
  return [];
}

function requireNode(
  db: Db,
  nodeId: string,
  label: string,
  expectedKind?: string
): NodeRow {
  const node = findNodeById(db, nodeId);
  if (!node) {
    throw new AnalyzeFailure(
      "invalidIntentTarget",
      [{ nodeId, modulePath: null, message: `${label} not found`, code: 2304 }],
      `${label} not found`
    );
  }
  if (expectedKind !== undefined && node.kind !== expectedKind) {
    throw new AnalyzeFailure(
      "invalidIntentTarget",
      [{
        nodeId,
        modulePath: safeModulePath(db, nodeId),
        message: `${label} must be a ${expectedKind} (kind=${node.kind})`,
        code: 2304
      }],
      `${label} must be a ${expectedKind}`
    );
  }
  return node;
}

function requireDeclarationName(db: Db, declarationId: string): NodeRow {
  const name = resolveDeclarationNameIdentifier(db, declarationId);
  if (!name) {
    throw new AnalyzeFailure(
      "invalidIntentTarget",
      [{
        nodeId: declarationId,
        modulePath: safeModulePath(db, declarationId),
        message: "declaration has no name identifier",
        code: 2304
      }],
      "declaration has no name identifier"
    );
  }
  return name;
}

function safeModulePath(db: Db, nodeId: string): string | null {
  try {
    return modulePathOf(db, nodeId);
  } catch {
    return null;
  }
}

function canonicalIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function canonicalReferences(
  values: readonly KernelReferenceV1[]
): KernelReferenceV1[] {
  const keyed = new Map<string, KernelReferenceV1>();
  for (const value of values) {
    const reference: KernelReferenceV1 = {
      fromNodeId: value.fromNodeId,
      toNodeId: value.toNodeId,
      kind: value.kind
    };
    keyed.set(
      `${reference.fromNodeId}\u0000${reference.toNodeId}\u0000${reference.kind}`,
      reference
    );
  }
  return [...keyed.values()].sort(
    (a, b) =>
      compareCodeUnits(a.fromNodeId, b.fromNodeId) ||
      compareCodeUnits(a.toNodeId, b.toNodeId) ||
      compareCodeUnits(a.kind, b.kind)
  );
}

function canonicalDiagnostics(
  values: readonly BridgeDiagnostic[]
): BridgeDiagnostic[] {
  const keyed = new Map<string, BridgeDiagnostic>();
  for (const value of values) {
    const diagnostic = {
      ...value,
      message: normalizeDiagnosticMessage(value.message)
    };
    keyed.set(JSON.stringify(diagnostic), diagnostic);
  }
  return [...keyed.values()].sort((a, b) =>
    compareCodeUnits(a.nodeId ?? "", b.nodeId ?? "") ||
    compareCodeUnits(a.modulePath ?? "", b.modulePath ?? "") ||
    a.code - b.code ||
    compareCodeUnits(a.message, b.message)
  );
}

function normalizeDiagnosticMessage(message: string): string {
  return message
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_MESSAGE_CODE_UNITS);
}

function errorPayload(
  stage: BridgeErrorPayload["stage"],
  code: string,
  error: unknown,
  diagnostics: BridgeDiagnostic[]
): BridgeErrorPayload {
  return {
    stage,
    code,
    message: normalizeDiagnosticMessage(
      error instanceof Error ? error.message : String(error)
    ),
    diagnostics
  };
}
