import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition
} from "@anthropic-ai/claude-agent-sdk";
import {
  add_parameter,
  begin,
  change_return_type,
  find_declarations,
  get_references,
  read_node,
  rename_symbol,
  replace_body,
  rollback,
  type Db,
  type DeclarationKind,
  type TxHandle
} from "@strata/store";
import {
  commit,
  commitWithBehavioralGate,
  validate,
  type AcceptanceContext
} from "@strata/verify";
import { z } from "zod/v4";

/** A stable Strata graph node ID (sha1-derived, 16 hex). */
export const nodeIdSchema = z
  .string()
  .min(1)
  .describe("Stable Strata graph node ID.");

/**
 * The handle returned by begin_transaction. The agent must hold this and
 * pass it back to rename_symbol / validate / commit_transaction /
 * rollback_transaction. Shape mirrors @strata/store's TxHandle
 * ({ id, actor }) and packages/cli/src/commands/sdkSmoke.ts.
 */
export const txHandleSchema = z
  .object({
    id: z.string().min(1).describe("Open transaction ID."),
    actor: z.string().min(1).describe("Actor that opened the transaction.")
  })
  .describe("Strata transaction handle from begin_transaction.");

/** A verify diagnostic, mirroring @strata/verify's Diagnostic. */
export const diagnosticSchema = z.object({
  nodeId: nodeIdSchema.nullable(),
  modulePath: z.string().nullable(),
  message: z.string(),
  code: z.number().int()
});

export interface StrataSessionContext {
  db: Db;
  actor: string;
  /**
   * When set, commit_transaction enforces the behavioral gate (corpus tests
   * must pass, not just tsc). Left undefined for replay/key-free runs so the
   * deterministic tsc-only commit() path is preserved.
   */
  acceptance?: AcceptanceContext;
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }]
  };
}

const declarationKindSchema = z
  .enum(["interface", "type-alias", "class", "function", "variable"])
  .describe("Declaration kind to filter by.");

/**
 * Build the Strata tools bound to one shared session context. Every
 * handler closes over ctx, so a TxHandle returned by begin_transaction is
 * usable by later mutation/validate/commit_transaction calls.
 */
export function createStrataTools(
  ctx: StrataSessionContext
): SdkMcpToolDefinition<any>[] {
  const findDeclarationsTool = tool(
    "find_declarations",
    "Find declaration nodes by name and/or kind. Read-only. This is your entry point: locate the declaration you intend to operate on. Returns an array of { id, kind, payload }; the id is the stable node ID you pass to rename_symbol.",
    {
      name: z.string().optional().describe("Declaration name to match."),
      kind: declarationKindSchema.optional()
    },
    async (args) =>
      textResult(
        find_declarations(ctx.db, {
          name: args.name,
          kind: args.kind as DeclarationKind | undefined
        }).map((n) => ({ id: n.id, kind: n.kind, payload: n.payload }))
      )
  );

  const getReferencesTool = tool(
    "get_references",
    "List every reference edge pointing at a declaration node. Read-only. Use this to inspect the full reference set before mutating. String literals that merely spell the same word are not references and will not appear here.",
    { declaration_id: nodeIdSchema },
    async (args) => textResult(get_references(ctx.db, args.declaration_id))
  );

  const readNodeTool = tool(
    "read_node",
    "Read one node by ID, optionally with its direct children. Read-only. Use it to inspect a declaration or reference before acting. Do not guess node IDs; obtain them from find_declarations or get_references.",
    {
      node_id: nodeIdSchema,
      include_children: z
        .boolean()
        .optional()
        .describe("Include the node's direct children, one level.")
    },
    async (args) =>
      textResult(
        read_node(ctx.db, args.node_id, {
          includeChildren: args.include_children
        }) ?? null
      )
  );

  const beginTransactionTool = tool(
    "begin_transaction",
    "Open a transaction. Mutations require an open transaction. Returns a transaction handle { id, actor }; hold it and pass it to rename_symbol, validate, commit_transaction, and rollback_transaction.",
    {},
    async () => textResult(begin(ctx.db, ctx.actor))
  );

  const renameSymbolTool = tool(
    "rename_symbol",
    "Rename a declaration and every reference to it in one structural operation. Requires an open transaction. Mutates the transaction overlay only; nothing is final until commit_transaction. Unrelated string literals are never touched.",
    {
      tx: txHandleSchema,
      declaration_id: nodeIdSchema,
      new_name: z.string().min(1).describe("The new identifier name.")
    },
    async (args) => {
      rename_symbol(
        ctx.db,
        args.tx as TxHandle,
        args.declaration_id,
        args.new_name
      );
      return textResult({ ok: true });
    }
  );

  const addParameterTool = tool(
    "add_parameter",
    "Add a parameter to a function declaration AND insert the corresponding argument at every resolved direct callsite, all in one operation in the open transaction you pass. This is not a declaration-only edit: in the same transaction it rewrites the function's parameter list and, for every place the reference graph resolves as a direct call of this function, inserts the new argument (your `default` if given, otherwise `undefined`) at the matching position. You do not, and must not, hand-edit callsites afterward — the argument is already inserted at each resolved direct callsite, so editing them yourself double-edits the text and corrupts the transaction. Callsites are found through the reference graph, not text search: identifiers that merely share the name are never touched. References that are not direct calls — higher-order uses (the function passed as a value), aliased uses (assigned to another binding), or other value positions — are intentionally left unedited and reported by `validate` as arity-risk sites. That is correct, expected behavior, not a failure of this tool and not your cue to patch them with `replace_body`: inspect what `validate` reports and decide deliberately. Requires an open transaction; mutates the transaction overlay only. You supply the parameter name, type, zero-based position among the existing parameters, and an optional default expression.",
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
      default: z.string().optional().describe("Optional default value expression.")
    },
    async (args) => {
      const manifest = add_parameter(
        ctx.db,
        args.tx as TxHandle,
        args.function_id,
        args.name,
        args.type,
        args.position,
        args.default
      );
      return textResult({ ok: true, ...manifest });
    }
  );

  const changeReturnTypeTool = tool(
    "change_return_type",
    "Change a function declaration's return-type annotation, or add one if absent. Requires an open transaction; mutates the overlay only. This edits the declared return type only; it does not rewrite the function body or callers. After changing a return type, use validate to see which return statements or callers the compiler now objects to, then make those structural changes deliberately.",
    {
      tx: txHandleSchema,
      function_id: nodeIdSchema,
      new_type: z.string().min(1).describe("The new return type.")
    },
    async (args) => {
      change_return_type(
        ctx.db,
        args.tx as TxHandle,
        args.function_id,
        args.new_type
      );
      return textResult({ ok: true });
    }
  );

  const replaceBodyTool = tool(
    "replace_body",
    "Replace a function declaration's entire body with new code you provide, including the surrounding braces. Requires an open transaction; mutates the overlay only. This is the low-level tool for body logic changes that are not a rename, a parameter change, or a return-type change. It does not analyze the new body's references; rely on validate to confirm the new body type-checks before you commit.",
    {
      tx: txHandleSchema,
      function_id: nodeIdSchema,
      new_body: z.string().min(2).describe("New body including its { } braces.")
    },
    async (args) => {
      replace_body(
        ctx.db,
        args.tx as TxHandle,
        args.function_id,
        args.new_body
      );
      return textResult({ ok: true });
    }
  );

  const validateTool = tool(
    "validate",
    "Type-check the transaction's pending state and return diagnostics. Returns [] when clean. Call this after a mutation and before commit_transaction.",
    { tx: txHandleSchema },
    async (args) => textResult(validate(ctx.db, args.tx as TxHandle))
  );

  const commitTransactionTool = tool(
    "commit_transaction",
    "Finalize the transaction. It finalizes ONLY if the transaction both type-checks AND the project's real test suite passes. If the type-checker reports errors it returns { ok: false, diagnostics }. If the code type-checks but the tests fail it returns { ok: false, testFailures } with the failing test output - the change is NOT finalized; fix the behavior and try again. On a clean type-check with passing tests it finalizes and returns { ok: true }. Type-clean is not done; the tests passing is done.",
    { tx: txHandleSchema },
    async (args) =>
      textResult(
        ctx.acceptance
          ? commitWithBehavioralGate(ctx.db, args.tx as TxHandle, ctx.acceptance)
          : commit(ctx.db, args.tx as TxHandle)
      )
  );

  const rollbackTransactionTool = tool(
    "rollback_transaction",
    "Discard all pending changes in the transaction and close it. Use this to recover from a failed validate before trying a different approach.",
    { tx: txHandleSchema },
    async (args) => {
      rollback(ctx.db, args.tx as TxHandle);
      return textResult({ ok: true });
    }
  );

  return [
    findDeclarationsTool,
    getReferencesTool,
    readNodeTool,
    beginTransactionTool,
    renameSymbolTool,
    addParameterTool,
    changeReturnTypeTool,
    replaceBodyTool,
    validateTool,
    commitTransactionTool,
    rollbackTransactionTool
  ];
}

export const STRATA_TOOL_NAMES = [
  "find_declarations",
  "get_references",
  "read_node",
  "begin_transaction",
  "rename_symbol",
  "add_parameter",
  "change_return_type",
  "replace_body",
  "validate",
  "commit_transaction",
  "rollback_transaction"
] as const;

/** The MCP server name. Tools are addressed as mcp__strata__<name>. */
export const STRATA_SERVER_NAME = "strata" as const;

/** Fully-qualified tool names as the model sees them. */
export const STRATA_QUALIFIED_TOOL_NAMES = STRATA_TOOL_NAMES.map(
  (n) => `mcp__${STRATA_SERVER_NAME}__${n}`
);

export function createStrataToolServer(
  ctx: StrataSessionContext
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: STRATA_SERVER_NAME,
    version: "0.0.0",
    tools: createStrataTools(ctx)
  });
}
