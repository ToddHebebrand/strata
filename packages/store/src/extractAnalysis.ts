import ts from "typescript";
import { normalizePath } from "./resolveReferences";
import path from "node:path";

export interface BodyStatement {
  index: number;
  text: string;
}

/**
 * Parse a FunctionDeclaration payload and enumerate its block body's top-level
 * statements in source order. Returns [] if the payload's first statement is
 * not a function declaration with a block body. `text` is the statement's
 * source slice (leading/trailing trivia excluded).
 */
export function listBodyStatements(payload: string): BodyStatement[] {
  const sf = ts.createSourceFile(
    "__parent__.ts",
    payload,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const fn = sf.statements[0];
  if (!fn || !ts.isFunctionDeclaration(fn) || !fn.body) return [];
  return fn.body.statements.map((stmt, index) => ({
    index,
    text: payload.slice(stmt.getStart(sf), stmt.getEnd())
  }));
}

export interface ExtractParam {
  name: string;
  type: string;
}

export interface ExtractReturn {
  name: string;
  type: string;
  declKind: "const" | "let";
}

export interface ExtractionPlan {
  ok: true;
  params: ExtractParam[];
  returns: ExtractReturn[];
  isAsync: boolean;
  returnType: string;
  callSiteText: string;
}

export interface ExtractionRejection {
  ok: false;
  reason: string;
}

export type ExtractionResult = ExtractionPlan | ExtractionRejection;

interface SpanContext {
  sf: ts.SourceFile;
  checker: ts.TypeChecker;
  parent: ts.FunctionDeclaration;
  spanStmts: ts.Statement[];
  spanStart: number;
  spanEnd: number;
}

function reject(reason: string): ExtractionRejection {
  return { ok: false, reason };
}

/**
 * Build a program over the in-memory rendered modules WITH the standard library
 * loaded, so `await` unwrapping and type-printing resolve correctly. Distinct
 * from resolveReferences's minimal createInMemoryProgram, which deliberately
 * omits lib (the resolver skips non-rendered declarations). Keeps the same
 * in-memory-resolution host overrides and only adds a real-host fallback for
 * lib/disk reads — so it does NOT regress cross-module resolution.
 */
function buildLibBackedProgram(
  renderedByPath: Map<string, string>,
  sourceFiles: Map<string, ts.SourceFile>,
  options: ts.CompilerOptions
): ts.Program {
  const mergedOptions = { ...options, noEmit: true, skipLibCheck: true };
  const realHost = ts.createCompilerHost(mergedOptions);
  const host: ts.CompilerHost = {
    ...realHost,
    fileExists: (f) => sourceFiles.has(normalizePath(f)) || realHost.fileExists(f),
    readFile: (f) => sourceFiles.get(normalizePath(f))?.getFullText() ?? realHost.readFile(f),
    getSourceFile: (f, lang, onError) =>
      sourceFiles.get(normalizePath(f)) ?? realHost.getSourceFile(f, lang, onError),
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
    options: mergedOptions,
    host
  });
}

/**
 * Build the analysis context (program, checker, located parent + span) or a
 * rejection if the inputs do not resolve to a function-body statement range.
 */
function buildSpanContext(
  renderedByPath: Map<string, string>,
  options: ts.CompilerOptions,
  parentPath: string,
  parentStatementIndex: number,
  range: { start: number; end: number }
): SpanContext | ExtractionRejection {
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const [p, text] of renderedByPath) {
    sourceFiles.set(
      normalizePath(p),
      ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    );
  }
  const program = buildLibBackedProgram(renderedByPath, sourceFiles, options);
  const checker = program.getTypeChecker();
  const key = normalizePath(path.resolve(parentPath));
  const sf = sourceFiles.get(key) ?? sourceFiles.get(normalizePath(parentPath));
  if (!sf) return reject(`extract: parent module not found in rendered set: ${parentPath}`);
  const parent = sf.statements[parentStatementIndex];
  if (!parent || !ts.isFunctionDeclaration(parent) || !parent.body) {
    return reject(
      `extract: statement at index ${parentStatementIndex} is not a function declaration with a body`
    );
  }
  const bodyStmts = parent.body.statements;
  if (range.start < 0 || range.end >= bodyStmts.length || range.start > range.end) {
    return reject(
      `extract: statement range [${range.start}, ${range.end}] out of bounds (body has ${bodyStmts.length} statements)`
    );
  }
  const spanStmts = bodyStmts.slice(range.start, range.end + 1);
  return {
    sf,
    checker,
    parent,
    spanStmts,
    spanStart: spanStmts[0]!.getStart(sf),
    spanEnd: spanStmts[spanStmts.length - 1]!.getEnd()
  };
}

function isInside(node: ts.Node, sf: ts.SourceFile, start: number, end: number): boolean {
  return node.getStart(sf) >= start && node.getEnd() <= end;
}

/** Walk every identifier in the span statements, in source order. */
function forEachSpanIdentifier(
  ctx: SpanContext,
  visit: (id: ts.Identifier) => void
): void {
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) visit(node);
    node.forEachChild(walk);
  };
  for (const stmt of ctx.spanStmts) walk(stmt);
}

/**
 * Parameters = identifiers in the span whose symbol has a value meaning and is
 * declared lexically inside the parent function but outside the span (a param
 * or a local declared before the span). Module-level, imported, and global
 * symbols stay in scope at the new top-level function and are excluded.
 */
function inferParams(ctx: SpanContext): ExtractParam[] {
  const params: ExtractParam[] = [];
  const seen = new Set<ts.Symbol>();
  const parentStart = ctx.parent.getStart(ctx.sf);
  const parentEnd = ctx.parent.getEnd();
  forEachSpanIdentifier(ctx, (id) => {
    const symbol = ctx.checker.getSymbolAtLocation(id);
    if (!symbol || seen.has(symbol)) return;
    if ((symbol.flags & ts.SymbolFlags.Value) === 0) return; // type-only / namespace
    const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!decl || decl.getSourceFile() !== ctx.sf) return; // imported / cross-module
    const insideParent = isInside(decl, ctx.sf, parentStart, parentEnd);
    const insideSpan = isInside(decl, ctx.sf, ctx.spanStart, ctx.spanEnd);
    if (!insideParent || insideSpan) return;
    seen.add(symbol);
    const type = ctx.checker.typeToString(
      ctx.checker.getTypeOfSymbolAtLocation(symbol, id),
      ctx.parent
    );
    params.push({ name: symbol.getName(), type });
  });
  return params;
}

interface DeclaredBinding {
  symbol: ts.Symbol;
  name: string;
  declKind: "const" | "let";
}

/** Bindings (variables, nested fn/class names) declared at any depth in the span. */
function collectSpanDeclarations(ctx: SpanContext): DeclaredBinding[] {
  const out: DeclaredBinding[] = [];
  const add = (nameNode: ts.Node, declKind: "const" | "let") => {
    if (!ts.isIdentifier(nameNode)) return; // v1: skip destructuring binding patterns
    const symbol = ctx.checker.getSymbolAtLocation(nameNode);
    if (symbol) out.push({ symbol, name: symbol.getName(), declKind });
  };
  const walk = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      const flags = node.declarationList.flags;
      const declKind = flags & ts.NodeFlags.Const ? "const" : "let";
      for (const d of node.declarationList.declarations) add(d.name, declKind);
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      add(node.name, "const");
    }
    node.forEachChild(walk);
  };
  for (const stmt of ctx.spanStmts) walk(stmt);
  return out;
}

/** True if any identifier after the span (within the parent) resolves to `symbol`. */
function isReferencedAfterSpan(ctx: SpanContext, symbol: ts.Symbol): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isIdentifier(node) &&
      node.getStart(ctx.sf) >= ctx.spanEnd &&
      ctx.checker.getSymbolAtLocation(node) === symbol
    ) {
      found = true;
      return;
    }
    node.forEachChild(walk);
  };
  walk(ctx.parent.body!);
  return found;
}

function inferReturns(ctx: SpanContext): ExtractReturn[] {
  const returns: ExtractReturn[] = [];
  const seen = new Set<ts.Symbol>();
  for (const decl of collectSpanDeclarations(ctx)) {
    if (seen.has(decl.symbol)) continue;
    if (!isReferencedAfterSpan(ctx, decl.symbol)) continue;
    seen.add(decl.symbol);
    const type = ctx.checker.typeToString(
      ctx.checker.getTypeOfSymbolAtLocation(decl.symbol, ctx.parent),
      ctx.parent
    );
    returns.push({ name: decl.name, type, declKind: decl.declKind });
  }
  return returns;
}

function buildReturnType(returns: ExtractReturn[], isAsync: boolean): string {
  let base: string;
  if (returns.length === 0) base = "void";
  else if (returns.length === 1) base = returns[0]!.type;
  else base = `{ ${returns.map((r) => `${r.name}: ${r.type}`).join("; ")} }`;
  return isAsync ? `Promise<${base}>` : base;
}

function buildCallSiteText(
  name: string,
  params: ExtractParam[],
  returns: ExtractReturn[],
  isAsync: boolean
): string {
  const args = params.map((p) => p.name).join(", ");
  const call = `${isAsync ? "await " : ""}${name}(${args})`;
  if (returns.length === 0) return `${call};`;
  if (returns.length === 1) return `${returns[0]!.declKind} ${returns[0]!.name} = ${call};`;
  const declKind = returns.every((r) => r.declKind === "const") ? "const" : "let";
  return `${declKind} { ${returns.map((r) => r.name).join(", ")} } = ${call};`;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function isLoopOrSwitch(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isSwitchStatement(node)
  );
}

/**
 * Scan the span for control-flow / binding hazards that change meaning when the
 * code moves into a new top-level function. Returns a rejection reason, or
 * null (safe). Sets isAsync via the out-param ref when `await` is present.
 * `fnDepth` and `loopDepth` track nesting *within the span* so escapes are
 * distinguished from constructs fully contained in the span.
 */
function scanHazards(ctx: SpanContext, asyncRef: { value: boolean }): string | null {
  const parentStart = ctx.parent.getStart(ctx.sf);
  const parentEnd = ctx.parent.getEnd();
  let reason: string | null = null;

  const walk = (node: ts.Node, fnDepth: number, loopDepth: number): void => {
    if (reason) return;

    if (fnDepth === 0) {
      if (ts.isReturnStatement(node)) {
        reason = "extract: span contains a `return`; it would return from the new function, not the parent";
        return;
      }
      if (ts.isYieldExpression(node)) {
        reason = "extract: span contains `yield`; generators cannot be extracted";
        return;
      }
      if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
        reason = "extract: span references `this`/`super`; binding would change in a top-level function";
        return;
      }
      if (ts.isIdentifier(node) && node.text === "arguments") {
        reason = "extract: span references `arguments`; not available in a top-level function";
        return;
      }
      if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
        // Reject labeled break/continue (targets a construct potentially outside the span)
        // and unlabeled break/continue at loopDepth 0 (which would escape the span).
        const stmt = node as ts.BreakStatement | ts.ContinueStatement;
        if (stmt.label !== undefined || loopDepth === 0) {
          reason = "extract: span contains a `break`/`continue` that escapes the extracted code";
          return;
        }
      }
    }

    if (ts.isAwaitExpression(node) && fnDepth === 0) {
      asyncRef.value = true;
    }

    // Enclosing type-parameter dependence (any depth).
    if (ts.isIdentifier(node)) {
      const sym = ctx.checker.getSymbolAtLocation(node);
      const decl = sym?.declarations?.[0];
      if (
        sym &&
        (sym.flags & ts.SymbolFlags.TypeParameter) !== 0 &&
        decl &&
        decl.getSourceFile() === ctx.sf &&
        isInside(decl, ctx.sf, parentStart, parentEnd) &&
        !isInside(decl, ctx.sf, ctx.spanStart, ctx.spanEnd)
      ) {
        reason = "extract: span depends on the enclosing function's type parameter(s)";
        return;
      }
    }

    // Reassignment of a parent-scope binding (would become a by-value parameter).
    if (fnDepth === 0) {
      let target: ts.Expression | undefined;
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
          // Contiguous compound-assignment token range: += -= *= /= %= **= <<=
          // >>= >>>= &= |= ^= AND the ES2021 logical assignments ||= &&= ??=
          // (all reassign the target, so all are hazards).
          (node.operatorToken.kind >= ts.SyntaxKind.PlusEqualsToken &&
            node.operatorToken.kind <= ts.SyntaxKind.CaretEqualsToken))
      ) {
        target = node.left;
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        target = node.operand;
      }
      if (target && ts.isIdentifier(target)) {
        const sym = ctx.checker.getSymbolAtLocation(target);
        const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
        if (
          sym &&
          decl &&
          decl.getSourceFile() === ctx.sf &&
          isInside(decl, ctx.sf, parentStart, parentEnd) &&
          !isInside(decl, ctx.sf, ctx.spanStart, ctx.spanEnd)
        ) {
          reason = `extract: span reassigns the outer binding \`${sym.getName()}\`; pass-by-value would lose the write`;
          return;
        }
      }
    }

    const nextFnDepth = isFunctionLike(node) ? fnDepth + 1 : fnDepth;
    const nextLoopDepth = isLoopOrSwitch(node) ? loopDepth + 1 : loopDepth;
    node.forEachChild((c) => walk(c, nextFnDepth, nextLoopDepth));
  };

  for (const stmt of ctx.spanStmts) walk(stmt, 0, 0);
  return reason;
}

/**
 * Analyze a candidate extraction. Returns a plan with inferred params/returns/
 * async, or a rejection with a specific reason. Pure: no DB access, no writes.
 */
export function analyzeExtraction(
  renderedByPath: Map<string, string>,
  options: ts.CompilerOptions,
  parentPath: string,
  parentStatementIndex: number,
  range: { start: number; end: number },
  name: string
): ExtractionResult {
  const ctx = buildSpanContext(renderedByPath, options, parentPath, parentStatementIndex, range);
  if ("ok" in ctx) return ctx; // rejection

  const asyncRef = { value: false };
  const hazard = scanHazards(ctx, asyncRef);
  if (hazard) return reject(hazard);

  const params = inferParams(ctx);
  const returns = inferReturns(ctx);
  const isAsync = asyncRef.value;
  return {
    ok: true,
    params,
    returns,
    isAsync,
    returnType: buildReturnType(returns, isAsync),
    callSiteText: buildCallSiteText(name, params, returns, isAsync)
  };
}
