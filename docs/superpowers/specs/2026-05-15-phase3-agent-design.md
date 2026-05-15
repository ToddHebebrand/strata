---
title: "Phase 3 design — the agent drives T03 through the substrate"
date: 2026-05-15
status: draft
authors:
  - todd@olivetech.co
related:
  - ../../../strata-design.md
  - ../../../CLAUDE.md
  - ../../../decisions.md
  - ../../benchmarks.md
  - ./2026-05-14-phase1-rename-symbol-design.md
  - ../plans/2026-05-14-phase1-rename-symbol-plan.md
---

## Summary

Phase 3 of Strata is implemented as a single vertical slice, the same way
Phase 1 was. Phase 1 proved that the `rename_symbol` substrate spine works
when a *unit test* drives it. Phase 3 proves that a *Claude agent* can drive
the same spine: a new `packages/agent` package wraps the existing
store/verify functions as `@anthropic-ai/claude-agent-sdk` in-process tools,
runs a headless agent session against the verbatim T03 benchmark prompt with
**only** Strata structural tools and no filesystem or bash tools, and then
the existing T03 acceptance criteria (the 11 checks in
`packages/cli/src/commands/t03.ts`) are evaluated against the
agent-produced store state.

Programmatic T03 already passes (Phase 1, `decisions.md` 2026-05-15 "Phase 1
verticalizes around `rename_symbol`"). Phase 3 changes one thing: the caller
of `begin → find_declarations → rename_symbol → validate → commit` is now the
model's tool loop, not a hand-written script. Everything else — broadening
the tool set, adding more benchmark tasks, the Claude Code baseline
comparison — is Phase 3.5 / Phase 4 and is explicitly out of scope here.

## Background

**Phase 0/1 state.** Phase 0 proved ingest → SQLite statement nodes →
render → `tsc --noEmit` round-trips without semantic loss. Phase 1
verticalized on `rename_symbol`: identifier-level lowering, a
`node_references` index resolved via the TypeScript `TypeChecker`
(`getChildren` traversal, public APIs only — `decisions.md` 2026-05-15
"BS1 ... `getChildren` traversal"), an in-memory transaction overlay, an
append-only `operations` log, render splicing, and a separate `@strata/verify`
package that owns `validate(db, tx)` plus the validating `commit(db, tx)`
(`store` keeps only `commitWithoutValidate`; Plan amendment A). The
programmatic T03 path in `packages/cli/src/commands/t03.ts` passes all 11
acceptance criteria. BS4 was de-risked: `packages/cli/src/commands/sdkSmoke.ts`
type-checks a real `tool(...)` / `SdkMcpToolDefinition` definition with Zod
schemas for `TxHandle`, `NodeId`, and `Diagnostic[]` (`decisions.md`
2026-05-15 "BS4 cleared with SDK Zod tool schemas").

**Phase 3 in the design doc.** `strata-design.md` § "Phase 3: Agent" calls
for tool definitions registered with the SDK, a system prompt drafted and
iterated, the agent completing simple tasks end-to-end (its worked example
is "add a parameter to function X and update all callers"), and session
logging for observability. § "The Agent" mandates that the agent has **no
file tools** — only Strata tools — and § "System prompt" sets a 2000–4000
token, prompt-cached system prompt covering the structural worldview, the
explore-before-act discipline, the transaction model, and the verification
approach.

**What this spec narrows it to.** One task (T03, the `rename_symbol`
benchmark) driven by a real headless agent loop, plus the minimum SDK
integration and observability that forces into existence. The design doc's
"add a parameter" worked example is *not* the Phase 3 hero — `add_parameter`
does not exist yet (Phase 1.5+, Phase 1 spec § "Out of scope"). T03 is the
hero because it has a proven, 11-check pass/fail acceptance test with
built-in anti-cheat negatives, exactly the property that made it the Phase 1
hero. The narrowing is a phasing choice, not a scope cut: the design doc's
Phase 3 deliverables remain the target; this spec specifies the first
vertical slice through them.

## Approach

Tools-first verticalization, continued. Phase 1 built the substrate spine
around one hero operation. Phase 3 puts a real agent on top of that exact
spine for the exact same operation, changing only the driver.

**Why verticalize on T03 (don't broaden):**

- T03 is a proven acceptance test. The 11 criteria in `t03.ts` already
  encode the substrate's worldview claim: the audit-log string literal
  `"User"` is not a reference, so it is never a rename candidate
  (`auditLiteralUntouched`, `auditLiteralOnlyRemainingUser`); the type-only
  re-export, JSDoc `@param {User}`, namespace import, and
  `Promise<User[]>` generic position must all flip
  (`indexReExportRenamed`, `jsdocReferencesRenamed`,
  `namespaceImportRenamed`, `genericPromiseRenamed`). These are exactly the
  positions a grep-and-replace agent gets wrong. Reusing them as the
  agent's acceptance test means a green run is unambiguous.
- The substrate underneath is already green for this exact task. Any Phase 3
  failure is therefore an *agent-or-SDK-integration* failure, isolated from
  substrate risk. That clean attribution is the whole point of
  verticalizing.
- Breadth multiplies risk without isolating it. Wiring five tools against
  five tasks before one agent loop has ever closed conflates "the model
  can't sequence transactions" with "this particular tool's schema is
  wrong" with "the task is ambiguous." One task, one tool path, one clean
  signal.

**Why not broaden now.** The full 10-task harness and the Claude Code
baseline are the Phase 4 benchmark; building them here would re-derive the
benchmark harness before proving an agent can close even one loop. Adding
mutation tools (`add_parameter`, `extract_function`, …) is Phase 1.5+ —
those operations do not exist in `@strata/store` yet, and inventing them to
give the agent "more to do" reopens settled phasing. Multi-task sessions and
a streaming UI add session-state and presentation surface that T03 does not
need.

## SDK integration

All signatures below are quoted from the **installed** package
`@anthropic-ai/claude-agent-sdk@0.2.118` (`node_modules/@anthropic-ai/
claude-agent-sdk/`, `package.json` `version: "0.2.118"`,
`exports["."].types: "./sdk.d.ts"`). Where the context7 docs
(`/nothflare/claude-agent-sdk-docs`) and the installed types differ, the
installed package wins and the discrepancy is noted.

### Defining in-process tools

`packages/cli/src/commands/sdkSmoke.ts` already uses the real surface and
type-checks. The signature, from `sdk.d.ts:5178`:

```ts
export declare function tool<Schema extends AnyZodRawShape>(
  _name: string,
  _description: string,
  _inputSchema: Schema,
  _handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
  _extras?: {
    annotations?: ToolAnnotations;
    searchHint?: string;
    alwaysLoad?: boolean;
  }
): SdkMcpToolDefinition<Schema>;
```

`SdkMcpToolDefinition` (`sdk.d.ts:2867`):

```ts
export declare type SdkMcpToolDefinition<Schema extends AnyZodRawShape = AnyZodRawShape> = {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>;
};
```

Key facts the downstream plan can rely on:

- `_inputSchema` is a **Zod raw shape** (`AnyZodRawShape = ZodRawShape |
  ZodRawShape_2`, `sdk.d.ts:114`) — a plain object whose values are Zod
  schemas, *not* a wrapped `z.object(...)`. The smoke harness passes
  `findDeclarationsInputSchema` as `{ tx: txHandleSchema.optional(), name:
  z.string().optional(), … }`. Phase 3 tools follow that exact shape.
- The handler returns `Promise<CallToolResult>`. The smoke harness returns
  `{ content: [{ type: "text" as const, text: "[]" }] }`. Strata tools
  return their structured result JSON-stringified inside a single
  `{ type: "text", text }` content block (see § "Tool definitions").
- Zod version: the repo pins `zod@4.4.3` (root `package.json`
  `devDependencies`). The smoke harness imports from `"zod/v4"`; Phase 3
  tools do the same for consistency. The SDK declares `zod` `^4.0.0` as a
  peer dependency (`node_modules/@anthropic-ai/claude-agent-sdk/
  package.json` `peerDependencies`).

### Building the tool server

`createSdkMcpServer` (`sdk.d.ts:421`) bundles tool definitions into an
in-process MCP server config:

```ts
export declare function createSdkMcpServer(
  _options: CreateSdkMcpServerOptions
): McpSdkServerConfigWithInstance;

declare type CreateSdkMcpServerOptions = {
  name: string;
  version?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
};
```

`McpSdkServerConfigWithInstance` (`sdk.d.ts:942`) is
`McpSdkServerConfig & { instance: McpServer }` — "Not serializable -
contains a live McpServer object", which is exactly what an in-process tool
server needs. It is one of the members of the `McpServerConfig` union
(`sdk.d.ts:949`) that `Options.mcpServers` accepts.

### Running a headless session and restricting tools

`query` (`sdk.d.ts:2155`):

```ts
export declare function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
```

`Query` (`sdk.d.ts:1950`) `extends AsyncGenerator<SDKMessage, void>` — the
session is consumed by `for await (const message of query({...}))`. It also
exposes `interrupt()`, `setPermissionMode()`, `setModel()` for streaming
input mode; Phase 3 only needs the async-iteration surface plus
`interrupt()` as a hard-stop on the iteration cap.

Relevant `Options` fields (`sdk.d.ts:1118` onward), quoted:

- `mcpServers?: Record<string, McpServerConfig>` (`sdk.d.ts:1415`). Keys
  are server names. Phase 3 registers one server, e.g.
  `mcpServers: { strata: strataServer }`.
- `allowedTools?: string[]` (`sdk.d.ts:1169`) — "List of tool names that
  are auto-allowed without prompting for permission … To restrict which
  tools are available, use the `tools` option instead." SDK MCP tools are
  addressed as `mcp__<serverName>__<toolName>` (confirmed by the context7
  custom-tools guide: `"mcp__my-custom-tools__get_weather"`). Phase 3 sets
  `allowedTools` to the eight `mcp__strata__*` names so each tool runs
  without a permission prompt.
- `tools?: string[] | { type: 'preset'; preset: 'claude_code' }`
  (`sdk.d.ts:1196`) — "Specify the base set of available **built-in**
  tools. … `[]` (empty array) - Disable all built-in tools." **This is the
  load-bearing knob for the CLAUDE.md "no filesystem tools" invariant.**
  Phase 3 sets `tools: []` so Read/Write/Edit/Bash/Glob/Grep are removed
  entirely; the agent's only callable tools are the MCP-registered Strata
  tools.
- `disallowedTools?: string[]` (`sdk.d.ts:1189`) — "removed from the
  model's context and cannot be used." Used defensively as a belt-and-
  braces deny-list of the built-in file/bash tool names in addition to
  `tools: []`, in case a future SDK version reintroduces a default tool
  surface.
- `permissionMode?: PermissionMode` (`sdk.d.ts:1446`); `PermissionMode =
  'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' |
  'auto'` (`sdk.d.ts:1755`). Phase 3 uses `'bypassPermissions'` so the
  headless run never blocks on a prompt. The SDK requires
  `allowDangerouslySkipPermissions?: boolean` (`sdk.d.ts:1458`) be `true`
  when `permissionMode: 'bypassPermissions'` ("safety measure to ensure
  intentional bypassing"). Both are set. The agent still cannot touch the
  filesystem because the file tools do not exist in its surface
  (`tools: []`), so `bypassPermissions` only bypasses prompts for the
  Strata tools.
- `maxTurns?: number` (`sdk.d.ts:1385`) — "Maximum number of conversation
  turns before the query stops." Phase 3 sets a bounded cap (proposed
  default 25, tunable) so a non-converging run terminates deterministically
  and surfaces BS-A rather than looping.
- `model?: string` (`sdk.d.ts:1420`) — examples `'claude-sonnet-4-6'`,
  `'claude-opus-4-7'`. Phase 3 pins one model explicitly so runs are
  comparable and the Phase 4 baseline can match it.
- `systemPrompt?: string | string[] | { type: 'preset'; preset:
  'claude_code'; append?: string; excludeDynamicSections?: boolean }`
  (`sdk.d.ts:1693`). Phase 3 passes a **plain string** (the custom Strata
  worldview prompt) — *not* the `claude_code` preset, which would carry
  Claude Code's file-centric instructions. For prompt caching across runs,
  the `string[]` form with the exported `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`
  constant (`export declare const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"`, `sdk.d.ts:5110`; documented at
  `sdk.d.ts:1665` "@example Custom prompt with cache boundary") is available
  if the prompt
  later grows a dynamic tail; Phase 3's prompt is fully static so a single
  string is sufficient and is itself cacheable.
- `abortController?: AbortController` (`sdk.d.ts:1123`) — used to enforce a
  wall-time ceiling independent of `maxTurns`.
- `stderr?: (data: string) => void` (`sdk.d.ts:1630`) — captured into the
  session log for debugging.

### Capturing the transcript and usage

The iteration yields `SDKMessage` (`sdk.d.ts:2901`), a wide union. Phase 3
consumes three members:

- `SDKAssistantMessage` (`sdk.d.ts:2264`): `{ type: 'assistant'; message:
  BetaMessage; parent_tool_use_id: string | null; uuid; session_id }`. Tool
  calls are `tool_use` content blocks inside `message.content`; tool
  results arrive as `SDKUserMessage` (`sdk.d.ts:3389`,
  `tool_use_result?: unknown`) on the following turn. The per-tool-call log
  is built by pairing `tool_use` blocks with their `tool_use_result`.
- `SDKResultMessage` (`sdk.d.ts:3051`) `= SDKResultSuccess |
  SDKResultError`. `SDKResultSuccess` (`sdk.d.ts:3053`): `{ type:
  'result'; subtype: 'success'; duration_ms; duration_api_ms; num_turns;
  result: string; total_cost_usd: number; usage: NonNullableUsage;
  modelUsage: Record<string, ModelUsage>; … }`. `SDKResultError`
  (`sdk.d.ts:3032`): `subtype: 'error_during_execution' |
  'error_max_turns' | 'error_max_budget_usd' |
  'error_max_structured_output_retries'`, plus `errors: string[]`. This is
  the single source for tokens, cost, turn count, and wall time.
  `ModelUsage` (`sdk.d.ts:1079`) carries `inputTokens`, `outputTokens`,
  `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`,
  `contextWindow`, `maxOutputTokens` — enough to record prompt-cache hit
  rate, which matters for the system-prompt-caching claim and for BS-C.
- `SDKSystemMessage` (`sdk.d.ts:3262`, a member of the `SDKMessage` union
  at `sdk.d.ts:2901`): `{ type: 'system'; subtype: 'init'; … cwd: string;
  tools: string[]; mcp_servers: { name: string; status: string }[]; model:
  string; permissionMode: PermissionMode; … }`. The `tools` and
  `mcp_servers` fields are present directly in the installed types (not
  only in the context7 reference). Phase 3 asserts on this at session
  start: the reported tool list must contain the eight `mcp__strata__*`
  names and **no** built-in file/bash tools. This is the programmatic guard
  that the CLAUDE.md "no filesystem tools" invariant actually held at
  runtime, not just in config.

### Installed-vs-docs discrepancies

- **Streaming-input requirement for custom tools.** The context7
  custom-tools guide states custom MCP tools "require streaming input" —
  the `prompt` must be an async generator, "a simple string prompt will
  not work." The installed `query` signature (`sdk.d.ts:2155`) types
  `prompt: string | AsyncIterable<SDKUserMessage>` and does not encode that
  constraint in the type. **Resolution: follow the docs, trust the
  installed runtime.** Phase 3 supplies the T03 prompt via a single-yield
  async generator (`async function* () { yield { type: "user", message: {
  role: "user", content: <T03 prompt> } }; }`), matching every context7
  example that registers `mcpServers`. The plan must validate at
  implementation time that a plain string prompt with custom tools is in
  fact rejected/ignored; if the installed runtime accepts a string, prefer
  the simpler form but keep the generator as the documented-safe default.
  (This is an installed-types-vs-docs gap, not a contradiction: the type
  is permissive, the docs add a runtime constraint the type cannot
  express.)
- **`tools: []` vs `allowedTools`.** The context7 overview shows
  restricting an agent via `allowedTools: ["Read", "Glob", "Grep"]` and
  `permissionMode: "bypassPermissions"` *without* setting `tools: []`. The
  installed `Options.tools` doc (`sdk.d.ts:1196`) is explicit that `[]`
  disables **all built-in tools** and that `allowedTools` only governs
  auto-approval, not availability ("To restrict which tools are available,
  use the `tools` option instead", `sdk.d.ts:1167`). **Resolution: trust
  the installed types** — Phase 3 sets `tools: []` for hard removal of the
  built-in surface and uses `allowedTools` only to auto-approve the eight
  Strata tools. Relying on `allowedTools` alone would leave file tools
  available-but-unapproved rather than absent, which is weaker than the
  CLAUDE.md invariant requires.
- No other disagreements found: `tool`, `createSdkMcpServer`,
  `mcpServers`, the `mcp__server__tool` naming, and the `SDKResultMessage`
  usage shape all agree between the installed `sdk.d.ts` and context7.

## Acceptance test

T03 from `docs/benchmarks.md` § T03, driven by the agent, scored by the
existing 11 criteria.

**What we test.** Ingest `examples/medium/` into an in-memory db exactly as
`packages/cli/src/commands/t03.ts` does today (`collectTsFiles(srcRoot)` →
`ingestBatch(modules)` → `openDb(":memory:")` → `insertNodes` +
`insertReferences`). Construct the Strata SDK tool server over **that db
handle**, build the system prompt, and run a headless `query(...)` session
with the **verbatim T03 prompt** from `docs/benchmarks.md` § T03 ("Rename
the exported interface `User` (defined in `src/types/user.ts`) to
`Account` everywhere it is referenced as a type, including type-only
re-exports and JSDoc. Leave unrelated string literals with the value
`"User"` … untouched. The full test suite must pass."). The agent must,
through its tool loop, locate the `User` interface declaration, open a
transaction, call `rename_symbol`, `validate`, and `commit` — the same
sequence `t03.ts` performs programmatically, but selected and ordered by
the model.

**Success criteria.** After the session ends, the existing 11 T03 criteria
(the `RunT03Result["criteria"]` object in `t03.ts`:
`commitReturnedOk`, `validateAfterCommitClean`, `importRenamed`,
`typeAnnotationRenamed`, `genericPromiseRenamed`, `namespaceImportRenamed`,
`auditLiteralUntouched`, `auditLiteralOnlyRemainingUser`,
`indexReExportRenamed`, `jsdocReferencesRenamed`, `operationRowAppended`)
are evaluated against the **agent-produced store state** and **all 11 must
be true**. The criteria logic is not reimplemented; `t03.ts` is refactored
so the criteria evaluation (the block that renders every module, counts
`\bUser\b` occurrences, and inspects the `operations` row) is a pure
function `evaluateT03Criteria(db, batch, srcRoot): RunT03Result["criteria"]`
exported from a shared location both the programmatic command and the agent
acceptance test import. (Refactor note for the plan: extract the
post-commit scoring block of `runT03` verbatim into that function; the
programmatic `runT03` keeps driving the rename itself and calls the
extracted scorer, so the existing CLI behavior is unchanged.)

In addition to the 11, the agent test asserts the **runtime invariant
guard**: the `SDKSystemMessage` `init` tool list contains exactly the eight
`mcp__strata__*` tools and no built-in file/bash tool, and the
`SDKResultMessage` is `subtype: 'success'`.

**Determinism / API-key gating.** The session makes a live model call, so
the test:

1. Is gated on an API key. The test is `describe.skipIf(!process.env
   .ANTHROPIC_API_KEY)` (or `CLAUDE_CODE_OAUTH_TOKEN` if the SDK auth path
   used in the repo differs — confirm during implementation). With no key
   it is skipped, not failed, so `pnpm -r test` stays green in CI without
   secrets.
2. Pins `model` explicitly and sets `maxTurns` and an `abortController`
   wall-time ceiling so a non-converging run fails fast and
   deterministically rather than hanging.
3. Proposes a **recorded-transcript replay mode** as the determinism
   answer (Open Question 2): the session loop is structured so the message
   stream can be (a) produced live from `query(...)` or (b) replayed from
   a captured JSON-lines transcript fixture. The acceptance assertions run
   identically against either source — they only read the final store
   state and the parsed transcript, never the network. A live run with
   `--record` writes the fixture; CI without a key replays it. This makes
   the *substrate outcome* deterministic (store state is a pure function
   of the tool-call sequence) while keeping a real live run as the source
   of truth. Commit to validating the replay approach during
   implementation: if the captured transcript cannot be cleanly replayed
   through the same tool handlers (e.g. the SDK couples transcript replay
   to its own session store), fall back to a key-gated live-only test with
   a small retry budget and record that in `decisions.md`.

**Out of scope for the acceptance test.** Comparing tokens/time against
Claude Code (Phase 4). Multiple trials and distributions (Phase 4). Any
task other than T03.

## What it forces us to build

Everything below is in scope for Phase 3 only because the agent-driven T03
loop requires it. All of it lives in the new `packages/agent`.

### 1. SDK tool definitions over the shared store/verify functions

Eight tools, each a `tool(name, description, zodRawShape, handler)`
definition, bundled by `createSdkMcpServer({ name: "strata", version,
tools: [...] })`. All handlers close over **one shared `{ db, actor }`
session context** so transactions opened by one tool call are visible to
the next. Handlers return `{ content: [{ type: "text", text:
JSON.stringify(result) }] }`.

| Tool (`mcp__strata__…`) | Wraps | Notes |
|---|---|---|
| `find_declarations` | `find_declarations(db, { name?, kind? })` from `@strata/store` | Read-only. Returns declaration node id/kind/name. The agent's entry point: find the `User` interface. |
| `get_references` | `get_references(db, declaration_id)` from `@strata/store` | Read-only. Lets the agent inspect the reference set before mutating (explore-before-mutate). |
| `read_node` | a thin `@strata/store` helper | **Not yet exported.** `@strata/store` exposes `findNodeById` and `listChildren` (`packages/store/src/index.ts`); `read_node` is a small wrapper returning a node plus optional shallow children. Flagged for the plan to add a `read_node`/`readNode` export to `@strata/store` rather than reaching into internals from `agent`. Whether the agent actually needs it is Open Question 1 — ship it minimal, let behavior decide. |
| `begin_transaction` | `begin(db, actor)` from `@strata/store` | Returns the `TxHandle`. The agent must hold and pass it to subsequent mutation/validate/commit calls. |
| `rename_symbol` | `rename_symbol(db, tx, declaration_id, new_name)` from `@strata/store` | Requires an open tx. Mutates overlay only. |
| `validate` | `validate(db, tx)` from `@strata/verify` | Returns `Diagnostic[]`. The verify-before-commit tool. |
| `commit_transaction` | the validating `commit(db, tx)` from `@strata/verify` | Runs `validate`; on clean, finalizes; returns `{ ok } \| { ok:false, diagnostics }`. |
| `rollback_transaction` | `rollback(db, tx)` from `@strata/store` | Discards the overlay; lets the agent recover from a failed validate. |

The agent does **not** get filesystem, bash, glob, grep, or web tools
(`tools: []` + defensive `disallowedTools`). The tool *descriptions* are
part of the agent's worldview (CLAUDE.md working-style note) and are written
as if explaining the operation to another developer — high-level intent
("rename this declaration and every reference to it"), not AST mechanics.

`TxHandle` shape: Phase 1's `TxHandle` (`@strata/store`, exported from
`packages/store/src/index.ts`) is the canonical type; the BS4 smoke modeled
it as `{ id: string; actor: string }`. The Zod raw-shape for tool inputs
that take a transaction mirrors the smoke harness
(`txHandleSchema`/`nodeIdSchema`/`diagnosticSchema` in `sdkSmoke.ts`) — the
plan reuses those schema fragments rather than reinventing them.

### 2. Session orchestrator (`packages/agent/src/session.ts`)

A single function (proposed `runAgentT03({ corpusRoot, model, maxTurns,
wallTimeMs, transcript? }): Promise<AgentT03Result>`) that:

1. Ingests `examples/medium` into an in-memory db **using the exact
   `ingestBatch` + `insertNodes` + `insertReferences` sequence
   `t03.ts` uses** (shared with the refactor in § "Acceptance test" so
   ingest cannot drift between the programmatic and agent paths).
2. Builds the Strata SDK tool server over that db and an `actor` string
   (e.g. `"agent-t03"`, mirroring `t03.ts`'s `"t03"` actor convention).
3. Builds the system prompt (§ "System prompt outline").
4. Calls `query({ prompt: <single-yield async generator of the verbatim
   T03 prompt>, options: { mcpServers: { strata }, allowedTools:
   [...8 names], tools: [], disallowedTools: [...file/bash names],
   permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions:
   true, systemPrompt, model, maxTurns, abortController, stderr } })`.
5. Iterates the `Query` async generator, writing the session log
   (§ "Session logging format") and pairing `tool_use` blocks with their
   `tool_use_result`.
6. On `SDKResultMessage`, records usage/cost/turns/wall-time and stops.
7. Returns the final db handle (or the evaluated criteria) plus the parsed
   transcript and metrics, so the acceptance test can call
   `evaluateT03Criteria(db, batch, srcRoot)`.

The orchestrator owns the `abortController` wall-time timer and the
`maxTurns` cap; if either trips, it records the terminal reason and lets the
acceptance test fail with a BS-A / BS-C-relevant message rather than
hanging.

### 3. System prompt (`packages/agent/src/prompt.ts`)

A static string, target 2000–4000 tokens, exported as a constant and
designed to be prompt-cacheable (a single static string is cacheable as-is;
the `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` `string[]` form is held in reserve if a
dynamic tail is ever added). Section outline and the load-bearing
behavioral instructions are in § "System prompt outline" — the spec gives
the skeleton, not the final 4000-token text (that is written and iterated
during implementation, per `strata-design.md` § "Phase 3").

### 4. Session logging

JSON-lines, one event per line, written to a run-scoped file (and
returned in-memory for the test). Schema in § "Session logging format".
Every tool call (name, args, result summary, error), token usage, and wall
time are captured for observability now and Phase 4 metrics later.

## Package / file layout

New package `packages/agent`, mirroring the existing package shape
(`store`, `verify`, `cli` all follow: `package.json` with
`@strata/<name>`, `main`/`types` → `dist`, `tsconfig.json` extending
`../../tsconfig.base.json` with `composite: true`, `src/`, `tests/`). The
pnpm `packages/*` glob (`pnpm-workspace.yaml`) already includes it; no
workspace-config change is needed beyond creating the directory.

```
packages/agent/
├── package.json          # name "@strata/agent"; deps below
├── tsconfig.json         # extends ../../tsconfig.base.json; references store, verify, ingest, render
├── src/
│   ├── index.ts          # barrel: runAgentT03, tool factory, prompt, log types
│   ├── tools.ts          # the 8 tool(...) definitions + createSdkMcpServer wrapper
│   ├── prompt.ts         # STRATA_SYSTEM_PROMPT constant
│   ├── session.ts        # runAgentT03 orchestrator + query() loop + transcript pairing
│   └── log.ts            # JSON-lines session log writer + event types
└── tests/
    └── agentT03.test.ts  # describe.skipIf(no key) live run; replay-mode fixture variant
```

**Dependency edges (acyclic; agent is a top-level leaf consumer):**

- `@strata/agent` **depends on** `@strata/store` (begin, find_declarations,
  get_references, rename_symbol, rollback, findNodeById/listChildren for
  `read_node`, TxHandle), `@strata/verify` (validate, validating commit),
  `@strata/ingest` (ingestBatch), and `@strata/render` (only transitively
  via verify; a direct dep is only added if the agent ever renders for a
  read tool — not in Phase 3). It also depends on
  `@anthropic-ai/claude-agent-sdk` and `zod` (use `zod/v4`, matching
  `sdkSmoke.ts` and the root `zod@4.4.3` pin).
- **Nothing depends on `@strata/agent`.** `store`, `ingest`, `render`,
  `verify` do not import `agent`. This preserves the layering in
  `strata-design.md` § Architecture (agent sits above the tool layer) and
  the Plan-amendment-A acyclic-edges discipline (`verify → store`,
  `verify → render`; now `agent → {store, verify, ingest}`).
- `package.json` deps: `@strata/store`, `@strata/verify`,
  `@strata/ingest` as `workspace:*`; `@anthropic-ai/claude-agent-sdk` and
  `zod` as regular deps (the SDK and zod are currently root
  `devDependencies` for the BS4 smoke; Phase 3 promotes them into
  `@strata/agent`'s own `dependencies` since the package genuinely ships
  against them — note for the plan to add them there).
- `tsconfig.json` `references`: `../store`, `../verify`, `../ingest`
  (mirror `packages/cli/tsconfig.json`'s `references` pattern; note that
  `cli` currently lists `ingest/render/store` but not `verify` in
  `references` despite depending on it — the agent's tsconfig should list
  `verify` so project-references builds are correct).

## System prompt outline

Static, 2000–4000 tokens, cacheable. Sections, in order, with the
load-bearing instructions per section:

1. **Identity and substrate worldview.** "You operate on a TypeScript
   codebase represented as a graph of nodes, not as files. There is no
   filesystem. You cannot open, read, write, or grep files. Every code
   element — declarations, references, statements — is a node with a stable
   ID. You act only through the Strata tools."
2. **The graph model.** Nodes have ids, kinds, payloads; declarations have
   identifier children; references are edges from a use-site identifier to
   its declaration. A string literal that happens to spell a name is **not**
   a reference and is never a rename candidate (this sentence directly
   targets the `auditLiteralUntouched` criterion — it teaches the worldview
   that wins T03, without scripting the task).
3. **The transaction model.** Mutations require an open transaction. The
   lifecycle is strictly: `begin_transaction` → (explore) → mutate →
   `validate` → `commit_transaction`. A transaction must be committed or
   rolled back; never leave one open. `commit_transaction` runs validation
   itself and refuses to finalize if there are diagnostics.
4. **Explore before mutate.** Queries (`find_declarations`,
   `get_references`, `read_node`) are cheap and have no side effects.
   Mutations are commitments. Locate the declaration and inspect its
   references *before* renaming. Do not guess node IDs.
5. **Verify before commit.** After a mutation, call `validate`. If it
   returns diagnostics, do not commit — inspect the diagnostics (they carry
   node IDs), decide whether to mutate further or `rollback_transaction`,
   and try again. A clean `validate` then `commit_transaction`.
6. **The tool surface.** One-line intent description per tool, naming the
   eight tools and their ordering dependency (you need a `TxHandle` from
   `begin_transaction` before `rename_symbol`/`validate`/`commit`).
7. **One worked pattern (rename).** A short, generic narration of the
   canonical loop — "to rename a declaration: find it, read its references
   to confirm scope, begin a transaction, rename_symbol, validate, and if
   clean, commit" — phrased as a *pattern*, not as T03's answer. It must
   not name `User`/`Account` or hardcode the sequence as a script; BS-A
   specifically tests that a *reasonable* worldview prompt, not a
   disguised script, gets the model to form the sequence.
8. **Failure discipline.** If validation keeps failing, prefer
   `rollback_transaction` and reassessment over thrashing. Never fabricate
   a result. If you cannot proceed with the available tools, say so plainly
   rather than inventing a filesystem.

Explicit non-goals for the prompt: no T03-specific identifiers, no
step-by-step "call tool X then tool Y then tool Z" script, no embedded
acceptance criteria. The prompt is iterated during implementation; this
outline is the contract for *what it must cover*, not its final wording.

## Session logging format

JSON-lines (`.jsonl`), one object per line, append-only, run-scoped
filename (e.g. `agent-t03-<sessionId>.jsonl`). Also returned in-memory so
the acceptance test asserts on it without filesystem reads. One event per
line, discriminated by `type`:

```jsonc
// session start
{ "type": "session_start", "ts": <epoch ms>, "model": "...",
  "maxTurns": 25, "task": "T03", "actor": "agent-t03" }

// runtime invariant guard, from SDKSystemMessage init
{ "type": "init", "ts": ..., "tools": ["mcp__strata__find_declarations", ...],
  "mcpServers": [{ "name": "strata", "status": "..." }] }

// one per tool call, tool_use paired with its tool_use_result
{ "type": "tool_call", "ts": ..., "tool": "rename_symbol",
  "args": { "...": "..." },
  "result_summary": "ok | <short>", "ok": true,
  "error": null, "durationMs": <n>, "turn": <n> }

// per-turn assistant text (truncated) for debugging the reasoning trail
{ "type": "assistant_text", "ts": ..., "turn": <n>, "text": "<truncated>" }

// terminal, from SDKResultMessage
{ "type": "result", "ts": ..., "subtype": "success | error_max_turns | ...",
  "numTurns": <n>, "durationMs": <n>, "durationApiMs": <n>,
  "totalCostUsd": <n>,
  "usage": { "inputTokens": <n>, "outputTokens": <n>,
             "cacheReadInputTokens": <n>, "cacheCreationInputTokens": <n> },
  "modelUsage": { "<model>": { "...": "..." } },
  "errors": [] }
```

Field provenance is the installed SDK: `usage`/`modelUsage`/
`total_cost_usd`/`num_turns`/`duration_ms`/`duration_api_ms` from
`SDKResultSuccess` (`sdk.d.ts:3053`), per-model token + cache fields from
`ModelUsage` (`sdk.d.ts:1079`). `result_summary` is a short, bounded
stringification of the tool handler's return (never the full rendered
module) so logs stay small. This format is the Phase 4 metrics substrate:
tokens, wall time, tool-invocation count, and failure/retry count are all
derivable from it.

## Out of scope

Explicit deferrals:

- The full 10-task benchmark harness (`docs/benchmarks.md` T01–T10) —
  Phase 4.
- The Claude Code baseline configuration and the substrate-vs-baseline
  comparison — Phase 4.
- Additional mutation tools (`add_parameter`, `extract_function`,
  `replace_body`, `inline_function`, `create_function`, `delete_node`,
  `add_import`, `move_declaration`) — they do not exist in `@strata/store`
  (Phase 1 spec § "Out of scope"); Phase 1.5+.
- Additional query tools beyond the minimal set (`get_callsites`,
  `trace_path`, `get_type_info`, `list_module_exports`,
  general-predicate `find_nodes`) — added only if agent behavior in Phase 3
  shows the minimal set is insufficient (Open Question 1).
- `run_tests` as a tool — Phase 1 ships `validate` only; rendered-test
  execution is Phase 2/4.
- Multi-task / multi-turn-task sessions, session resume, the
  `unstable_v2_*` session API (`sdk.d.ts:5246`) — single T03 run only.
- Any streaming/interactive UI or progress rendering.
- Distribution statistics, trials-per-task, quality rubric — Phase 4.
- Anything multi-language; anything that makes files first-class to the
  agent.

## Bail signals

Exit criteria for "stop and surface, don't work around." Same rigor as the
Phase 1 spec's bail signals. A surfaced wall is more valuable than a
papered-over one. Each maps to the Phase 1 plan's bail-signal convention
(log the observation in the task that surfaces it, append newest-first to
`decisions.md`).

### BS-A — agent ergonomics: no reasonable prompt produces the correct sequence

If, after a bounded number of iterations on the system prompt (the prompt
is *allowed* to be iterated — `strata-design.md` § Phase 3 — but only as a
worldview, not as a script), the model cannot reliably form the
explore → `rename_symbol` → `validate` → `commit` sequence — e.g. it
persistently tries to read or grep files despite having no file tools, it
cannot hold and thread a `TxHandle` across calls, it commits without
validating, or it cannot recover from a failed `validate` via
`rollback_transaction` — that is a **substrate-agent-fit finding**. Stop and
surface it. Do **not** degrade the prompt into a hard-coded
"call tool A, then B, then C" recipe to force a green run; a scripted prompt
passing T03 proves nothing about whether an agent can drive the substrate.
The threshold: if the only way to pass is to remove the model's agency, the
finding is "the substrate's tool surface is not yet agent-legible," and
that is the result.

### BS-B — SDK integration: headless custom-tool loop won't compose

If the SDK cannot run headless with purely custom in-process tools and no
built-in tools (`tools: []` not honored, built-in tools leak into the
`init` tool list, the MCP server instance not invoked in-process), or its
tool loop does not compose with the transactional model (e.g. tool-call
results are not delivered back such that a later call can use a `TxHandle`
from an earlier call; the streaming-input requirement makes a stable single
prompt impossible), that is a bail signal. BS4 already de-risked the *tool
schema* (`decisions.md` 2026-05-15 "BS4 cleared"); BS-B is specifically
about the **session/loop**, which BS4 did not exercise. Surface it; do not
work around by shelling out, faking the loop, or pre-applying the mutation
outside the agent.

### BS-C — cost / latency: one agent T03 run is absurdly expensive

If a single agent T03 run costs an extreme number of tokens or wall-clock
time relative to a file-based edit of the same rename, **record it** — this
is a primary Phase 4 benchmark signal, not automatically a stop. It is a
hard bail only if the cost is so extreme that the substrate-efficiency
thesis is dead on arrival (e.g. orders of magnitude worse with no plausible
path to parity even after prompt-cache and tool-granularity tuning). The
`SDKResultMessage` usage/cost fields and the session log make this
measurable from run one; capture it every run regardless.

## Open questions

Deliberately unresolved; answered by what implementation observes, not
pre-decided on paper.

### 1. Is the minimal query tool set enough to navigate?

The agent gets `find_declarations`, `get_references`, and `read_node`.
T03's seed has the renamed symbol reachable directly by name, so
`find_declarations({ name: "User", kind: "interface" })` may be all the
exploration the model needs. But the model may flounder without richer
navigation (`list_module_exports`, a broader `read_node` depth, callsite
listing). **Approach:** ship the minimal three, instrument tool-call
patterns in the session log, and let observed agent behavior — not
speculation — decide whether to add tools. If the model repeatedly fails to
locate the declaration or repeatedly asks for context it cannot get,
that's the signal to widen (and a candidate BS-A observation). Recommended
default: start minimal; treat tool additions as a logged decision driven by
transcript evidence.

### 2. How deterministic can a live-model acceptance test be?

A live model call is nondeterministic. **Proposed approach (commit to
validating during implementation):** structure the session loop so the
`SDKMessage` stream is sourced either live from `query(...)` or replayed
from a recorded JSON-lines transcript fixture; acceptance assertions read
only the final store state and parsed transcript, never the network. CI
without a key replays the fixture (deterministic); a key-gated `--record`
run regenerates it from a real session. The substrate outcome is then a
pure function of the tool-call sequence and is fully deterministic; only
fixture regeneration touches the model. **Fallback** if transcript replay
cannot be cleanly threaded through the same tool handlers (the SDK may
couple replay to its own session store): a key-gated, live-only test with a
small retry budget (e.g. up to 3 attempts, pass if any attempt yields all
11 criteria), pinned `model`, `maxTurns`, and `abortController` ceiling —
and log that divergence in `decisions.md`. Recommendation: attempt
replay-mode first; it is the only approach that keeps CI deterministic
without secrets.

## Suggested build order

A suggestion, not a prescription. Resequence if a different order surfaces
problems earlier.

1. **Refactor T03 scoring into a shared pure function.** Extract the
   post-commit scoring block of `runT03` (`t03.ts`) into
   `evaluateT03Criteria(db, batch, srcRoot)`; rewire the programmatic
   command to call it. Confirm `pnpm -r test` still green (existing T03
   behavior unchanged). This de-risks the refactor before any agent code.
2. **Scaffold `packages/agent`.** `package.json`, `tsconfig.json`
   (references store/verify/ingest), `src/index.ts` barrel. Promote
   `@anthropic-ai/claude-agent-sdk` + `zod` into the package's deps.
3. **`src/tools.ts`.** The eight `tool(...)` definitions over a shared
   `{ db, actor }` context + `createSdkMcpServer`. Add the
   `read_node`/`readNode` export to `@strata/store` (thin
   `findNodeById` + `listChildren` wrapper). Unit-test the handlers
   directly (no model) against the same in-memory db as `t03.ts` — this
   exercises the whole spine through the tool layer without an API key and
   can surface BS-B schema/loop-shape issues early.
4. **`src/prompt.ts`.** Draft the system prompt to the § "System prompt
   outline" contract.
5. **`src/log.ts`.** The JSON-lines event types + writer.
6. **`src/session.ts`.** `runAgentT03`: ingest-as-t03, build server +
   prompt, `query(...)` with the locked options (`tools: []`,
   `allowedTools` 8 names, `bypassPermissions` +
   `allowDangerouslySkipPermissions`, `maxTurns`, `abortController`,
   `stderr`), iterate, log, pair tool_use/tool_use_result, capture result.
   Assert the `init` runtime-invariant guard here.
7. **`tests/agentT03.test.ts`.** `describe.skipIf(no key)` live run
   asserting all 11 criteria via `evaluateT03Criteria` + the runtime
   guard; add the replay-mode variant once a fixture is recorded.
8. **Record a transcript fixture** from one successful live run; wire the
   replay path; confirm replay reproduces all 11 criteria deterministically.
9. **Bail-signal sweep.** Record BS-C cost/latency from the first live run
   regardless of outcome; if BS-A or BS-B fired, stop and append a
   `decisions.md` entry instead of proceeding.

Each step is independently testable. Steps 1–5 and 8's replay assertions
need no API key; only steps 6–7's live path and the fixture recording in 8
do.

## Glossary

- **Session.** One `query(...)` invocation: the agent loop over the T03
  prompt against the Strata tool server, from `session_start` to the
  terminal `SDKResultMessage`.
- **Tool server.** The `McpSdkServerConfigWithInstance` produced by
  `createSdkMcpServer` over the eight Strata `tool(...)` definitions,
  registered via `Options.mcpServers: { strata: ... }`. In-process; not
  serializable.
- **Strata tool.** A `SdkMcpToolDefinition` wrapping one store/verify
  function, addressed by the model as `mcp__strata__<name>`.
- **Shared session context.** The `{ db, actor }` object every tool
  handler closes over, so a `TxHandle` from `begin_transaction` is usable
  by later `rename_symbol`/`validate`/`commit_transaction` calls.
- **Runtime invariant guard.** The assertion, from the `SDKSystemMessage`
  `init` message, that the agent's actual tool list is exactly the eight
  `mcp__strata__*` tools and contains no built-in file/bash tool — the
  programmatic proof that CLAUDE.md's "no filesystem tools" invariant held
  at runtime.
- **Replay mode.** Driving the acceptance assertions from a recorded
  JSON-lines transcript instead of a live model call, so CI is
  deterministic and key-free.
- **Acceptance criteria.** The 11-field `RunT03Result["criteria"]` object
  from `t03.ts`, evaluated by the shared `evaluateT03Criteria` pure
  function against the agent-produced store state. All 11 must be true.
