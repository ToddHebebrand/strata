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

  // Tasks 4-6 fill these.
  return { ok: true, name: input.name, callSites: [], importerStrips: [] };
}
