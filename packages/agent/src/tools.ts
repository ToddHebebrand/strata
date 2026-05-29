import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition
} from "@anthropic-ai/claude-agent-sdk";
import {
  add_import,
  add_parameter,
  begin,
  change_return_type,
  create_function,
  embedCommitPattern,
  extract_function,
  find_declarations,
  find_declarations_in_module,
  get_references,
  isVecAvailable,
  list_module_exports,
  move_declaration,
  read_node,
  rename_symbol,
  replace_body,
  rollback,
  semantic_search,
  type Db,
  type DeclarationKind,
  type DiscoveryKind,
  type EmbeddingProvider,
  type TxHandle
} from "@strata/store";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  buildAnalysisContext,
  commit,
  commitWithBehavioralGate,
  validate,
  type AcceptanceContext
} from "@strata/verify";
import { z } from "zod/v4";
import { type SessionLog } from "./log";

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
  /**
   * Layer 2 embedding provider for `semantic_search`. When absent or when
   * the sqlite-vec extension didn't load, `semantic_search` returns a clear
   * "unavailable" error rather than crashing the session.
   */
  embeddingProvider?: EmbeddingProvider;
  /**
   * Layer 3: the original user task prompt (BEFORE any L1/L2 scaffolding is
   * prepended). Recorded on every transaction this session opens so the
   * commit-pattern memory captures what the agent was actually asked to do,
   * not the injected codebase shape.
   */
  taskPrompt?: string;
  /**
   * Session log to surface telemetry events from tool handlers. Today only
   * commit_transaction emits (commit_pattern_embed ok/failure). Optional so
   * standalone tool tests can omit it.
   */
  log?: SessionLog;
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

  const listModuleExportsTool = tool(
    "list_module_exports",
    "List the top-level declarations of a single module with their names, kinds, and whether they're exported. Read-only. Use this when you know which module to look at and want its API shape without enumerating the whole codebase via find_declarations.",
    { module_id: nodeIdSchema },
    async (args) => textResult(list_module_exports(ctx.db, args.module_id))
  );

  const findDeclarationsInModuleTool = tool(
    "find_declarations_in_module",
    "Find declarations scoped to a single module by name and/or kind. Read-only. Cheaper than find_declarations when you already know which module the declaration belongs to (e.g. from list_module_exports or the upfront codebase index).",
    {
      module_id: nodeIdSchema,
      name: z.string().optional().describe("Declaration name to match."),
      kind: declarationKindSchema.optional()
    },
    async (args) =>
      textResult(
        find_declarations_in_module(ctx.db, {
          moduleId: args.module_id,
          name: args.name,
          kind: args.kind as DiscoveryKind | undefined
        }).map((n) => ({ id: n.id, kind: n.kind, payload: n.payload }))
      )
  );

  const readTestFileTool = tool(
    "read_test_file",
    "Read a test file from the corpus by its corpus-relative path (must start with `tests/` or `test/`). Read-only. Test files live on disk, not in the structural graph — when a task is 'fix the failing test', the test itself is the spec, and this tool lets you read it directly instead of triggering the gate just to see test output. Refuses anything outside the corpus or anything not under tests/ or test/.",
    {
      path: z
        .string()
        .min(1)
        .describe(
          "Corpus-relative path, e.g. `tests/dateRange.test.ts`. Must start with `tests/` or `test/` and must not contain `..`."
        )
    },
    async (args) => {
      if (!ctx.acceptance) {
        throw new Error(
          "read_test_file requires an acceptance context (corpus root). Not available in this session."
        );
      }
      const rel = args.path.replaceAll("\\", "/");
      if (rel.includes("..")) {
        throw new Error(
          `read_test_file: path must not contain '..': ${JSON.stringify(rel)}`
        );
      }
      if (!rel.startsWith("tests/") && !rel.startsWith("test/")) {
        throw new Error(
          `read_test_file: path must start with 'tests/' or 'test/': ${JSON.stringify(rel)}`
        );
      }
      const abs = path.join(ctx.acceptance.corpusRoot, rel);
      const resolved = path.resolve(abs);
      const corpusResolved = path.resolve(ctx.acceptance.corpusRoot);
      if (
        resolved !== corpusResolved &&
        !resolved.startsWith(corpusResolved + path.sep)
      ) {
        throw new Error(
          `read_test_file: resolved path escapes corpus root: ${resolved}`
        );
      }
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        throw new Error(`read_test_file: not a file: ${rel}`);
      }
      const content = readFileSync(resolved, "utf8");
      return textResult({ path: rel, content });
    }
  );

  const semanticSearchTool = tool(
    "semantic_search",
    "Semantic search across the codebase's declarations. Use when you don't know the symbol name and need to find candidates by meaning; for known symbol names, find_declarations is faster and exact. Returns top-K declarations with their module paths.",
    {
      query: z
        .string()
        .min(1)
        .describe("Natural-language description of what you're looking for."),
      k: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max number of hits to return. Default 10.")
    },
    async (args) => {
      if (!ctx.embeddingProvider) {
        return textResult({
          error:
            "semantic_search unavailable: no embedding provider configured for this session (STRATA_EMBED_API_KEY may be unset)."
        });
      }
      if (!isVecAvailable(ctx.db)) {
        return textResult({
          error:
            "semantic_search unavailable: sqlite-vec extension did not load on this platform."
        });
      }
      const hits = await semantic_search(
        ctx.db,
        ctx.embeddingProvider,
        args.query,
        args.k ?? 10
      );
      return textResult(hits);
    }
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
    async () => textResult(begin(ctx.db, ctx.actor, ctx.taskPrompt))
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

  const addImportTool = tool(
    "add_import",
    "Add an import declaration to a module. Requires an open transaction; the new node is visible to `validate` immediately. You supply the target module ID and the full import statement text (e.g. an `import { foo } from \"./bar\"` line). Must parse as a single ImportDeclaration. The import is appended to the module's children; TypeScript is order-insensitive for value imports, so its rendered position at end-of-file is semantically fine. Use this before or together with create_function / replace_body when the new code references a symbol the module doesn't already import.",
    {
      tx: txHandleSchema,
      module_id: nodeIdSchema,
      import_text: z
        .string()
        .min(8)
        .describe(
          "Full text of the import statement to insert, e.g. an `import { foo } from \"./bar\"` line."
        )
    },
    async (args) => {
      const result = add_import(
        ctx.db,
        args.tx as TxHandle,
        args.module_id,
        args.import_text
      );
      return textResult({ ok: true, ...result });
    }
  );

  const createFunctionTool = tool(
    "create_function",
    "Append a new function declaration to a module. Requires an open transaction; the new node is visible to `validate` immediately. You supply the target module id and the full function text (e.g. `export function foo(x: number): string { return String(x); }`). The text must parse as a single FunctionDeclaration with a name and a body — no `declare`, no class methods, no arrow expressions. References inside the new body are NOT resolved structurally: use `validate` after creating to confirm any imports or names it depends on actually resolve, and use other tools (e.g. `rename_symbol`) only on declarations that already exist in the graph.",
    {
      tx: txHandleSchema,
      module_id: nodeIdSchema,
      function_text: z
        .string()
        .min(10)
        .describe(
          "Full text of the function declaration to insert, e.g. `export function foo(x: number): string { return String(x); }`."
        )
    },
    async (args) => {
      const result = create_function(
        ctx.db,
        args.tx as TxHandle,
        args.module_id,
        args.function_text
      );
      return textResult({ ok: true, ...result });
    }
  );

  const extractFunctionTool = tool(
    "extract_function",
    "Extract a contiguous run of statements from a function body into a NEW top-level function, replacing the original statements with a call — all in one operation in the open transaction you pass. You give the parent function's node ID, an inclusive statement index range over its body's top-level statements (read them first via read_node, which lists `bodyStatements` with their indices), and the new function's name. The tool AUTO-INFERS everything: parameters (the variables the span reads from the enclosing function), the return value(s) (variables the span declares that are used after it — one becomes `return x`, several become a returned object you destructure at the call site), and whether the new function must be `async` (if the span awaits). You do NOT, and must not, hand-write the new function or edit the call site afterward — both are produced and applied for you; editing them yourself double-edits the transaction. The tool REFUSES, with a specific reason, spans it cannot prove safe to move: a `return`, a `break`/`continue` that escapes the span, `yield`, `this`/`super`/`arguments`, dependence on the enclosing function's type parameters, or reassignment of an outer variable. When refused, pick a different range or fall back to create_function + replace_body. Requires an open transaction; mutates the overlay only. The new function and the rewritten call site are graph-consistent after commit, so the new function is findable and its call site resolves to it.",
    {
      tx: txHandleSchema,
      parent_id: nodeIdSchema,
      start_index: z.number().int().min(0).describe("Inclusive 0-based index of the first body statement to extract."),
      end_index: z.number().int().min(0).describe("Inclusive 0-based index of the last body statement to extract."),
      name: z.string().min(1).describe("Name of the new function.")
    },
    async (args) => {
      const { renderedByPath, options } = buildAnalysisContext(ctx.db, args.tx as TxHandle);
      const manifest = extract_function(
        ctx.db,
        args.tx as TxHandle,
        args.parent_id,
        args.start_index,
        args.end_index,
        args.name,
        renderedByPath,
        options
      );
      return textResult({ ok: true, ...manifest });
    }
  );

  const moveDeclarationTool = tool(
    "move_declaration",
    "Move an exported top-level declaration (function/class/interface/type/const) from its current module to a different module, and rewrite EVERY importer's import path to point at the new module — all in one operation in the open transaction you pass. You give the declaration's node ID and the target module's node ID; the tool finds all importers through the reference graph and rewrites them (a sole `import { X } from \"old\"` has its path rewritten; a mixed `import { X, Y }` has X split out into a new import from the target). If the source module still uses the symbol, a back-import is added there. You do NOT, and must not, hand-edit importers afterward — they are already rewritten, so editing them yourself double-edits the transaction. The moved declaration gets a new node ID (IDs encode the module); use find_declarations to re-locate it after commit. The tool REFUSES, with a specific reason, moves it cannot do safely: a declaration that references source-local or imported symbols (v1 moves only self-contained declarations — those using just globals, their own internals, or symbols already in the target), a non-exported declaration, a target that already declares the name, or importers that use namespace/default/re-export/dynamic forms. Requires an open transaction; mutates the overlay only.",
    {
      tx: txHandleSchema,
      declaration_id: nodeIdSchema,
      target_module_id: nodeIdSchema
    },
    async (args) => {
      const { renderedByPath, options } = buildAnalysisContext(ctx.db, args.tx as TxHandle);
      const manifest = move_declaration(
        ctx.db,
        args.tx as TxHandle,
        args.declaration_id,
        args.target_module_id,
        renderedByPath,
        options
      );
      return textResult({ ok: true, ...manifest });
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
    async (args) => {
      const tx = args.tx as TxHandle;
      const result = ctx.acceptance
        ? commitWithBehavioralGate(ctx.db, tx, ctx.acceptance)
        : commit(ctx.db, tx);
      // Layer 3: on a successful commit, embed the pattern so future sessions
      // can retrieve it via retrieveSimilarPastTasks. Gated on (a) the commit
      // actually finalized, (b) an embedding provider is bound to this
      // session, and (c) the vec extension is available. Any failure here is
      // best-effort — the commit already succeeded and a memory miss must not
      // surface as a tool error.
      if (
        result.ok &&
        ctx.embeddingProvider &&
        isVecAvailable(ctx.db)
      ) {
        try {
          await embedCommitPattern(ctx.db, tx.id, ctx.embeddingProvider);
          ctx.log?.append({
            type: "commit_pattern_embed",
            ts: Date.now(),
            txId: tx.id,
            ok: true,
            reason: null
          });
        } catch (err) {
          ctx.log?.append({
            type: "commit_pattern_embed",
            ts: Date.now(),
            txId: tx.id,
            ok: false,
            reason: err instanceof Error ? err.message : String(err)
          });
        }
      }
      return textResult(result);
    }
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
    findDeclarationsInModuleTool,
    listModuleExportsTool,
    readTestFileTool,
    semanticSearchTool,
    getReferencesTool,
    readNodeTool,
    beginTransactionTool,
    renameSymbolTool,
    addParameterTool,
    changeReturnTypeTool,
    addImportTool,
    createFunctionTool,
    extractFunctionTool,
    moveDeclarationTool,
    replaceBodyTool,
    validateTool,
    commitTransactionTool,
    rollbackTransactionTool
  ];
}

export const STRATA_TOOL_NAMES = [
  "find_declarations",
  "find_declarations_in_module",
  "list_module_exports",
  "read_test_file",
  "semantic_search",
  "get_references",
  "read_node",
  "begin_transaction",
  "rename_symbol",
  "add_parameter",
  "change_return_type",
  "add_import",
  "create_function",
  "extract_function",
  "move_declaration",
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
