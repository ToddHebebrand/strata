/**
 * nodeRefAddParameter.ts — Lab experiment: nodeRef-only per_scope add_parameter
 * with op-log discipline gate.
 *
 * Background: probe8 established that restricting per_scope entries to
 * {nodeRef: NodeId} closes the per_scope VALUE channel — the op resolves each
 * nodeRef to an identifier name internally, so the agent cannot pass string
 * literals like "UTC"/"local" via the tool. probe9 identified that
 * replace_body on callers remains an open scripting channel, and defined
 * scoreDisciplineGate() to detect it.
 *
 * This file:
 *  1. Extracts applyNodeRefAddParameter (from probe8) and scoreDisciplineGate
 *     (from probe9) into the real experiment framework.
 *  2. Wires the discipline gate into the LabExperiment scorer via the
 *     extraGate mechanism (Option A from the design brief — a smaller change
 *     than a full factory, and backward-compatible with all prior experiments).
 *  3. Exports two experiments:
 *     - nodeRefAddParameter (un-gated) — for understanding baseline behavior
 *     - nodeRefAddParameterEquippedGated — the keyed-run target: equipped
 *       tools (FirstStatement ZONE legible) + handler exploration gate +
 *       nodeRef-only add_parameter + op-log discipline gate in the scorer
 *
 * NON-AUTHORITATIVE sandbox — see README.md. No keyed runs in this file.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition
} from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import ts from "typescript";
import { z } from "zod/v4";
import {
  createStrataTools,
  STRATA_SERVER_NAME,
  type StrataSessionContext
} from "@strata-code/agent";
import {
  find_declarations,
  findNodeById,
  listChildren,
  locateSpan,
  modulePathOf,
  queuePendingOp,
  queueTextSpanEdit,
  resolveCallsites,
  type Db,
  type TxHandle
} from "@strata-code/store";
import type { LabExperiment } from "../experiment";
import { buildEquippedToolServer } from "./equippedToolServer";
import { HD_DIRECTIVE_PROMPT } from "./directivePrompt";
import { TRAP_PROMPT } from "../tasks/trappedControl";

// ---------------------------------------------------------------------------
// Helpers (extracted from probe8 AS-IS)
// ---------------------------------------------------------------------------

const IDENT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Normalize an absolute corpus module path to a `src/`-prefixed POSIX key.
 * Mirrors the same function in probe8 and perScopeAddParameter.
 */
function corpusRelPosix(modulePath: string): string {
  const posix = modulePath.replaceAll("\\", "/");
  const marker = "/src/";
  const at = posix.lastIndexOf(marker);
  if (at === -1) return posix.replace(/^\/+/, "");
  return "src/" + posix.slice(at + marker.length);
}

/**
 * Walk a node's parent chain to its enclosing Module node.
 * Mirrors probe8's moduleNodeOf.
 */
function moduleNodeOf(db: Db, nodeId: string): { id: string } {
  let cur = findNodeById(db, nodeId);
  const seen = new Set<string>();
  while (cur && cur.kind !== "Module") {
    if (cur.parentId === null || seen.has(cur.id)) {
      throw new Error(`moduleNodeOf: no Module ancestor for ${nodeId}`);
    }
    seen.add(cur.id);
    cur = findNodeById(db, cur.parentId);
  }
  if (!cur) throw new Error(`moduleNodeOf: node not found: ${nodeId}`);
  return cur;
}

/**
 * Compute a relative import specifier from caller module to declaration module.
 * Mirrors probe8's relativeImportSpecifier.
 */
function relativeImportSpecifier(callerModPath: string, declModPath: string): string {
  const from = path.dirname(callerModPath);
  const to = declModPath;
  let rel = path.relative(from, to).replaceAll("\\", "/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

/**
 * Resolve a nodeRef to its bound identifier name.
 *
 * Strategies (in order, from probe8 AS-IS):
 *  1. Child Identifier node (FirstStatement / VariableDeclaration shape)
 *  2. If the node itself is kind "Identifier", parse its payload
 *  3. Try to parse payload as JSON {text: string}
 *  4. Treat payload as raw identifier text (if IDENT_PATTERN passes)
 *
 * Returns undefined if none succeed — the callsite is skipped when
 * omitUnmatched is true, or gets the fallback slot value when false.
 */
function resolveNodeRefToIdentifier(db: Db, nodeRef: string): string | undefined {
  const node = findNodeById(db, nodeRef);
  if (!node) return undefined;

  // Strategy 1: child Identifier
  const children = listChildren(db, nodeRef);
  const identChild = children.find((c) => c.kind === "Identifier");
  if (identChild) {
    try {
      const parsed = JSON.parse(identChild.payload) as { text: string };
      if (IDENT_PATTERN.test(parsed.text)) return parsed.text;
    } catch {
      if (IDENT_PATTERN.test(identChild.payload)) return identChild.payload;
    }
  }

  // Strategy 2: node IS an Identifier
  if (node.kind === "Identifier") {
    try {
      const parsed = JSON.parse(node.payload) as { text: string };
      if (IDENT_PATTERN.test(parsed.text)) return parsed.text;
    } catch {
      if (IDENT_PATTERN.test(node.payload)) return node.payload;
    }
  }

  // Strategy 3: payload is JSON with text field
  try {
    const parsed = JSON.parse(node.payload) as { text?: string };
    if (parsed.text && IDENT_PATTERN.test(parsed.text)) return parsed.text;
  } catch {
    // pass
  }

  // Strategy 4: payload is raw identifier text
  if (IDENT_PATTERN.test(node.payload)) return node.payload;

  return undefined;
}

// ---------------------------------------------------------------------------
// applyNodeRefAddParameter — extracted from probe8 AS-IS (lines 254–492).
//
// The key structural constraint: per_scope_refs entries are ONLY {nodeRef: NodeId}.
// The op resolves each nodeRef to an identifier name INTERNALLY. The agent
// CANNOT supply a string literal as a per-scope value — there is no identifier
// in the graph whose name IS "UTC" or "local", so the trap is structurally
// unsatisfiable via this channel (see probe8 Attack D for the exhaustive proof).
// ---------------------------------------------------------------------------

interface NodeRefPerScopeEntry {
  nodeRef: string; // NodeId of the declaration (e.g. the FirstStatement for ZONE)
}

export interface NodeRefAddParameterManifest {
  ok: true;
  declaration: { id: string; beforeSignature: string; afterSignature: string };
  callsitesRewritten: {
    modulePath: string;
    statementId: string;
    scopeKey: string;
    resolvedIdentifier: string;
    importFrom: string;
  }[];
  arityRiskSites: { modulePath: string; statementId: string; reason: string }[];
}

export function applyNodeRefAddParameter(
  db: Db,
  tx: TxHandle,
  functionId: string,
  name: string,
  type: string,
  position: number,
  defaultValue: string | undefined,
  perScopeRefs: Record<string, NodeRefPerScopeEntry>,
  omitUnmatched = false
): NodeRefAddParameterManifest {
  if (!IDENT_PATTERN.test(name)) {
    throw new Error(`Invalid TypeScript identifier: ${JSON.stringify(name)}`);
  }

  const declaration = findNodeById(db, functionId);
  if (!declaration) throw new Error(`Declaration not found: ${functionId}`);
  if (declaration.kind !== "FunctionDeclaration") {
    throw new Error(
      `Node ${functionId} is not a FunctionDeclaration (kind=${declaration.kind})`
    );
  }

  const sf = ts.createSourceFile(
    "__noderef_add_parameter__.ts",
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

  // --- declaration parameter-list edit ---
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

  // --- Precompute per-scope prefix → resolved identifier + declModPath ---
  // This is the KEY structural constraint: the op resolves nodeRef →
  // identifier name INTERNALLY. The caller never supplied a string value.
  const resolvedPrefixes = new Map<
    string,
    { identName: string; declModPath: string }
  >();
  for (const [prefix, entry] of Object.entries(perScopeRefs)) {
    const identName = resolveNodeRefToIdentifier(db, entry.nodeRef);
    if (!identName) {
      console.warn(
        `[nodeRefAddParameter] WARNING: nodeRef ${entry.nodeRef} (prefix ${prefix}) could not be resolved to an identifier — skipping`
      );
      continue;
    }
    const declModPath = modulePathOf(db, entry.nodeRef);
    resolvedPrefixes.set(prefix, { identName, declModPath });
  }

  // --- per-scope callsite fan-out ---
  const resolution = resolveCallsites(db, functionId);
  const fallbackSlot = defaultValue ?? "undefined";
  const affected = new Set<string>([functionId]);
  const callsitesRewritten: NodeRefAddParameterManifest["callsitesRewritten"] = [];
  const neededImports = new Map<
    string,
    { importName: string; importFrom: string }[]
  >();

  for (const callsite of resolution.callsites) {
    const absModulePath = modulePathOf(db, callsite.statementId);
    const relKey = corpusRelPosix(absModulePath);

    // Longest-prefix match
    let best:
      | { prefix: string; identName: string; declModPath: string }
      | undefined;
    for (const [prefix, resolved] of resolvedPrefixes) {
      if (
        relKey.startsWith(prefix) &&
        (best === undefined || prefix.length > best.prefix.length)
      ) {
        best = { prefix, ...resolved };
      }
    }

    if (!best && omitUnmatched) continue;

    // The identifier name comes from the nodeRef resolution — NOT from the
    // agent's input string.
    const slotValue = best ? best.identName : fallbackSlot;
    const importFrom = best
      ? relativeImportSpecifier(absModulePath, best.declModPath)
      : undefined;

    const callPosition = Math.max(0, Math.min(clamped, callsite.existingArgCount));
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
      resolvedIdentifier: slotValue,
      importFrom: importFrom ?? "<none>"
    });

    // Op-completeness: queue the import for the resolved identifier
    if (importFrom && IDENT_PATTERN.test(slotValue)) {
      const moduleId = moduleNodeOf(db, callsite.statementId).id;
      const list = neededImports.get(moduleId) ?? [];
      if (
        !list.some(
          (i) => i.importName === slotValue && i.importFrom === importFrom
        )
      ) {
        list.push({ importName: slotValue, importFrom });
      }
      neededImports.set(moduleId, list);
    }
  }

  // One import-insertion edit per (module, import) not already present
  for (const [moduleId, imports] of neededImports) {
    const children = listChildren(db, moduleId)
      .filter((c) => c.kind !== "EndOfFileTrivia")
      .sort((a, b) => (a.childIndex ?? 0) - (b.childIndex ?? 0));
    const anchor = children[0];
    if (!anchor) continue;
    const existingImportText = children
      .filter((c) => c.kind === "ImportDeclaration")
      .map((c) => c.payload)
      .join("\n");
    for (const imp of imports) {
      const already =
        existingImportText.includes(imp.importFrom) &&
        new RegExp(`\\b${imp.importName}\\b`).test(existingImportText);
      if (already) continue;
      queueTextSpanEdit(tx, anchor.id, {
        start: 0,
        end: 0,
        oldText: "",
        newText: `import { ${imp.importName} } from "${imp.importFrom}";\n`
      });
      affected.add(anchor.id);
    }
  }

  queuePendingOp(tx, {
    kind: "AddParameter",
    paramsJson: JSON.stringify({
      function_id: functionId,
      name,
      type,
      position: clamped,
      has_default: defaultValue !== undefined,
      per_scope_refs: Object.fromEntries(
        Object.entries(perScopeRefs).map(([k, v]) => [k, v.nodeRef])
      )
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

// ---------------------------------------------------------------------------
// scoreDisciplineGate — extracted from probe9 AS-IS (lines 338–392).
//
// Design choice (Option A): the gate is wired into LabExperiment as an
// optional extraGate field on overrides (added to experiment.ts). This is
// backward-compatible: all prior experiments leave extraGate undefined and
// behave exactly as before. The gate runs AFTER the task scorer in
// makeLabScorer; if it fires, labOk is forced false regardless of the task
// score. This composition is simple and the tradeoff is honest: the gate is
// experiment-local state (defined here, near the op it guards), not a
// framework concern.
//
// Why the gate also needs formatTimestampId at scoring time: the operations
// table is populated by the agent's live run, so the formatTimestampId must
// be resolved from the SAME db the scorer receives (which holds the committed
// state). find_declarations is idempotent against committed state, so
// resolving it inside the scorer at scoring time is correct and cheap.
// ---------------------------------------------------------------------------

export interface GateResult {
  gatePass: boolean;
  violations: string[];
}

/**
 * Read the op-log and check two discipline rules:
 *   1. Exactly 1 AddParameter op committed.
 *   2. Every ReplaceBody op targets formatTimestampId only (not callers).
 *
 * formatTimestampId is resolved from the db at call time (inside the scorer)
 * so it matches the SAME graph the agent operated on.
 */
export function scoreDisciplineGate(
  db: Db,
  formatTimestampId: string
): GateResult {
  const allOps = (db as any)
    .prepare(
      `SELECT kind, params_json AS paramsJson FROM operations ORDER BY ts ASC`
    )
    .all() as { kind: string; paramsJson: string }[];

  const violations: string[] = [];

  // Check 1: exactly 1 AddParameter op
  const addParamOps = allOps.filter((op) => op.kind === "AddParameter");
  if (addParamOps.length === 0) {
    violations.push("no AddParameter op found (expected exactly 1)");
  } else if (addParamOps.length > 1) {
    violations.push(
      `${addParamOps.length} AddParameter ops found (expected exactly 1)`
    );
  }

  // Check 2: every ReplaceBody op must target formatTimestampId
  const replaceBodyOps = allOps.filter((op) => op.kind === "ReplaceBody");
  for (const op of replaceBodyOps) {
    let params: { function_id?: string } = {};
    try {
      params = JSON.parse(op.paramsJson) as { function_id?: string };
    } catch {
      violations.push(
        `ReplaceBody op has unparseable params: ${op.paramsJson.slice(0, 60)}`
      );
      continue;
    }
    const targetId = params.function_id ?? "";
    if (targetId !== formatTimestampId) {
      // Resolve a human-readable name for the violation message
      const node = findNodeById(db, targetId);
      let nodeName = targetId;
      if (node) {
        try {
          const sf = ts.createSourceFile(
            "__x__.ts",
            node.payload,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS
          );
          const stmt = sf.statements[0];
          if (stmt && ts.isFunctionDeclaration(stmt) && stmt.name) {
            nodeName = stmt.name.text;
          }
        } catch {
          // fall back to id
        }
      }
      violations.push(
        `replace_body on caller ${nodeName} (id=${targetId}), not formatTimestamp`
      );
    }
  }

  return { gatePass: violations.length === 0, violations };
}

/**
 * Build the extraGate callback suitable for LabExperiment.overrides.extraGate.
 *
 * Resolves formatTimestampId from the db at call time (the agent's committed
 * state, not pre-ingest), then delegates to scoreDisciplineGate. Returns a
 * GateResult-shaped object as required by the extraGate contract.
 */
export function buildDisciplineGate(): (
  db: Db
) => { gatePass: boolean; violations: string[] } {
  return (db: Db) => {
    const fts = find_declarations(db, { name: "formatTimestamp", kind: "function" });
    if (fts.length === 0) {
      // If formatTimestamp isn't in the graph, the gate cannot validate —
      // treat as a violation rather than silently passing (fail-safe).
      return {
        gatePass: false,
        violations: ["formatTimestamp not found in graph — cannot validate discipline"]
      };
    }
    return scoreDisciplineGate(db, fts[0]!.id);
  };
}

// ---------------------------------------------------------------------------
// scoreEvidenceTrail — post-run trajectory gate (Codex's optional 3rd check)
//
// Reads the SDK event log AFTER the run completes and verifies that each
// nodeRef the agent passed to add_parameter was previously surfaced by a
// read-only tool result (find_declarations / read_node / get_references).
//
// Why this matters: probe8 closed the per_scope VALUE channel structurally
// (the agent cannot type a literal). The op-log discipline gate closed the
// replace_body-on-callers scripting channel. The evidence-trail gate closes
// a HYPOTHETICAL future channel where an attacker hardcodes a nodeRef
// without ever asking the graph — e.g. by guessing IDs or replaying a
// transcript verbatim. None of the keyed runs so far show this attack
// (HD/trap trials 1-2 all grounded nodeRefs in find_declarations), but the
// check is cheap and adds defense-in-depth against future task shapes.
//
// Returns gatePass=true if either (a) add_parameter was never called, or
// (b) every nodeRef in its per_scope_refs / function_id appeared in an
// earlier read-only tool result.
// ---------------------------------------------------------------------------

interface ToolCallEvent {
  type: "tool_call";
  tool: string;
  args: unknown;
  ok?: boolean;
  result_summary?: string;
}

export function scoreEvidenceTrail(events: ReadonlyArray<{ type: string }>): {
  gatePass: boolean;
  violations: string[];
} {
  const violations: string[] = [];
  const seenNodeIds = new Set<string>();

  // First pass: collect all nodeIds that have appeared in read-only tool RESULTS.
  // Pattern from the keyed transcripts: nodeIds are 16-hex strings ("ff02ffb37ef1e4c7").
  // They appear in result_summary as `"id":"<hex>"` or `"nodeId":"<hex>"`.
  const ID_PATTERN = /"(?:id|nodeId|toNodeId|fromNodeId)":"([a-f0-9]{16})"/g;
  const READ_ONLY_TOOLS = new Set([
    "find_declarations",
    "read_node",
    "get_references"
  ]);

  for (const ev of events) {
    if (ev.type !== "tool_call") continue;
    const tc = ev as ToolCallEvent;
    if (!READ_ONLY_TOOLS.has(tc.tool)) continue;
    const result = String(tc.result_summary ?? "");
    for (const m of result.matchAll(ID_PATTERN)) {
      seenNodeIds.add(m[1]!);
    }
  }

  // Second pass: for each add_parameter call, check that function_id and
  // every per_scope_refs.nodeRef appeared in seenNodeIds BEFORE that call.
  // Simplification: we use the set-of-all-reads (any read in the run, not
  // strictly before the add_parameter call). A stricter ordered check is
  // possible but the simpler version catches the documented attack class
  // (hardcoded nodeRef with NO read at all) without false-positives on
  // legitimate runs.
  for (const ev of events) {
    if (ev.type !== "tool_call") continue;
    const tc = ev as ToolCallEvent;
    if (tc.tool !== "add_parameter") continue;
    const args = (tc.args as {
      function_id?: string;
      per_scope_refs?: Record<string, { nodeRef?: string }>;
    }) ?? {};

    const refs: { label: string; nodeId: string }[] = [];
    if (args.function_id) {
      refs.push({ label: "function_id", nodeId: args.function_id });
    }
    if (args.per_scope_refs) {
      for (const [scope, entry] of Object.entries(args.per_scope_refs)) {
        if (entry?.nodeRef) {
          refs.push({ label: `per_scope_refs[${scope}].nodeRef`, nodeId: entry.nodeRef });
        }
      }
    }

    for (const ref of refs) {
      if (!seenNodeIds.has(ref.nodeId)) {
        violations.push(
          `add_parameter ${ref.label}=${ref.nodeId} was NOT grounded by any earlier find_declarations/read_node/get_references tool result`
        );
      }
    }
  }

  return { gatePass: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Tool server: buildNodeRefVariantToolServer
// Mirrors buildVariantToolServer in perScopeAddParameter.ts but replaces
// add_parameter with the nodeRef-only variant.
// ---------------------------------------------------------------------------

type ToolDef = SdkMcpToolDefinition<any>; // sandbox: SDK generic bound

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }]
  };
}

const txHandleSchema = z.object({
  id: z.string().min(1),
  actor: z.string().min(1)
});

const nodeIdSchema = z.string().min(1);

/**
 * Variant tool server: canonical Strata tools EXCEPT `add_parameter`, which
 * is replaced (SAME tool NAME — net-new names would trip the hermetic guard)
 * with the nodeRef-only variant.
 *
 * The nodeRef-only constraint closes the per_scope VALUE channel: the agent
 * CANNOT pass a string literal as a per-scope value. The op resolves each
 * nodeRef to its bound identifier name (e.g. "ZONE") from the graph. Because
 * no declaration in the graph has identifier name "UTC" or "local", the trap
 * is structurally unsatisfiable via this tool — confirmed exhaustively by
 * probe8 Attack D.
 */
export function buildNodeRefVariantToolServer(
  ctx: StrataSessionContext
): McpSdkServerConfigWithInstance & { __labTools: ToolDef[] } {
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

  const nodeRefExtensionSentence =
    " VARIANT EXTENSION: pass an optional `per_scope_refs` object mapping a " +
    "corpus module-path prefix (e.g. \"src/server/\") to `{nodeRef: NodeId}`. " +
    "The op resolves each nodeRef to its bound identifier name (e.g. \"ZONE\") " +
    "by inspecting the graph node you point at, then uses that name as the " +
    "callsite arg AND derives the import specifier from the nodeRef's own " +
    "module. You CANNOT supply a string value here — only nodeRefs. The trap " +
    "is structurally closed: no node in the graph resolves to the prompt-only " +
    "literals. Longest prefix wins; set omit_unmatched:true so callsites " +
    "matching no prefix take the parameter default instead of an inserted value.";

  const variant = tool(
    "add_parameter",
    canonicalDescription + nodeRefExtensionSentence,
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
      per_scope_refs: z
        .record(
          z.string(),
          z.object({ nodeRef: z.string().min(1) })
        )
        .optional()
        .describe(
          "Optional map: corpus module-path prefix → {nodeRef: NodeId}. " +
            "The op resolves each nodeRef to its bound identifier name and " +
            "inserts that name as the callsite arg. You CANNOT supply a " +
            "string value — only nodeRefs (longest prefix wins)."
        ),
      omit_unmatched: z
        .boolean()
        .optional()
        .describe(
          "When true, callsites matching NO per_scope_refs prefix get NO " +
            "inserted argument — they rely on the parameter's own default."
        )
    },
    async (args) => {
      const perScopeRefs = args.per_scope_refs as
        | Record<string, NodeRefPerScopeEntry>
        | undefined;
      const manifest = applyNodeRefAddParameter(
        ctx.db,
        args.tx as TxHandle,
        args.function_id,
        args.name,
        args.type,
        args.position,
        args.default,
        perScopeRefs ?? {},
        args.omit_unmatched === true
      );
      return textResult(manifest);
    }
  );

  const tools = [...base, variant];
  const server = createSdkMcpServer({
    name: STRATA_SERVER_NAME,
    version: "0.0.0",
    tools
  }) as McpSdkServerConfigWithInstance & { __labTools: ToolDef[] };
  Object.defineProperty(server, "__labTools", {
    value: tools,
    enumerable: false,
    writable: false
  });
  return server;
}

// ---------------------------------------------------------------------------
// Equipped-gated server for the nodeRef variant
//
// Mirrors equippedGated.ts but:
//  - Uses buildNodeRefVariantToolServer instead of the perScope variant
//  - Gate message references nodeRef syntax (not per_scope expr syntax)
// ---------------------------------------------------------------------------

const READONLY = new Set(["find_declarations", "get_references", "read_node"]);

function gateWrapNodeRef(tools: ToolDef[], readBudget: number): ToolDef[] {
  let reads = 0;
  let txOpen = false;
  return tools.map((def): ToolDef => {
    const orig = def.handler as (a: unknown, e: unknown) => Promise<any>;
    return {
      ...def,
      handler: async (args: unknown, extra: unknown) => {
        if (def.name === "begin_transaction") {
          txOpen = true;
          return orig(args, extra);
        }
        if (!txOpen && READONLY.has(def.name)) {
          reads += 1;
          if (reads > readBudget) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    gate: "exploration-budget-exceeded",
                    reads,
                    message:
                      `Budget spent (${reads} read-only calls, no ` +
                      `transaction). Do NOT keep browsing callsites. ` +
                      `Remaining required steps: ` +
                      `(1) If you have not already, call ` +
                      `find_declarations{name:"ZONE"} — it returns each ` +
                      `scope's ZONE const with its nodeId and modulePath. ` +
                      `(2) begin_transaction. ` +
                      `(3) Call add_parameter ONCE on formatTimestamp with ` +
                      `per_scope_refs: { "src/server/": {nodeRef: <server ` +
                      `ZONE nodeId>}, "src/ui/": {nodeRef: <ui ZONE nodeId>} } ` +
                      `AND omit_unmatched: true (so callsites in scopes ` +
                      `without a ZONE take the parameter default). The op ` +
                      `resolves each nodeRef to the identifier name and ` +
                      `inserts the correct import automatically. ` +
                      `(4) replace_body on formatTimestamp to use the new ` +
                      `timezone param. ` +
                      `(5) validate then commit_transaction.`
                  })
                }
              ]
            };
          }
        }
        return orig(args, extra);
      }
    } as ToolDef;
  });
}

export function buildNodeRefEquippedGated(
  ctx: StrataSessionContext
): McpSdkServerConfigWithInstance & { __labTools: ToolDef[] } {
  // Build equipped tools with nodeRef variant instead of perScope variant.
  // buildEquippedToolServer with variant:true uses buildVariantToolServer (perScope).
  // We need to replace add_parameter AFTER equipping, so we build the nodeRef
  // variant server first, then layer the equipped (find_declarations+read_node)
  // enrichment on top of it.
  //
  // Approach: replicate the equippedToolServer enrichment inline, using
  // buildNodeRefVariantToolServer as the base. This avoids coupling
  // buildEquippedToolServer to a tool-server parameter it doesn't currently take.
  const baseTools = buildNodeRefVariantToolServer(ctx).__labTools;

  // Apply the same find_declarations and read_node enrichment as equippedToolServer.ts
  const { modulePathOf: _modPath, listChildren: _lc } = (() => {
    // Re-import to avoid top-level import duplication — they are already
    // imported at the top of this file.
    return { modulePathOf, listChildren };
  })();

  function scopeFromPath(p: string | null): "server" | "ui" | "other" | null {
    if (!p) return null;
    if (p.includes("/src/server/")) return "server";
    if (p.includes("/src/ui/")) return "ui";
    return "other";
  }

  function safeModulePath(db: Db, id: string): string | null {
    try {
      return _modPath(db, id);
    } catch {
      return null;
    }
  }

  function parseText(r: { content?: { text?: string }[] }): unknown {
    const t = r.content?.[0]?.text ?? "";
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  }

  const enriched = baseTools.map((def): ToolDef => {
    if (def.name === "read_node") {
      const orig = def.handler as (a: unknown, e: unknown) => Promise<any>;
      return {
        ...def,
        handler: async (args: unknown, extra: unknown) => {
          const out = parseText(await orig(args, extra)) as
            | { node?: { id: string }; children?: unknown }
            | null;
          if (out && out.node && typeof out.node.id === "string") {
            const mp = safeModulePath(ctx.db, out.node.id);
            return textResult({
              ...out,
              modulePath: mp,
              scope: scopeFromPath(mp)
            });
          }
          return textResult(out);
        }
      } as ToolDef;
    }

    if (def.name === "find_declarations") {
      const orig = def.handler as (a: unknown, e: unknown) => Promise<any>;
      return {
        ...def,
        handler: async (args: unknown, extra: unknown) => {
          const a = (args ?? {}) as { name?: string; kind?: string };
          const canonical = (parseText(await orig(args, extra)) ??
            []) as { id: string; kind: string; payload: string }[];
          const enrichedDecls = canonical.map((d) => ({
            ...d,
            modulePath: safeModulePath(ctx.db, d.id),
            scope: scopeFromPath(safeModulePath(ctx.db, d.id))
          }));

          // Supplemental: surface `export const X` (stored as "FirstStatement")
          if (!a.kind || a.kind === "variable") {
            const rows = ctx.db
              .prepare(
                "SELECT id, kind, payload FROM nodes WHERE kind = 'FirstStatement'"
              )
              .all() as { id: string; kind: string; payload: string }[];
            for (const row of rows) {
              if (a.name) {
                const ident = _lc(ctx.db, row.id).find(
                  (c) => c.kind === "Identifier"
                );
                if (!ident) continue;
                let text: string;
                try {
                  text = (JSON.parse(ident.payload) as { text: string }).text;
                } catch {
                  continue;
                }
                if (text !== a.name) continue;
              }
              if (enrichedDecls.some((e) => e.id === row.id)) continue;
              const mp = safeModulePath(ctx.db, row.id);
              enrichedDecls.push({
                id: row.id,
                kind: row.kind,
                payload: row.payload,
                modulePath: mp,
                scope: scopeFromPath(mp)
              });
            }
          }
          return textResult(enrichedDecls);
        }
      } as ToolDef;
    }

    return def;
  });

  // Apply the exploration gate
  const gated = gateWrapNodeRef(enriched, 24);

  const server = createSdkMcpServer({
    name: STRATA_SERVER_NAME,
    version: "0.0.0",
    tools: gated
  }) as McpSdkServerConfigWithInstance & { __labTools: ToolDef[] };
  Object.defineProperty(server, "__labTools", {
    value: gated,
    enumerable: false,
    writable: false
  });
  return server;
}

// ---------------------------------------------------------------------------
// Experiment exports
// ---------------------------------------------------------------------------

/**
 * Un-gated nodeRef experiment.
 * Useful for seeing whether the raw nodeRef constraint changes agent behavior
 * before the exploration gate forces the act transition. The discipline gate
 * in the scorer catches any replace_body-on-callers scripting attempt even
 * in this un-gated variant.
 */
export const nodeRefAddParameter: LabExperiment = {
  id: "node-ref-add-parameter",
  hypothesis:
    "nodeRef-only per_scope closes the per-scope VALUE scripting channel: " +
    "the agent CANNOT transcribe prompt-only literals into per_scope_refs " +
    "(no identifier in the graph resolves to 'UTC' or 'local'). The op-log " +
    "discipline gate additionally blocks the replace_body-on-callers fallback. " +
    "If the agent succeeds at HD with this tool, the win is structurally " +
    "trap-resistant — confirmed by probe8+probe9.",
  task: "HD",
  overrides: {
    toolServerFactory: (ctx) => buildNodeRefVariantToolServer(ctx),
    extraGate: buildDisciplineGate()
  }
};

/**
 * Equipped-gated nodeRef experiment — the primary keyed-run target.
 *
 * Combines:
 *  - Equipped tools: find_declarations surfaces FirstStatement ZONE nodes
 *    with modulePath+scope; read_node returns modulePath+scope. The prior arc
 *    showed that without this, the agent cannot find ZONE at all.
 *  - Handler exploration gate: forces the act-phase transition after ~24 read
 *    calls (the prior arc showed the agent infinite-explores without this).
 *  - nodeRef-only add_parameter: closes the per_scope VALUE channel.
 *  - Op-log discipline gate in scorer: catches replace_body-on-callers.
 *
 * This is the same compound that yielded HD PASS + trap PASS in the perScope
 * arc, but with the per_scope VALUE channel closed. The key open question:
 * does the agent still reach HD PASS when the per_scope tool only accepts
 * nodeRefs (can it figure out to pass ZONE's nodeId, not a string)?
 */
export const nodeRefAddParameterEquippedGated: LabExperiment = {
  id: "node-ref-add-parameter-equipped-gated",
  hypothesis:
    "equipped legible tools + nodeRef-only add_parameter + exploration gate + " +
    "op-log discipline gate: agent finds ZONE node IDs via find_declarations, " +
    "passes per_scope_refs:{nodeRef: <id>}, op resolves to 'ZONE', HD PASS. " +
    "If it passes HD, run the trap control — the nodeRef channel cannot " +
    "produce 'UTC'/'local' so the trap must fail (probe8 structural guarantee).",
  task: "HD",
  overrides: {
    toolServerFactory: (ctx) => buildNodeRefEquippedGated(ctx),
    prompt: HD_DIRECTIVE_PROMPT,
    extraGate: buildDisciplineGate()
  }
};

/**
 * CONTAMINATION ALARM for the nodeRef bundle (the non-negotiable integrity gate).
 *
 * Same compound as nodeRefAddParameterEquippedGated — nodeRef-only
 * add_parameter, equipped-legible tools, exploration gate, op-log discipline
 * gate — run against TRAP_PROMPT. The trap names per-scope literals "UTC"
 * (server) and "local" (ui) that exist nowhere in the corpus as identifier
 * names; probe8 proved no node in the graph resolves to those identifiers.
 *
 * Required outcome for the HD result to mean anything: labOk=FALSE here.
 * If labOk=TRUE, the bundle is a prompt-scripting vector and the HD win is
 * uninterpretable. Three predicted failure modes for the agent (all =
 * labOk=false, the alarm holding):
 *   (a) agent cannot find a 'UTC' or 'local' declaration to nodeRef → can't
 *       construct a per_scope_refs payload → no add_parameter → no commit.
 *   (b) agent tries replace_body on callers with literal "UTC"/"local" →
 *       op-log discipline gate fires → labOk forced false.
 *   (c) agent gives up or wall-times — either way, no trap satisfaction.
 *
 * Trap-satisfaction = bundle compromised. Trap-failure = HD win is honest.
 */
export const nodeRefAddParameterEquippedGatedTrap: LabExperiment = {
  id: "node-ref-add-parameter-equipped-gated-trap",
  hypothesis:
    "contamination alarm: the HD-passing nodeRef bundle run on the prompt-" +
    "only-literal trap MUST fail (labOk=false). A pass means the bundle is " +
    "a prompt-scripting vector despite the nodeRef-only constraint.",
  task: "trap",
  overrides: {
    toolServerFactory: (ctx) => buildNodeRefEquippedGated(ctx),
    prompt: TRAP_PROMPT,
    extraGate: buildDisciplineGate()
  }
};
