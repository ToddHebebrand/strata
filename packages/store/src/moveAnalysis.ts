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
  /** path-rewrite: original specifier text incl. quotes, and its replacement (filled in Task 5). */
  oldSpecifier?: string;
  newSpecifier?: string;
  /** split-out: the symbol name to remove from this import's binding list (filled in Task 5). */
  removeName?: string;
  /** split-out: a new `import { X } from "<target>"` to append to the importer (filled in Task 5). */
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

function declName(stmt: ts.Statement): string | undefined {
  if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) ||
       ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) && stmt.name) {
    return stmt.name.text;
  }
  if (ts.isVariableStatement(stmt)) {
    const d = stmt.declarationList.declarations[0];
    if (d && ts.isIdentifier(d.name)) return d.name.text;
  }
  return undefined;
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

  return {
    ok: true,
    name: input.name,
    declKind: ts.SyntaxKind[stmt.kind],
    declPayload: srcSf.text.slice(stmt.getStart(srcSf), stmt.getEnd()),
    sourceChildIndex: input.declChildIndex,
    importerRewrites: [],
    sourceStillUses: false
  };
}
