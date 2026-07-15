import { compareCodeUnits, type KernelReferenceV1 } from "@strata/ingest";
import {
  begin,
  createInMemoryProgram,
  findNodeById,
  getReferencesByTo,
  listModules,
  modulePathOf,
  normalizePath,
  resolveCallsites,
  resolveDeclarationNameIdentifier,
  rollback,
  type Db,
  type NodeRow
} from "@strata/store";
import { buildAnalysisContext } from "@strata/verify";
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
        : analyzeAddParameter(db, intent.parameters.functionId);
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

function analyzeAddParameter(db: Db, functionId: string): SemanticFacts {
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
  const validation = validationDependencies(db, [
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
    ...validation
  };
}

function validationDependencies(
  db: Db,
  seedNodeIds: readonly string[]
): Pick<
  Extract<SemanticFacts, { type: "renameSymbol" }>,
  "validationDependencyNodeIds" | "validationDependencyReferenceFromNodeIds"
> {
  const graph = buildGraphIndex(db);
  const selectedModuleIds = new Set<string>();
  for (const nodeId of seedNodeIds) {
    const moduleId = graph.moduleIdByNodeId.get(nodeId);
    if (!moduleId) {
      throw new AnalyzeFailure(
        "unresolvedReference",
        [{ nodeId, modulePath: null, message: "node has no module", code: 2304 }],
        "semantic analysis found an unresolved reference"
      );
    }
    selectedModuleIds.add(moduleId);
  }

  const graphDependencies = new Map<string, Set<string>>();
  for (const reference of graph.references) {
    const sourceModule = graph.moduleIdByNodeId.get(reference.fromNodeId);
    const targetModule = graph.moduleIdByNodeId.get(reference.toNodeId);
    if (!sourceModule || !targetModule || sourceModule === targetModule) continue;
    addDependency(graphDependencies, sourceModule, targetModule);
  }
  const programDependencies = buildProgramDependencies(db, graph.moduleIdByPath);
  for (const [source, targets] of programDependencies) {
    for (const target of targets) addDependency(graphDependencies, source, target);
  }

  const queue = [...selectedModuleIds].sort(compareCodeUnits);
  for (let index = 0; index < queue.length; index += 1) {
    const moduleId = queue[index]!;
    const dependencies = [...(graphDependencies.get(moduleId) ?? [])].sort(
      compareCodeUnits
    );
    for (const dependency of dependencies) {
      if (selectedModuleIds.has(dependency)) continue;
      selectedModuleIds.add(dependency);
      queue.push(dependency);
    }
  }

  const validationDependencyNodeIds = canonicalIds(
    graph.nodes
      .filter((node) => selectedModuleIds.has(graph.moduleIdByNodeId.get(node.id)!))
      .map((node) => node.id)
  );
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

function buildProgramDependencies(
  db: Db,
  moduleIdByPath: Map<string, string>
): Map<string, Set<string>> {
  const tx = begin(db, "kernel-bridge-analysis");
  let renderedByPath: Map<string, string>;
  let options: ts.CompilerOptions;
  try {
    ({ renderedByPath, options } = buildAnalysisContext(db, tx));
  } finally {
    rollback(db, tx);
  }

  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const [modulePath, text] of renderedByPath) {
    sourceFiles.set(
      normalizePath(modulePath),
      ts.createSourceFile(
        modulePath,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      )
    );
  }
  const program = createInMemoryProgram(renderedByPath, sourceFiles, options);
  const checker = program.getTypeChecker();
  const dependencies = new Map<string, Set<string>>();

  for (const sourceFile of sourceFiles.values()) {
    const sourceModuleId = moduleIdByPath.get(normalizePath(sourceFile.fileName));
    if (!sourceModuleId) continue;
    for (const statement of sourceFile.statements) {
      const specifier = moduleSpecifierOf(statement);
      if (!specifier) continue;
      const symbol = checker.getSymbolAtLocation(specifier);
      for (const declaration of symbol?.declarations ?? []) {
        const targetPath = normalizePath(declaration.getSourceFile().fileName);
        const targetModuleId = moduleIdByPath.get(targetPath);
        if (targetModuleId && targetModuleId !== sourceModuleId) {
          addDependency(dependencies, sourceModuleId, targetModuleId);
        }
      }
    }
  }
  return dependencies;
}

function moduleSpecifierOf(statement: ts.Statement): ts.StringLiteralLike | undefined {
  if (
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier &&
    ts.isStringLiteralLike(statement.moduleSpecifier)
  ) {
    return statement.moduleSpecifier;
  }
  if (
    ts.isImportEqualsDeclaration(statement) &&
    ts.isExternalModuleReference(statement.moduleReference) &&
    statement.moduleReference.expression &&
    ts.isStringLiteralLike(statement.moduleReference.expression)
  ) {
    return statement.moduleReference.expression;
  }
  return undefined;
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

function addDependency(
  dependencies: Map<string, Set<string>>,
  source: string,
  target: string
): void {
  const targets = dependencies.get(source) ?? new Set<string>();
  targets.add(target);
  dependencies.set(source, targets);
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
