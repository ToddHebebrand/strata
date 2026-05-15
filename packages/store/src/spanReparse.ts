import ts from "typescript";

export type SpanKind = "params" | "returnType" | "body";

export interface Span {
  start: number;
  end: number;
  text: string;
}

export function locateSpan(payload: string, kind: SpanKind): Span {
  const sf = ts.createSourceFile(
    "__span__.ts",
    payload,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  if (sf.statements.length !== 1 || !ts.isFunctionDeclaration(sf.statements[0])) {
    throw new Error(
      "spanReparse: payload is not a function declaration statement"
    );
  }
  const fn = sf.statements[0];

  if (kind === "params") {
    const params = fn.parameters;
    if (params.length > 0) {
      const start = params[0]!.getStart(sf);
      const end = params[params.length - 1]!.getEnd();
      return { start, end, text: payload.slice(start, end) };
    }

    const openParen = findDirectToken(fn, sf, ts.SyntaxKind.OpenParenToken);
    const at = openParen.getEnd();
    return { start: at, end: at, text: "" };
  }

  if (kind === "returnType") {
    if (fn.type) {
      const start = fn.type.getStart(sf);
      const end = fn.type.getEnd();
      return { start, end, text: payload.slice(start, end) };
    }

    const closeParen = findDirectToken(fn, sf, ts.SyntaxKind.CloseParenToken);
    const at = closeParen.getEnd();
    return { start: at, end: at, text: "" };
  }

  if (!fn.body) {
    throw new Error("spanReparse: function declaration has no body");
  }
  const start = fn.body.getStart(sf);
  const end = fn.body.getEnd();
  return { start, end, text: payload.slice(start, end) };
}

function findDirectToken(
  parent: ts.Node,
  sf: ts.SourceFile,
  kind: ts.SyntaxKind
): ts.Node {
  for (const child of parent.getChildren(sf)) {
    if (child.kind === kind) {
      return child;
    }
  }
  throw new Error(
    `spanReparse: token ${ts.SyntaxKind[kind]} not found on declaration`
  );
}
