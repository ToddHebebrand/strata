import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition
} from "@anthropic-ai/claude-agent-sdk";
import ts from "typescript";
import { z } from "zod/v4";
import {
  createStrataTools,
  STRATA_SERVER_NAME,
  type StrataSessionContext
} from "@strata/agent";
import {
  findNodeById,
  locateSpan,
  modulePathOf,
  queuePendingOp,
  queueTextSpanEdit,
  resolveCallsites,
  type Db,
  type TxHandle
} from "@strata/store";
import type { LabExperiment } from "../experiment";

const IDENT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * NORMALIZE an absolute corpus module path to a `src/`-prefixed POSIX key
 * (e.g. "src/server/events.ts"), the same key shape the HD scorer's
 * scopeOf() consumes and that `per_scope` policy keys are written against.
 * The store's modulePathOf() returns the ABSOLUTE module path; we strip
 * everything up to and including the last "/src/" segment so the prefix
 * match is independent of where the corpus lives on disk.
 */
function corpusRelPosix(modulePath: string): string {
  const posix = modulePath.replaceAll("\\", "/");
  const marker = "/src/";
  const at = posix.lastIndexOf(marker);
  if (at === -1) {
    return posix.replace(/^\/+/, "");
  }
  return "src/" + posix.slice(at + marker.length);
}

/**
 * LONGEST-PREFIX per-scope selection. Given a callsite's corpus-relative
 * key and the optional per_scope policy, return the argument expression
 * whose module-path-prefix key is the LONGEST one that prefixes the
 * callsite key. No match ⇒ undefined (caller falls back to the canonical
 * default slot value). Pure; deterministic.
 */
function selectScopeExpr(
  relKey: string,
  perScope: Record<string, string> | undefined
): string | undefined {
  if (!perScope) {
    return undefined;
  }
  let best: { prefix: string; expr: string } | undefined;
  for (const [prefix, expr] of Object.entries(perScope)) {
    if (
      relKey.startsWith(prefix) &&
      (best === undefined || prefix.length > best.prefix.length)
    ) {
      best = { prefix, expr };
    }
  }
  return best?.expr;
}

/**
 * Faithful reimplementation of the canonical @strata/store add_parameter
 * algorithm (packages/store/src/addParameter.ts) composed ENTIRELY from
 * exported store primitives (resolveCallsites / queueTextSpanEdit /
 * queuePendingOp / modulePathOf / findNodeById / locateSpan), with ONE
 * deliberate extension: the per-callsite slot value is chosen by
 * longest-prefix `per_scope` match instead of a single uniform value.
 *
 * Why a lab-local copy and not the canonical op: the canonical op hardcodes
 * `const slotValue = defaultValue ?? "undefined"` with NO per-callsite hook,
 * so per-scope expressiveness cannot be obtained by calling it. @strata/store
 * is NOT modified (a store change is graduation-class, out of sandbox scope);
 * the sandbox composes store transaction primitives directly, which is the
 * sanctioned fallback when the canonical op is too rigid.
 *
 * DRIFT RISK: this is a hand-copy of packages/store/src/addParameter.ts's core
 * algorithm (parameter-insertion edit, callsite fan-out, single queuePendingOp)
 * + ONE per-scope extension. If the canonical op's algorithm changes, this copy
 * silently diverges and the mechanics test would still pass on the fixed corpus.
 * The faithfulness-pin test (see perScopeAddParameter.test.ts) mechanically
 * guards the no-per_scope path against canonical; the corpus assertions guard
 * behavior. Any graduation re-implements per-scope INSIDE @strata/store via the
 * rigid pipeline — this copy is sandbox-only and never graduates as-is.
 *
 * CRITICAL INVARIANT (the lever's entire thesis): the declaration parameter
 * insertion AND every per-scope callsite argument insertion are queued as
 * text-span edits in ONE transaction and recorded as exactly ONE
 * `AddParameter` pending op — no second replace_body/text-span operation,
 * no hand-patch, hence zero `oldText mismatch` collision.
 */
export interface PerScopeAddParameterManifest {
  ok: true;
  declaration: { id: string; beforeSignature: string; afterSignature: string };
  callsitesRewritten: {
    modulePath: string;
    statementId: string;
    scopeKey: string;
    inserted: string;
  }[];
  arityRiskSites: { modulePath: string; statementId: string; reason: string }[];
}

export function applyPerScopeAddParameter(
  db: Db,
  tx: TxHandle,
  functionId: string,
  name: string,
  type: string,
  position: number,
  defaultValue: string | undefined,
  perScope: Record<string, string> | undefined
): PerScopeAddParameterManifest {
  if (!IDENT_PATTERN.test(name)) {
    throw new Error(`Invalid TypeScript identifier: ${JSON.stringify(name)}`);
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
    "__per_scope_add_parameter__.ts",
    declaration.payload,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const fnStmt = sf.statements[0];
  if (sf.statements.length !== 1 || !ts.isFunctionDeclaration(fnStmt)) {
    throw new Error("add_parameter: payload is not a function declaration");
  }
  const params = fnStmt.parameters;
  const clamped = Math.max(0, Math.min(position, params.length));
  const paramText =
    defaultValue === undefined
      ? `${name}: ${type}`
      : `${name}: ${type} = ${defaultValue}`;

  // --- declaration parameter-list edit (same shape as the canonical
  //     parameterInsertionEdit, derived via the exported locateSpan) ---
  let declarationEdit: {
    start: number;
    end: number;
    oldText: string;
    newText: string;
  };
  if (params.length === 0) {
    const span = locateSpan(declaration.payload, "params");
    declarationEdit = {
      start: span.start,
      end: span.start,
      oldText: "",
      newText: paramText
    };
  } else if (clamped === 0) {
    const start = params[0]!.getStart(sf);
    declarationEdit = {
      start,
      end: start,
      oldText: "",
      newText: `${paramText}, `
    };
  } else {
    const previous = params[clamped - 1] ?? params[params.length - 1]!;
    const start = previous.getEnd();
    declarationEdit = {
      start,
      end: start,
      oldText: "",
      newText: `, ${paramText}`
    };
  }
  queueTextSpanEdit(tx, functionId, declarationEdit);

  // --- per-scope callsite fan-out (one structural op, no hand-patch) ---
  const resolution = resolveCallsites(db, functionId);
  const fallbackSlot = defaultValue ?? "undefined";
  const affected = new Set<string>([functionId]);
  const callsitesRewritten: PerScopeAddParameterManifest["callsitesRewritten"] =
    [];

  for (const callsite of resolution.callsites) {
    const absModulePath = modulePathOf(db, callsite.statementId);
    const relKey = corpusRelPosix(absModulePath);
    const scopeExpr = selectScopeExpr(relKey, perScope);
    const slotValue = scopeExpr ?? fallbackSlot;

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
    callsitesRewritten.push({
      modulePath: absModulePath,
      statementId: callsite.statementId,
      scopeKey: relKey,
      inserted: newText
    });
  }

  // EXACTLY ONE operation-log row for the whole per-scope fan-out.
  queuePendingOp(tx, {
    kind: "AddParameter",
    paramsJson: JSON.stringify({
      function_id: functionId,
      name,
      type,
      position: clamped,
      has_default: defaultValue !== undefined,
      per_scope: perScope ?? null
    }),
    affectedNodeIdsJson: JSON.stringify([...affected]),
    reasoning: null
  });

  const bodyStart = fnStmt.body
    ? fnStmt.body.getStart(sf)
    : declaration.payload.length;
  const beforeSignature = declaration.payload.slice(0, bodyStart);
  const afterSignature =
    beforeSignature.slice(0, declarationEdit.start) +
    declarationEdit.newText +
    beforeSignature.slice(declarationEdit.end);

  return {
    ok: true,
    declaration: { id: functionId, beforeSignature, afterSignature },
    callsitesRewritten,
    arityRiskSites: resolution.nonCallReferences.map((r) => ({
      modulePath: modulePathOf(db, r.statementId),
      statementId: r.statementId,
      reason: r.shape
    }))
  };
}

/** A Strata transaction handle, mirroring @strata/store's TxHandle. */
const txHandleSchema = z.object({
  id: z.string().min(1),
  actor: z.string().min(1)
});

const nodeIdSchema = z.string().min(1);

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }]
  };
}

/**
 * Variant tool server: the canonical Strata tool set EXCEPT `add_parameter`,
 * which is replaced (SAME tool NAME — net-new names would trip the hermetic
 * guard and are out of sandbox scope) with a per-scope-expressive variant.
 *
 * The variant accepts an optional `per_scope` policy mapping a corpus
 * module-path prefix (e.g. "src/server/") to an argument expression
 * (e.g. an imported `ZONE`). The agent expresses the per-callsite
 * differentiation as ONE structural op — removing the colliding hand
 * `replace_body` that the four falsified levers all traced back to.
 *
 * The returned server is the real createSdkMcpServer instance (so the live
 * SDK loop and the hermetic init guard, which checks tool NAMES only, both
 * accept it). For deterministic model-free testing the raw tool definitions
 * are also attached as a non-enumerable `__labTools`.
 */
export function buildVariantToolServer(
  ctx: StrataSessionContext
): McpSdkServerConfigWithInstance & { __labTools: SdkMcpToolDefinition<any>[] } { // sandbox: SDK generic bound
  const base = createStrataTools(ctx).filter(
    (definition) => definition.name !== "add_parameter"
  );

  const canonicalDescription =
    "Add a parameter to a function declaration AND insert the corresponding " +
    "argument at every resolved direct callsite, all in one structural " +
    "operation in the open transaction you pass. Callsites are found through " +
    "the reference graph, not text search. You do not, and must not, " +
    "hand-edit callsites afterward. Requires an open transaction; mutates " +
    "the transaction overlay only.";
  const perScopeSentence =
    " VARIANT EXTENSION: pass an optional `per_scope` object mapping a " +
    "corpus module-path prefix (e.g. \"src/server/\") to the argument " +
    "expression to insert at callsites under that prefix (longest prefix " +
    "wins; callsites matching no prefix get `default`). This lets you " +
    "differentiate the per-callsite argument by scope in this SAME single " +
    "operation — never a second replace_body edit.";

  const variant = tool(
    "add_parameter",
    canonicalDescription + perScopeSentence,
    {
      tx: txHandleSchema,
      function_id: nodeIdSchema,
      name: z.string().min(1).describe("New parameter identifier."),
      type: z.string().min(1).describe("New parameter TypeScript type."),
      position: z
        .number()
        .int()
        .min(0)
        .describe("Zero-based position among the existing parameters."),
      default: z
        .string()
        .optional()
        .describe("Optional default value expression."),
      per_scope: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Optional map: corpus module-path prefix → argument expression " +
            "to insert at callsites under that prefix (longest prefix wins)."
        )
    },
    async (args) => {
      const manifest = applyPerScopeAddParameter(
        ctx.db,
        args.tx as TxHandle,
        args.function_id,
        args.name,
        args.type,
        args.position,
        args.default,
        args.per_scope as Record<string, string> | undefined
      );
      return textResult(manifest);
    }
  );

  const tools = [...base, variant];
  const server = createSdkMcpServer({
    name: STRATA_SERVER_NAME,
    version: "0.0.0",
    tools
  }) as McpSdkServerConfigWithInstance & {
    __labTools: SdkMcpToolDefinition<any>[];
  };
  Object.defineProperty(server, "__labTools", {
    value: tools,
    enumerable: false,
    writable: false
  });
  return server;
}

export const perScopeAddParameter: LabExperiment = {
  id: "per-scope-add-parameter",
  hypothesis:
    "Per-scope add_parameter expressiveness lets the agent differentiate " +
    "callsites in ONE structural op (one AddParameter op-log row, zero " +
    "oldText-mismatch thrash, no colliding replace_body — the " +
    "four-falsified-levers root cause); expect HD PASS.",
  task: "HD",
  overrides: {
    toolServerFactory: (ctx) => buildVariantToolServer(ctx)
  }
};
