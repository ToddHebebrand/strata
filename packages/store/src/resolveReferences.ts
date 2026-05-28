import ts from "typescript";
import { nodeId } from "./ids";
import type { Reference, ReferenceKind } from "./references";

/**
 * Build a program over the supplied rendered modules and resolve every
 * identifier in each `dirtyModulePaths` module into a Reference edge
 * (use -> declaration-name identifier). Caller supplies rendered text and
 * compiler options so this never imports @strata/render and matches the
 * commit gate's tsconfig. Mirrors the DFS in emitIdentifiers exactly.
 */
export function resolveReferencesForModules(
  renderedByPath: Map<string, string>,
  options: ts.CompilerOptions,
  dirtyModulePaths: readonly string[]
): Reference[] {
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const [path, text] of renderedByPath) {
    sourceFiles.set(
      normalizePath(path),
      ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    );
  }

  const program = createInMemoryProgram(renderedByPath, sourceFiles, options);
  const checker = program.getTypeChecker();
  const references: Reference[] = [];
  const dirty = new Set(dirtyModulePaths.map(normalizePath));

  for (const modulePath of dirty) {
    const sf = sourceFiles.get(modulePath);
    if (sf) visit(sf, modulePath);
  }

  function visit(node: ts.Node, modulePath: string): void {
    if (ts.isIdentifier(node)) tryResolve(node, modulePath);
    const sf = sourceFiles.get(modulePath);
    for (const child of node.getChildren(sf)) visit(child, modulePath);
  }

  function tryResolve(identifier: ts.Identifier, modulePath: string): void {
    let symbol = checker.getSymbolAtLocation(identifier);
    if (!symbol) return;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {
        /* keep alias symbol */
      }
    }
    const declaration = symbol.declarations?.[0];
    if (!declaration) return;
    const declSf = declaration.getSourceFile();
    const declModulePath = normalizePath(declSf.fileName);
    if (!sourceFiles.has(declModulePath)) return;
    const declIdentifier = pickDeclarationIdentifier(declaration);
    if (!declIdentifier) return;
    const sf = sourceFiles.get(modulePath);
    if (!sf) return;
    const fromNodeId = identifierNodeId(identifier, modulePath, sf);
    const toNodeId = identifierNodeId(declIdentifier, declModulePath, declSf);
    if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return;
    references.push({ fromNodeId, toNodeId, kind: classifyReferenceKind(symbol) });
  }

  return references;
}

function createInMemoryProgram(
  renderedByPath: Map<string, string>,
  sourceFiles: Map<string, ts.SourceFile>,
  options: ts.CompilerOptions
): ts.Program {
  const host: ts.CompilerHost = {
    fileExists: (f) => sourceFiles.has(normalizePath(f)),
    readFile: (f) => sourceFiles.get(normalizePath(f))?.getFullText(),
    getSourceFile: (f) => sourceFiles.get(normalizePath(f)),
    getDefaultLibFileName: ts.getDefaultLibFileName,
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (f) => normalizePath(f),
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    directoryExists: () => true,
    getDirectories: () => []
  };
  return ts.createProgram({
    rootNames: [...renderedByPath.keys()],
    options: { ...options, noEmit: true, skipLibCheck: true },
    host
  });
}

function pickDeclarationIdentifier(declaration: ts.Declaration): ts.Identifier | undefined {
  const named = declaration as { name?: ts.Node };
  if (named.name && ts.isIdentifier(named.name)) return named.name;
  return undefined;
}

function classifyReferenceKind(symbol: ts.Symbol): ReferenceKind {
  if (symbol.flags & ts.SymbolFlags.Namespace) return "namespace";
  if (symbol.flags & (ts.SymbolFlags.Type | ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))
    return "type";
  return "value";
}

function identifierNodeId(
  identifier: ts.Identifier,
  modulePath: string,
  sourceFile: ts.SourceFile
): string | undefined {
  let owner: ts.Node = identifier;
  while (owner.parent && owner.parent.kind !== ts.SyntaxKind.SourceFile) owner = owner.parent;
  if (owner.parent?.kind !== ts.SyntaxKind.SourceFile) return undefined;
  const statementIndex = sourceFile.statements.indexOf(owner as ts.Statement);
  if (statementIndex < 0) return undefined;
  let childIndex = -1;
  let found = -1;
  function walk(node: ts.Node): boolean {
    if (ts.isIdentifier(node)) {
      childIndex += 1;
      if (node === identifier) {
        found = childIndex;
        return true;
      }
    }
    for (const child of node.getChildren(sourceFile)) if (walk(child)) return true;
    return false;
  }
  walk(owner);
  if (found < 0) return undefined;
  return nodeId(modulePath, [statementIndex, found], "Identifier");
}

function normalizePath(fileName: string): string {
  return fileName.replaceAll("\\", "/").replace(/^\.\//, "");
}
