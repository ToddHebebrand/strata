import { nodeId, type NodeRow, type Reference, type ReferenceKind } from "@strata/store";
import ts from "typescript";
import { ingest } from "./index";

export interface IngestBatchInput {
  path: string;
  text: string;
}

export interface IngestBatchResult {
  allNodes: NodeRow[];
  references: Reference[];
  modules: { path: string; moduleId: string }[];
}

export function ingestBatch(inputs: IngestBatchInput[]): IngestBatchResult {
  const allNodes: NodeRow[] = [];
  const modules: { path: string; moduleId: string }[] = [];
  const sourceFiles = new Map<string, ts.SourceFile>();

  for (const input of inputs) {
    const sourceFile = ts.createSourceFile(
      input.path,
      input.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    sourceFiles.set(input.path, sourceFile);

    const single = ingest(input.text, input.path);
    allNodes.push(single.module, ...single.children);
    modules.push({ path: input.path, moduleId: single.module.id });
  }

  const program = createInMemoryProgram(inputs, sourceFiles);
  const checker = program.getTypeChecker();
  const references: Reference[] = [];

  for (const input of inputs) {
    const sourceFile = sourceFiles.get(input.path);
    if (sourceFile) {
      visit(sourceFile, input.path);
    }
  }

  // Mirrors identifiers.ts: pre-order DFS over getChildren so JSDoc type
  // references resolve and identifier indices match ingest exactly.
  function visit(node: ts.Node, modulePath: string): void {
    if (ts.isIdentifier(node)) {
      tryResolve(node, modulePath);
    }

    const sf = sourceFiles.get(modulePath);
    for (const child of node.getChildren(sf)) {
      visit(child, modulePath);
    }
  }

  function tryResolve(identifier: ts.Identifier, modulePath: string): void {
    let symbol = checker.getSymbolAtLocation(identifier);
    if (!symbol) {
      return;
    }

    if (symbol.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {
        // Keep the alias symbol when TypeScript cannot resolve it further.
      }
    }

    const declaration = symbol.declarations?.[0];
    if (!declaration) {
      return;
    }

    const declarationSourceFile = declaration.getSourceFile();
    const declarationModulePath = declarationSourceFile.fileName;
    if (!sourceFiles.has(declarationModulePath)) {
      return;
    }

    const declarationIdentifier = pickDeclarationIdentifier(declaration);
    if (!declarationIdentifier) {
      return;
    }

    const sourceFile = sourceFiles.get(modulePath);
    if (!sourceFile) {
      return;
    }

    const fromNodeId = identifierNodeId(identifier, modulePath, sourceFile);
    const toNodeId = identifierNodeId(
      declarationIdentifier,
      declarationModulePath,
      declarationSourceFile
    );
    if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) {
      return;
    }

    references.push({
      fromNodeId,
      toNodeId,
      kind: classifyReferenceKind(symbol)
    });
  }

  return { allNodes, references, modules };
}

function createInMemoryProgram(
  inputs: IngestBatchInput[],
  sourceFiles: Map<string, ts.SourceFile>
): ts.Program {
  const compilerHost: ts.CompilerHost = {
    fileExists: (fileName) => sourceFiles.has(normalizePath(fileName)),
    readFile: (fileName) => sourceFiles.get(normalizePath(fileName))?.getFullText(),
    getSourceFile: (fileName) => sourceFiles.get(normalizePath(fileName)),
    getDefaultLibFileName: ts.getDefaultLibFileName,
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (fileName) => normalizePath(fileName),
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    directoryExists: () => true,
    getDirectories: () => []
  };

  return ts.createProgram({
    rootNames: inputs.map((input) => input.path),
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true
    },
    host: compilerHost
  });
}

function pickDeclarationIdentifier(declaration: ts.Declaration): ts.Identifier | undefined {
  const named = declaration as { name?: ts.Node };
  if (named.name && ts.isIdentifier(named.name)) {
    return named.name;
  }
  return undefined;
}

function classifyReferenceKind(symbol: ts.Symbol): ReferenceKind {
  if (symbol.flags & ts.SymbolFlags.Namespace) {
    return "namespace";
  }

  if (
    symbol.flags &
    (ts.SymbolFlags.Type | ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)
  ) {
    return "type";
  }

  return "value";
}

function identifierNodeId(
  identifier: ts.Identifier,
  modulePath: string,
  sourceFile: ts.SourceFile
): string | undefined {
  let owner: ts.Node = identifier;
  while (owner.parent && owner.parent.kind !== ts.SyntaxKind.SourceFile) {
    owner = owner.parent;
  }

  if (owner.parent?.kind !== ts.SyntaxKind.SourceFile) {
    return undefined;
  }

  const statementIndex = sourceFile.statements.indexOf(owner as ts.Statement);
  if (statementIndex < 0) {
    return undefined;
  }

  let childIndex = -1;
  let found = -1;

  // Same pre-order getChildren DFS as identifiers.ts / the resolver visit,
  // so the Nth identifier here is the Nth identifier at ingest time.
  function visit(node: ts.Node): boolean {
    if (ts.isIdentifier(node)) {
      childIndex += 1;
      if (node === identifier) {
        found = childIndex;
        return true;
      }
    }

    for (const child of node.getChildren(sourceFile)) {
      if (visit(child)) {
        return true;
      }
    }

    return false;
  }

  visit(owner);
  if (found < 0) {
    return undefined;
  }

  return nodeId(modulePath, [statementIndex, found], "Identifier");
}

function normalizePath(fileName: string): string {
  return fileName.replaceAll("\\", "/").replace(/^\.\//, "");
}
