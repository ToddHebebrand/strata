import ts from "typescript";
import path from "node:path";
import { createInMemoryProgram, normalizePath } from "./resolveReferences";

export interface InlineInput {
  functionPath: string;
  functionChildIndex: number;
  name: string;
}

export interface SubstitutionIntent {
  /** normalized module key of the call-site statement. */
  callSitePath: string;
  /** child index of the containing top-level statement. */
  callSiteStatementIndex: number;
  /** parenthesized inlined expression (params→args substituted). */
  replacementText: string;
}

export interface ImporterStrip {
  importerPath: string;
  importStatementIndex: number;
  style: "removed-statement" | "removed-binding";
  /** for removed-binding. */
  removeName?: string;
}

export interface InlinePlan {
  ok: true;
  name: string;
  callSites: SubstitutionIntent[];
  importerStrips: ImporterStrip[];
}
export interface InlineRejection {
  ok: false;
  reason: string;
}
export type InlineResult = InlinePlan | InlineRejection;

function reject(reason: string): InlineRejection {
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

// Normalize the four accepted forms to params + body-expression node.
interface NormalizedFn {
  params: ts.ParameterDeclaration[];
  bodyExpr: ts.Expression;
  typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration>;
}
function normalizeDeclaration(stmt: ts.Statement): NormalizedFn | { reason: string } {
  // FunctionDeclaration with block { return <expr>; }
  if (ts.isFunctionDeclaration(stmt)) {
    return fromFunctionLike(stmt, stmt.body);
  }
  // const f = (…) => <expr>  |  const f = (…) => { return <expr>; }  |  const f = function(…){ return <expr>; }
  if (ts.isVariableStatement(stmt)) {
    const decls = stmt.declarationList.declarations;
    if (decls.length !== 1) return { reason: "inline: only a single-declarator const is supported" };
    const init = decls[0]!.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      if (ts.isArrowFunction(init) && !ts.isBlock(init.body)) {
        // concise expression body
        return { params: [...init.parameters], bodyExpr: init.body, typeParameters: init.typeParameters };
      }
      return fromFunctionLike(init, init.body as ts.Block | undefined);
    }
    return { reason: "inline: declaration initializer is not an arrow/function expression" };
  }
  return { reason: "inline: not an inlinable function declaration (expected function declaration or const arrow/function)" };
}
function fromFunctionLike(
  fn: { parameters: ts.NodeArray<ts.ParameterDeclaration>; typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> },
  body: ts.Block | undefined
): NormalizedFn | { reason: string } {
  if (!body || body.statements.length !== 1) {
    return { reason: "inline: body must be exactly one returned expression (v1 inlines expression-body functions only)" };
  }
  const only = body.statements[0]!;
  if (!ts.isReturnStatement(only) || !only.expression) {
    return { reason: "inline: body must be a single `return <expr>;`" };
  }
  return { params: [...fn.parameters], bodyExpr: only.expression, typeParameters: fn.typeParameters };
}

/** The declaration's name identifier node (function name OR const variable name). */
function declNameNodeForInline(stmt: ts.Statement): ts.Identifier | undefined {
  if (ts.isFunctionDeclaration(stmt) && stmt.name) return stmt.name;
  if (ts.isVariableStatement(stmt)) {
    const d = stmt.declarationList.declarations[0];
    if (d && ts.isIdentifier(d.name)) return d.name;
  }
  return undefined;
}

/** True when `id` is the `.name` of a PropertyAccessExpression (a member name, not a free var). */
function isMemberPropertyName(id: ts.Identifier): boolean {
  const p = id.parent;
  return ts.isPropertyAccessExpression(p) && p.name === id;
}

/**
 * If `id` is the callee of a CallExpression — possibly through parenthesized /
 * as / satisfies / non-null wrappers (`(id as any)(…)`, `(id)(…)`) — return that
 * CallExpression; else null. Unwrapping lets us validate arity/spread on uses
 * that aren't *plain* direct calls (and reject them with a precise reason).
 */
function enclosingCalleeCall(id: ts.Identifier): ts.CallExpression | null {
  let cur: ts.Node = id;
  let p = cur.parent;
  while (
    p &&
    (ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isNonNullExpression(p))
  ) {
    cur = p;
    p = p.parent;
  }
  if (p && ts.isCallExpression(p) && p.expression === cur) return p;
  return null;
}

/** True when `id` is a named-import binding: `import { id }` / `import { x as id }` / default-clause name. */
function isNamedImportBinding(id: ts.Identifier): boolean {
  const p = id.parent;
  return ts.isImportSpecifier(p) || ts.isImportClause(p);
}

/**
 * Index of the top-level statement (direct child of the SourceFile) that
 * contains `node`. Walks up the parent chain until the parent is the SourceFile.
 */
function topLevelStatementIndexOf(sf: ts.SourceFile, node: ts.Node): number {
  let cur: ts.Node = node;
  while (cur.parent && cur.parent !== sf) cur = cur.parent;
  return sf.statements.indexOf(cur as ts.Statement);
}

function isAssignmentOperator(k: ts.SyntaxKind): boolean {
  return k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
}

/**
 * Syntactically pure: identifier, literal, this, or member-access / operator
 * chain over those. Rejects anything containing a call / new / await / yield /
 * assignment / inc-dec / arrow / function-expression / tagged-template — i.e.
 * anything whose duplication or reordering during inlining could change
 * evaluation. Conservative by design: a false "impure" only refuses a call site
 * with a clear reason; a false "pure" must never happen.
 */
function isPureArg(node: ts.Expression): boolean {
  let pure = true;
  const walk = (n: ts.Node): void => {
    if (!pure) return;
    if (
      ts.isCallExpression(n) ||
      ts.isNewExpression(n) ||
      ts.isAwaitExpression(n) ||
      ts.isYieldExpression(n) ||
      (ts.isBinaryExpression(n) && isAssignmentOperator(n.operatorToken.kind)) ||
      (ts.isPrefixUnaryExpression(n) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) ||
      ts.isPostfixUnaryExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isFunctionExpression(n) ||
      ts.isTaggedTemplateExpression(n)
    ) {
      pure = false;
      return;
    }
    n.forEachChild(walk);
  };
  walk(node);
  return pure;
}

/**
 * Build the inlined replacement expression: substitute each parameter's argument
 * text into the body expression (hygienic, by SYMBOL — an identifier in the body
 * is replaced iff its symbol is a parameter), then parenthesize the whole result
 * so operator precedence is preserved at the call site. Edits are applied
 * right-to-left on the body's own text so offsets stay stable.
 */
function buildReplacement(
  checker: ts.TypeChecker,
  fnSf: ts.SourceFile,
  bodyExpr: ts.Expression,
  paramSyms: ts.Symbol[],
  argTexts: string[]
): string {
  const symToArg = new Map<ts.Symbol, string>();
  paramSyms.forEach((s, i) => symToArg.set(s, argTexts[i]!));
  const base = bodyExpr.getStart(fnSf);
  let text = bodyExpr.getText(fnSf);
  const edits: { start: number; end: number; with: string }[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && !isMemberPropertyName(n)) {
      const sym = checker.getSymbolAtLocation(n);
      if (sym && symToArg.has(sym)) {
        edits.push({ start: n.getStart(fnSf) - base, end: n.getEnd() - base, with: symToArg.get(sym)! });
        return;
      }
    }
    n.forEachChild(walk);
  };
  walk(bodyExpr);
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) text = text.slice(0, e.start) + e.with + text.slice(e.end);
  return `(${text})`;
}

export function analyzeInline(
  rendered: Map<string, string>,
  options: ts.CompilerOptions,
  input: InlineInput
): InlineResult {
  const { checker, sourceFiles } = buildProgram(rendered, options);
  const fnKey = normalizePath(path.resolve(input.functionPath));
  const sf = sourceFiles.get(fnKey) ?? sourceFiles.get(normalizePath(input.functionPath));
  if (!sf) return reject(`inline: function module not found in rendered set: ${input.functionPath}`);
  const stmt = sf.statements[input.functionChildIndex];
  if (!stmt) return reject(`inline: no statement at ${input.functionPath} index ${input.functionChildIndex}`);

  const norm = normalizeDeclaration(stmt);
  if ("reason" in norm) return reject(norm.reason);
  if (norm.typeParameters && norm.typeParameters.length > 0) {
    return reject(`inline: ${input.name} is generic; v1 does not inline functions with type parameters`);
  }
  for (const p of norm.params) {
    if (!ts.isIdentifier(p.name)) return reject(`inline: ${input.name} has a non-identifier parameter (destructuring/pattern); v1 supports plain identifier params only`);
    if (p.dotDotDotToken) return reject(`inline: ${input.name} has a rest parameter; v1 supports plain identifier params only`);
    if (p.initializer) return reject(`inline: ${input.name} has a default-valued parameter; v1 supports plain identifier params only`);
  }

  // --- Body scan: reject this/super/arguments/await, recursion, and any free
  // variable that is not a parameter or a global/lib symbol (self-containment). ---

  // Resolve the function's own symbol (the declaration name) for recursion detection.
  const fnNameNode = declNameNodeForInline(stmt);
  const fnSym = fnNameNode ? checker.getSymbolAtLocation(fnNameNode) : undefined;

  // Collect the parameter symbols.
  const paramSyms = new Set<ts.Symbol>();
  for (const p of norm.params) {
    const s = checker.getSymbolAtLocation(p.name);
    if (s) paramSyms.add(s);
  }

  let bodyReason: string | null = null;
  const scan = (node: ts.Node): void => {
    if (bodyReason) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
      bodyReason = `inline: ${input.name} body uses this/super; not safe to inline`; return;
    }
    if (ts.isIdentifier(node) && node.text === "arguments") {
      bodyReason = `inline: ${input.name} body uses arguments; not safe to inline`; return;
    }
    if (ts.isAwaitExpression(node)) {
      bodyReason = `inline: ${input.name} body uses await; v1 does not inline async expression bodies`; return;
    }
    if (ts.isIdentifier(node) && !isMemberPropertyName(node)) {
      let sym = checker.getSymbolAtLocation(node);
      if (sym && sym.flags & ts.SymbolFlags.Alias) { try { sym = checker.getAliasedSymbol(sym); } catch { /* keep */ } }
      const decl = sym?.declarations?.[0];
      if (sym && fnSym && sym === fnSym) { bodyReason = `inline: ${input.name} is recursive; cannot inline`; return; }
      if (decl) {
        const declSf = decl.getSourceFile();
        const inLib = declSf.isDeclarationFile;
        const isParam = sym ? paramSyms.has(sym) : false;
        if (!inLib && !isParam) {
          bodyReason = `inline: ${input.name} body references \`${sym!.getName()}\` which is not a parameter or global (v1 inlines only self-contained expression bodies)`;
          return;
        }
      }
    }
    node.forEachChild(scan);
  };
  scan(norm.bodyExpr);
  if (bodyReason) return reject(bodyReason);

  // --- Reference discovery + call classification. Every value-position use of
  // the function across the rendered program must be the callee of a direct call
  // with matching arity and no spread arg. The declaration's own name and
  // named-import bindings are partitioned out (importers handled in Task 6). ---
  interface CallRecord {
    sf: ts.SourceFile;
    call: ts.CallExpression;
    callSitePath: string;
    callSiteStatementIndex: number;
  }
  const callRecords: CallRecord[] = [];
  let refReason: string | null = null;
  for (const file of sourceFiles.values()) {
    const visit = (node: ts.Node): void => {
      if (refReason) return;
      if (ts.isIdentifier(node) && node.text === input.name && !isMemberPropertyName(node)) {
        let sym = checker.getSymbolAtLocation(node);
        if (sym && sym.flags & ts.SymbolFlags.Alias) { try { sym = checker.getAliasedSymbol(sym); } catch { /* keep */ } }
        if (sym && fnSym && sym === fnSym) {
          // It's a reference to our function. Classify by parent.
          if (node === fnNameNode) {
            /* the declaration itself */
          } else if (isNamedImportBinding(node)) {
            /* importer; handled in Task 6 */
          } else {
            const call = enclosingCalleeCall(node);
            if (!call) {
              refReason = `inline: ${input.name} is used as a value (not a direct call) at ${normalizePath(file.fileName)}; v1 inlines only direct calls`;
              return;
            }
            if (call.arguments.some((a) => ts.isSpreadElement(a))) {
              refReason = `inline: ${input.name} is called with a spread argument; cannot map args to params`; return;
            }
            if (call.arguments.length !== norm.params.length) {
              refReason = `inline: a call to ${input.name} has ${call.arguments.length} args but the function takes ${norm.params.length} (arity mismatch)`; return;
            }
            // Only a PLAIN identifier callee `name(args)` can be located + spliced
            // by the apply step. A wrapped callee (`(name as any)(args)`) that
            // passes arity is refused — apply can't cleanly splice through a cast.
            if (call.expression !== node) {
              refReason = `inline: ${input.name} is called through a cast/parenthesized expression at ${normalizePath(file.fileName)}; v1 inlines only plain direct calls`;
              return;
            }
            callRecords.push({
              sf: file,
              call,
              callSitePath: normalizePath(file.fileName),
              callSiteStatementIndex: topLevelStatementIndexOf(file, call)
            });
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(file);
  }
  if (refReason) return reject(refReason);

  // --- Argument purity + hygienic substitution. For each call site, require
  // every argument to be syntactically pure (inlining duplicates/reorders args,
  // so effectful args could change behavior), then build the parenthesized
  // inlined expression by substituting each parameter's argument text. ---

  // Ordered parameter symbols (substitution must map argument i → param i).
  const paramSymsOrdered: ts.Symbol[] = [];
  for (const p of norm.params) {
    const s = checker.getSymbolAtLocation(p.name);
    if (!s) return reject(`inline: could not resolve parameter symbol for ${input.name}`);
    paramSymsOrdered.push(s);
  }

  const callSites: SubstitutionIntent[] = [];
  for (const c of callRecords) {
    const args = [...c.call.arguments];
    for (const arg of args) {
      if (!isPureArg(arg)) {
        return reject(
          `inline: a call to ${input.name} passes a non-pure argument (${arg.getText(c.sf)}); inlining could change evaluation, so it is refused`
        );
      }
    }
    const argTexts = args.map((a) => a.getText(c.sf));
    const replacementText = buildReplacement(checker, sf, norm.bodyExpr, paramSymsOrdered, argTexts);
    callSites.push({
      callSitePath: c.callSitePath,
      callSiteStatementIndex: c.callSiteStatementIndex,
      replacementText
    });
  }

  // Task 6 fills these.
  return { ok: true, name: input.name, callSites, importerStrips: [] };
}
