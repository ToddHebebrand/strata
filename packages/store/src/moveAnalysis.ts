import ts from "typescript";
import path from "node:path";
import { createInMemoryProgram, normalizePath } from "./resolveReferences";

export interface MoveInput {
  sourcePath: string;
  declChildIndex: number;
  name: string;
  targetPath: string;
}

export interface ImporterRewrite {
  importerPath: string;
  /** child index of the importer's ImportDeclaration statement in its module. */
  importStatementIndex: number;
  style: "path-rewrite" | "split-out";
  /** path-rewrite: the original quoted specifier text to replace. */
  oldSpecifier?: string;
  /** path-rewrite: the replacement quoted specifier text. */
  newSpecifier?: string;
  /** split-out: the symbol name to remove from this import's binding list. */
  removeName?: string;
  /** split-out: a new `import { X } from "<target>"` statement to append to the importer. */
  newImportText?: string;
}

export interface MovePlan {
  ok: true;
  name: string;
  declKind: string;
  declPayload: string;
  /** child index of the source declaration's statement in the source module. */
  sourceChildIndex: number;
  importerRewrites: ImporterRewrite[];
  sourceStillUses: boolean;
}

export interface MoveRejection {
  ok: false;
  reason: string;
}

export type MoveResult = MovePlan | MoveRejection;

function reject(reason: string): MoveRejection {
  return { ok: false, reason };
}

function buildProgram(rendered: Map<string, string>, options: ts.CompilerOptions) {
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const [p, text] of rendered) {
    sourceFiles.set(
      normalizePath(p),
      ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    );
  }
  const program = createInMemoryProgram(rendered, sourceFiles, options);
  return { program, checker: program.getTypeChecker(), sourceFiles };
}

/** The declaration's name identifier node, for symbol resolution. Covers all 5 movable kinds. */
function declNameNode(stmt: ts.Statement): ts.Node | undefined {
  if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) ||
       ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) && stmt.name) {
    return stmt.name;
  }
  if (ts.isVariableStatement(stmt)) {
    const d = stmt.declarationList.declarations[0];
    if (d && ts.isIdentifier(d.name)) return d.name;
  }
  return undefined;
}

function declName(stmt: ts.Statement): string | undefined {
  const n = declNameNode(stmt);
  return n && ts.isIdentifier(n) ? n.text : undefined;
}

function isExported(stmt: ts.Statement): boolean {
  const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

/**
 * The declaration is self-contained iff every identifier in its subtree
 * resolves to: its own internals (decl inside the statement span), a global/lib
 * symbol (no rendered declaration), or a symbol declared in the TARGET module
 * (in scope after the move). Any other rendered-module declaration (source-local
 * or imported) means it depends on context that won't move with it → reject.
 */
function findOutOfScopeDependency(
  checker: ts.TypeChecker,
  srcSf: ts.SourceFile,
  tgtSf: ts.SourceFile,
  stmt: ts.Statement
): string | null {
  const spanStart = stmt.getStart(srcSf);
  const spanEnd = stmt.getEnd();
  let bad: string | null = null;
  const walk = (node: ts.Node): void => {
    if (bad) return;
    if (ts.isIdentifier(node)) {
      let sym = checker.getSymbolAtLocation(node);
      // An imported usage resolves to the local ImportSpecifier (an alias) in the
      // SOURCE module. Follow the alias to the original declaration so a symbol
      // whose real home is the TARGET module reads as in-scope-after-move.
      if (sym && sym.flags & ts.SymbolFlags.Alias) {
        try {
          sym = checker.getAliasedSymbol(sym);
        } catch {
          /* keep alias symbol */
        }
      }
      const decl = sym?.declarations?.[0];
      if (decl) {
        const declSf = decl.getSourceFile();
        const inLib = declSf.isDeclarationFile; // .d.ts / lib
        const inOwnSpan = declSf === srcSf && decl.getStart(declSf) >= spanStart && decl.getEnd() <= spanEnd;
        const inTarget = declSf === tgtSf;
        const inRendered = !inLib;
        if (inRendered && !inOwnSpan && !inTarget) {
          bad = sym!.getName();
          return;
        }
      }
    }
    node.forEachChild(walk);
  };
  walk(stmt);
  return bad;
}

/**
 * Relative import path from importer to target. Preserves whether the importer
 * used a file extension at all (v1 assumes .ts targets; it does not translate a
 * .js-style specifier back to .js).
 */
function rewrittenSpecifier(importerPath: string, targetPath: string, originalSpecifier: string): string {
  const fromDir = path.dirname(normalizePath(importerPath));
  let rel = normalizePath(path.relative(fromDir, normalizePath(targetPath)));
  if (!rel.startsWith(".")) rel = `./${rel}`;
  const hadExt = /\.(ts|tsx|js|mjs)$/.exec(originalSpecifier);
  if (!hadExt) rel = rel.replace(/\.(ts|tsx|js|mjs)$/, "");
  return rel;
}

/** True if the source module still references `name` after the moved decl is removed. */
function sourceUsesSymbol(checker: ts.TypeChecker, srcSf: ts.SourceFile, declStmt: ts.Statement, name: string): boolean {
  const nameNode = declNameNode(declStmt);
  const declSym = nameNode ? checker.getSymbolAtLocation(nameNode) : undefined;
  let used = false;
  for (const stmt of srcSf.statements) {
    if (stmt === declStmt || ts.isImportDeclaration(stmt)) continue;
    const walk = (n: ts.Node): void => {
      if (used) return;
      if (ts.isIdentifier(n) && n.text === name && checker.getSymbolAtLocation(n) === declSym) { used = true; return; }
      n.forEachChild(walk);
    };
    walk(stmt);
  }
  return used;
}

/** Resolve a relative import specifier from an importer file to a normalized module key. */
function resolveSpecifier(importerPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null; // bare/package — not our source
  const dir = path.dirname(normalizePath(importerPath));
  const joined = normalizePath(path.join(dir, specifier));
  return joined; // compared against source key (both may carry/omit extension; see caller)
}

/** True if two module keys refer to the same file, ignoring a .ts/.tsx/.js/.mjs extension. */
function sameModule(a: string, b: string): boolean {
  const strip = (p: string) => p.replace(/\.(ts|tsx|js|mjs)$/, "");
  return strip(a) === strip(b);
}

/**
 * A dynamic import call: `import("<specifier>")`. This is a CallExpression whose
 * expression is the `import` keyword (NOT an ImportDeclaration), with a
 * string-literal first argument. These can appear anywhere in a module, so they
 * must be found via a full recursive AST walk, not just over top-level statements.
 */
function isDynamicImportCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length >= 1 &&
    ts.isStringLiteral(node.arguments[0]!)
  );
}

interface ImporterHit {
  importerPath: string;
  sf: ts.SourceFile;
  importDecl: ts.ImportDeclaration;
  /** index of this ImportDeclaration among the module's top-level statements. */
  statementIndex: number;
  /** the named bindings in this import (text of each specifier name). */
  bindingNames: string[];
}

/** Find/validate importers of `name` from `srcKey`. Returns hits or a rejection reason. */
function collectImporters(
  sourceFiles: Map<string, ts.SourceFile>,
  srcKey: string,
  name: string
): { hits: ImporterHit[] } | { reason: string } {
  const hits: ImporterHit[] = [];
  for (const [importerKey, sf] of sourceFiles) {
    if (sameModule(importerKey, srcKey)) continue; // skip the source module itself
    // Reject any module that dynamically imports the SOURCE module. v1 only
    // statically rewrites named ImportDeclarations; a `await import("./src")`
    // object's `.X` access can't be statically tracked (same limitation as a
    // namespace import), so refuse loudly rather than commit a broken consumer.
    let dynamicReason: string | null = null;
    const walkDynamic = (node: ts.Node): void => {
      if (dynamicReason) return;
      if (isDynamicImportCall(node)) {
        const spec = (node.arguments[0] as ts.StringLiteral).text;
        const resolved = resolveSpecifier(importerKey, spec);
        if (resolved && sameModule(resolved, srcKey)) {
          dynamicReason = `move: ${importerKey} dynamically imports the source module (import("${spec}")); v1 cannot statically rewrite dynamic imports, so it handles static named imports only`;
          return;
        }
      }
      node.forEachChild(walkDynamic);
    };
    walkDynamic(sf);
    if (dynamicReason) return { reason: dynamicReason };
    for (let i = 0; i < sf.statements.length; i++) {
      const stmt = sf.statements[i]!;
      // Re-export: export { X } from "./src"
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const resolved = resolveSpecifier(importerKey, stmt.moduleSpecifier.text);
        if (resolved && sameModule(resolved, srcKey) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)
            && stmt.exportClause.elements.some((e) => e.name.text === name)) {
          return { reason: `move: ${importerKey} re-exports ${name} (export { ${name} } from ...); v1 does not rewrite re-exports` };
        }
        continue;
      }
      if (!ts.isImportDeclaration(stmt) || !stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const resolved = resolveSpecifier(importerKey, stmt.moduleSpecifier.text);
      if (!resolved || !sameModule(resolved, srcKey)) continue;
      const clause = stmt.importClause;
      if (!clause) continue; // side-effect import — doesn't bind the symbol
      // default import of the symbol
      if (clause.name && clause.name.text === name) {
        return { reason: `move: ${importerKey} imports ${name} as a default import; v1 handles named imports only` };
      }
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        // import * as A — can't tell statically whether A.name is used; reject conservatively
        return { reason: `move: ${importerKey} uses a namespace import (import * as ${bindings.name.text}); v1 handles named imports only` };
      }
      if (bindings && ts.isNamedImports(bindings)) {
        const names = bindings.elements.map((e) => e.name.text);
        if (names.includes(name)) {
          hits.push({ importerPath: importerKey, sf, importDecl: stmt, statementIndex: i, bindingNames: names });
        }
      }
    }
  }
  return { hits };
}

/**
 * Analyze a candidate move. Pure: builds a program over the rendered set, no DB.
 * Importer classification + rewrite computation arrive in Tasks 4-5; this handles
 * location, exported, target-collision, and self-contained verification checks.
 */
export function analyzeMove(
  rendered: Map<string, string>,
  options: ts.CompilerOptions,
  input: MoveInput
): MoveResult {
  const { checker, sourceFiles } = buildProgram(rendered, options);
  const srcSf = sourceFiles.get(normalizePath(path.resolve(input.sourcePath)))
    ?? sourceFiles.get(normalizePath(input.sourcePath));
  if (!srcSf) return reject(`move: source module not found in rendered set: ${input.sourcePath}`);
  const tgtSf = sourceFiles.get(normalizePath(path.resolve(input.targetPath)))
    ?? sourceFiles.get(normalizePath(input.targetPath));
  if (!tgtSf) return reject(`move: target module not found in rendered set: ${input.targetPath}`);

  const stmt = srcSf.statements[input.declChildIndex];
  if (!stmt || declName(stmt) !== input.name) {
    return reject(`move: no declaration named ${input.name} at ${input.sourcePath} index ${input.declChildIndex}`);
  }
  if (!isExported(stmt)) {
    return reject(`move: declaration ${input.name} is not exported; only exported declarations can be moved (importers need an export to import)`);
  }
  if (tgtSf.statements.some((s) => declName(s) === input.name)) {
    return reject(`move: target module already declares ${input.name} (name collision)`);
  }

  const dep = findOutOfScopeDependency(checker, srcSf, tgtSf, stmt);
  if (dep) {
    return reject(`move: declaration ${input.name} references \`${dep}\` which is not in scope at the target (v1 moves only self-contained declarations; relocate or keep it manually)`);
  }

  // Derive srcKey from the already-resolved srcSf so it matches a sourceFiles key
  // exactly (buildProgram keyed each SourceFile by normalizePath(renderedPath)).
  const srcKey = normalizePath(srcSf.fileName);
  const importers = collectImporters(sourceFiles, srcKey, input.name);
  if ("reason" in importers) return reject(importers.reason);
  // Turn each importer hit into a concrete OFFSET-FREE rewrite intent. The apply
  // step re-parses each importer's stored ImportDeclaration payload and recomputes
  // payload-relative offsets, so we emit semantic intents (specifier strings /
  // names / new statement text), never module-relative spans.
  const importerRewrites: ImporterRewrite[] = importers.hits.map((h) => {
    const spec = h.importDecl.moduleSpecifier as ts.StringLiteral;
    const originalSpecifierText = spec.text; // without quotes
    const quote = h.sf.text[spec.getStart(h.sf)] ?? '"';
    const newRel = rewrittenSpecifier(h.importerPath, input.targetPath, originalSpecifierText);
    if (h.bindingNames.length === 1) {
      return {
        importerPath: h.importerPath,
        importStatementIndex: h.statementIndex,
        style: "path-rewrite" as const,
        oldSpecifier: `${quote}${originalSpecifierText}${quote}`,
        newSpecifier: `${quote}${newRel}${quote}`
      };
    }
    return {
      importerPath: h.importerPath,
      importStatementIndex: h.statementIndex,
      style: "split-out" as const,
      removeName: input.name,
      newImportText: `import { ${input.name} } from ${quote}${newRel}${quote};`
    };
  });

  return {
    ok: true,
    name: input.name,
    declKind: ts.SyntaxKind[stmt.kind],
    declPayload: srcSf.text.slice(stmt.getStart(srcSf), stmt.getEnd()),
    sourceChildIndex: input.declChildIndex,
    importerRewrites,
    sourceStillUses: sourceUsesSymbol(checker, srcSf, stmt, input.name)
  };
}
