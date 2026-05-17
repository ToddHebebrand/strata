import ts from "typescript";
import { resolveCallsites } from "./callsites";
import { findNodeById, modulePathOf } from "./nodes";
import type { Db } from "./schema";
import { locateSpan } from "./spanReparse";
import {
  queuePendingOp,
  queueTextSpanEdit,
  type TxHandle
} from "./transactions";

const IDENT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function syntacticDiagnostics(sourceText: string): readonly ts.Diagnostic[] {
  const fileName = "__probe__.ts";
  const options: ts.CompilerOptions = {
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.CommonJS
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name, languageVersion) =>
    name === fileName
      ? ts.createSourceFile(name, sourceText, languageVersion, true, ts.ScriptKind.TS)
      : undefined;
  host.readFile = (name) => (name === fileName ? sourceText : undefined);
  host.fileExists = (name) => name === fileName;
  host.writeFile = () => undefined;

  const program = ts.createProgram([fileName], options, host);
  const sf = program.getSourceFile(fileName);
  return sf ? program.getSyntacticDiagnostics(sf) : [];
}

function parsesAsType(typeText: string): boolean {
  const sourceText = `let __x__: ${typeText};`;
  if (syntacticDiagnostics(sourceText).length > 0) {
    return false;
  }

  const sf = ts.createSourceFile(
    "__type__.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const stmt = sf.statements[0];
  return (
    !!stmt &&
    ts.isVariableStatement(stmt) &&
    !!stmt.declarationList.declarations[0]?.type
  );
}

function parsesAsExpression(exprText: string): boolean {
  const sourceText = `const __x__ = (${exprText});`;
  if (syntacticDiagnostics(sourceText).length > 0) {
    return false;
  }

  const sf = ts.createSourceFile(
    "__expr__.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const stmt = sf.statements[0];
  return (
    !!stmt &&
    ts.isVariableStatement(stmt) &&
    !!stmt.declarationList.declarations[0]?.initializer
  );
}

export interface AddParameterCallsiteEdit {
  modulePath: string;
  statementId: string;
  before: string;
  after: string;
}

export interface AddParameterArityRiskSite {
  modulePath: string;
  statementId: string;
  reason: string;
}

export interface AddParameterManifest {
  declaration: { id: string; beforeSignature: string; afterSignature: string };
  callsitesRewritten: AddParameterCallsiteEdit[];
  arityRiskSites: AddParameterArityRiskSite[];
}

export function add_parameter(
  db: Db,
  tx: TxHandle,
  functionId: string,
  name: string,
  type: string,
  position: number,
  defaultValue?: string
): AddParameterManifest {
  if (!IDENT_PATTERN.test(name)) {
    throw new Error(`Invalid TypeScript identifier: ${JSON.stringify(name)}`);
  }
  if (!parsesAsType(type)) {
    throw new Error(`Invalid parameter type: ${JSON.stringify(type)}`);
  }
  if (defaultValue !== undefined && !parsesAsExpression(defaultValue)) {
    throw new Error(
      `Invalid default expression: ${JSON.stringify(defaultValue)}`
    );
  }

  const declaration = findNodeById(db, functionId);
  if (!declaration) {
    throw new Error(`Declaration not found: ${functionId}`);
  }
  if (declaration.kind !== "FunctionDeclaration") {
    throw new Error(
      `Node ${functionId} is not a FunctionDeclaration (kind=${declaration.kind})`
    );
  }

  const sf = ts.createSourceFile(
    "__add_parameter__.ts",
    declaration.payload,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  if (sf.statements.length !== 1 || !ts.isFunctionDeclaration(sf.statements[0])) {
    throw new Error("add_parameter: payload is not a function declaration");
  }

  const fn = sf.statements[0];
  const params = fn.parameters;
  const clamped = Math.max(0, Math.min(position, params.length));
  const paramText =
    defaultValue === undefined
      ? `${name}: ${type}`
      : `${name}: ${type} = ${defaultValue}`;

  const declarationEdit = parameterInsertionEdit(
    declaration.payload,
    sf,
    params,
    clamped,
    paramText
  );
  queueTextSpanEdit(tx, functionId, declarationEdit);

  const resolution = resolveCallsites(db, functionId);
  const slotValue = defaultValue ?? "undefined";
  const affected = new Set<string>([functionId]);
  const callsitesRewritten: AddParameterCallsiteEdit[] = [];

  for (const callsite of resolution.callsites) {
    const callPosition = Math.max(
      0,
      Math.min(clamped, callsite.existingArgCount)
    );
    const start = callsite.argumentInsertionOffsets[callPosition];
    if (start === undefined) {
      throw new Error(
        `add_parameter: no callsite insertion offset for position ${callPosition}`
      );
    }
    const newText =
      callsite.existingArgCount === 0
        ? slotValue
        : callPosition === 0
          ? `${slotValue}, `
          : `, ${slotValue}`;

    queueTextSpanEdit(tx, callsite.statementId, {
      start,
      end: start,
      oldText: "",
      newText
    });
    affected.add(callsite.statementId);

    const stmt = findNodeById(db, callsite.statementId);
    if (!stmt) {
      throw new Error(
        `add_parameter: callsite statement not found: ${callsite.statementId}`
      );
    }
    callsitesRewritten.push({
      modulePath: modulePathOf(db, callsite.statementId),
      statementId: callsite.statementId,
      before: stmt.payload,
      after:
        stmt.payload.slice(0, start) + newText + stmt.payload.slice(start)
    });
  }

  queuePendingOp(tx, {
    kind: "AddParameter",
    paramsJson: JSON.stringify({
      function_id: functionId,
      name,
      type,
      position: clamped,
      has_default: defaultValue !== undefined
    }),
    affectedNodeIdsJson: JSON.stringify([...affected]),
    reasoning: null
  });

  const bodyStart = fn.body ? fn.body.getStart(sf) : declaration.payload.length;
  const beforeSignature = declaration.payload.slice(0, bodyStart);
  const afterSignature =
    beforeSignature.slice(0, declarationEdit.start) +
    declarationEdit.newText +
    beforeSignature.slice(declarationEdit.end);

  return {
    declaration: {
      id: functionId,
      beforeSignature,
      afterSignature
    },
    callsitesRewritten,
    arityRiskSites: resolution.nonCallReferences.map((r) => ({
      modulePath: modulePathOf(db, r.statementId),
      statementId: r.statementId,
      reason: r.shape
    }))
  };
}

function parameterInsertionEdit(
  payload: string,
  sf: ts.SourceFile,
  params: ts.NodeArray<ts.ParameterDeclaration>,
  position: number,
  paramText: string
): { start: number; end: number; oldText: string; newText: string } {
  if (params.length === 0) {
    const span = locateSpan(payload, "params");
    return {
      start: span.start,
      end: span.start,
      oldText: "",
      newText: paramText
    };
  }

  if (position === 0) {
    const start = params[0]!.getStart(sf);
    return {
      start,
      end: start,
      oldText: "",
      newText: `${paramText}, `
    };
  }

  const previous = params[position - 1] ?? params[params.length - 1]!;
  const start = previous.getEnd();
  return {
    start,
    end: start,
    oldText: "",
    newText: `, ${paramText}`
  };
}

export const addParameter = add_parameter;
