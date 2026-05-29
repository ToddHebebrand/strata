import ts from "typescript";

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
