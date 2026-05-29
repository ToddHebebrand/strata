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
 * Analyze a candidate move. Pure: builds a program over the rendered set, no DB.
 * Self-contained verification + importer classification arrive in Tasks 3-5;
 * this scaffolding handles location, exported, and target-collision checks.
 */
export function analyzeMove(
  rendered: Map<string, string>,
  options: ts.CompilerOptions,
  input: MoveInput
): MoveResult {
  const { sourceFiles } = buildProgram(rendered, options);
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
