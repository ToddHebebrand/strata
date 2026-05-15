import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  query,
  type Options,
  type SDKMessage,
  type SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import { ingestBatch } from "@strata/ingest";
import {
  begin,
  insertNodes,
  insertReferences,
  openDb,
  rollback,
  type Db,
  type TxHandle
} from "@strata/store";
import {
  emptyT03Criteria,
  evaluateT03Criteria,
  validate,
  type T03Criteria
} from "@strata/verify";
import { SessionLog } from "./log";
import { STRATA_SYSTEM_PROMPT } from "./prompt";
import {
  createStrataToolServer,
  createStrataTools,
  STRATA_QUALIFIED_TOOL_NAMES,
  STRATA_SERVER_NAME,
  type StrataSessionContext
} from "./tools";

/** A single-yield async generator carrying one user prompt. */
export async function* singlePrompt(
  text: string
): AsyncGenerator<SDKUserMessage, void> {
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: text }
  } as SDKUserMessage;
}

export interface CollectedSession {
  /** The SDKSystemMessage.init tools list, if an init message was seen. */
  initTools?: string[];
  initMcpServers?: { name: string; status: string }[];
  /** Every message, in order, for assertions/replay. */
  messages: SDKMessage[];
}

/**
 * Drive query() to completion, collecting messages and the init tool list.
 * The caller owns maxTurns and abortController bounds in options.
 */
export async function collectSession(params: {
  prompt: string;
  options: Options;
}): Promise<CollectedSession> {
  const collected: CollectedSession = { messages: [] };
  for await (const message of query({
    prompt: singlePrompt(params.prompt),
    options: params.options
  })) {
    collected.messages.push(message);
    if (message.type === "system" && message.subtype === "init") {
      collected.initTools = message.tools;
      collected.initMcpServers = message.mcp_servers;
    }
  }
  return collected;
}

export interface ReplayStep {
  tool: string;
  args: unknown;
}

export interface RunAgentT03Params {
  corpusRoot: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  /** When set, drive handlers from this transcript instead of the model. */
  replayTranscript?: ReplayStep[];
  /** Optional JSON-lines log file path. */
  logPath?: string;
}

export type TerminalReason =
  | "success"
  | "replay_complete"
  | "error_max_turns"
  | "error_wall_time"
  | "error_during_execution"
  | "error_other";

export interface AgentT03Result {
  criteria: T03Criteria;
  terminalReason: TerminalReason;
  log: SessionLog;
  /** The captured tool-call sequence, replayable as a fixture. */
  transcript: ReplayStep[];
}

const BANNED_BUILTINS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch"
];

export const T03_PROMPT =
  "Rename the exported interface `User` (defined in `src/types/user.ts`) to " +
  "`Account` everywhere it is referenced as a type, including type-only " +
  "re-exports and JSDoc. Leave unrelated string literals with the value " +
  '`"User"` (such as audit log discriminators) untouched. The full test ' +
  "suite must pass.";

function collectTsFiles(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
      } else if (entry.endsWith(".ts")) {
        out.push({ path: abs, text: readFileSync(abs, "utf8") });
      }
    }
  }

  walk(rootDir);
  return out;
}

/** Substitute the "$TX" placeholder in replay args with the live handle. */
function substituteTx(args: unknown, tx: TxHandle | undefined): unknown {
  if (args === "$TX") {
    if (!tx) {
      throw new Error("Replay transcript used $TX before begin_transaction");
    }
    return tx;
  }
  if (Array.isArray(args)) {
    return args.map((value) => substituteTx(value, tx));
  }
  if (isRecord(args)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      out[key] = substituteTx(value, tx);
    }
    return out;
  }
  return args;
}

export async function runAgentT03(
  params: RunAgentT03Params
): Promise<AgentT03Result> {
  const srcRoot = path.join(params.corpusRoot, "src");
  const batch = ingestBatch(collectTsFiles(srcRoot));
  const db = openDb(":memory:");
  const log = new SessionLog(params.logPath);
  const transcript: ReplayStep[] = [];
  let terminalReason: TerminalReason = "error_other";

  try {
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    const ctx: StrataSessionContext = { db, actor: "agent-t03" };
    const tools = createStrataTools(ctx);
    const byName = new Map(tools.map((definition) => [definition.name, definition]));

    log.append({
      type: "session_start",
      ts: Date.now(),
      model: params.model,
      maxTurns: params.maxTurns,
      task: "T03",
      actor: ctx.actor
    });

    let liveTx: TxHandle | undefined;
    let lastCommitOk = false;

    const setLiveTx = (tx: TxHandle): void => {
      liveTx = tx;
    };
    const setLastCommitOk = (ok: boolean): void => {
      lastCommitOk = ok;
    };

    async function runStep(
      toolName: string,
      rawArgs: unknown,
      turn: number
    ): Promise<unknown> {
      const definition = byName.get(toolName);
      if (!definition) {
        throw new Error(`Unknown Strata tool: ${toolName}`);
      }

      const started = Date.now();
      const args = substituteTx(rawArgs, liveTx);
      let parsed: unknown = null;
      let ok = true;
      let error: string | null = null;

      try {
        const handler = definition.handler as (
          args: unknown,
          extra: unknown
        ) => Promise<{ content: { type: string; text?: string }[] }>;
        parsed = parseToolHandlerResult(await handler(args, {}));
      } catch (caught) {
        ok = false;
        error = caught instanceof Error ? caught.message : String(caught);
      }

      if (!ok) {
        throw new Error(error ?? `Tool ${toolName} failed`);
      }

      applyObservedToolResult(toolName, parsed, setLiveTx, setLastCommitOk);
      log.append({
        type: "tool_call",
        ts: Date.now(),
        tool: toolName,
        args: rawArgs,
        result_summary: log.summarizeResult(parsed),
        ok,
        error,
        durationMs: Date.now() - started,
        turn
      });
      transcript.push({ tool: toolName, args: rawArgs });
      return parsed;
    }

    if (params.replayTranscript) {
      let turn = 0;
      for (const step of params.replayTranscript) {
        await runStep(step.tool, step.args, turn++);
      }
      terminalReason = "replay_complete";
    } else {
      terminalReason = await runLiveSession({
        params,
        ctx,
        log,
        transcript,
        setLiveTx,
        setLastCommitOk
      });
    }

    const checkTx = begin(db, "agent-t03-check");
    const postCommitDiagnostics = validate(db, checkTx);
    rollback(db, checkTx);

    const criteria = liveTx
      ? evaluateT03Criteria(db, batch, srcRoot, {
          commitReturnedOk: lastCommitOk,
          validateAfterCommitClean: postCommitDiagnostics.length === 0,
          renameTxId: liveTx.id
        })
      : emptyT03Criteria();

    return { criteria, terminalReason, log, transcript };
  } finally {
    db.close();
  }
}

/**
 * Load a recorded JSON-lines session log and extract the ordered tool-call
 * sequence as ReplayStep[]. Only tool_call events contribute; the
 * declaration_id captured at record time is reused for the fixed corpus, and
 * "$TX" placeholders are preserved so replay re-threads a fresh handle.
 */
export function loadTranscriptFixture(filePath: string): ReplayStep[] {
  const lines = readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const steps: ReplayStep[] = [];

  for (const line of lines) {
    const event = JSON.parse(line) as {
      type?: string;
      tool?: string;
      args?: unknown;
    };
    if (event.type === "tool_call" && event.tool) {
      steps.push({ tool: event.tool, args: event.args ?? {} });
    }
  }

  return steps;
}

/**
 * Normalize a captured transcript for fixture storage: replace any tx
 * argument that looks like a TxHandle ({ id, actor }) with the "$TX"
 * placeholder so the replay path re-threads a fresh live handle.
 */
export function normalizeTranscriptForFixture(
  steps: ReplayStep[]
): ReplayStep[] {
  function normalize(value: unknown): unknown {
    if (
      isRecord(value) &&
      typeof value.id === "string" &&
      typeof value.actor === "string" &&
      Object.keys(value).length === 2
    ) {
      return "$TX";
    }
    if (Array.isArray(value)) {
      return value.map((item) => normalize(item));
    }
    if (isRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value)) {
        out[key] = normalize(nested);
      }
      return out;
    }
    return value;
  }

  return steps.map((step) => ({
    tool: step.tool,
    args: normalize(step.args)
  }));
}

async function runLiveSession(deps: {
  params: RunAgentT03Params;
  ctx: StrataSessionContext;
  log: SessionLog;
  transcript: ReplayStep[];
  setLiveTx: (tx: TxHandle) => void;
  setLastCommitOk: (ok: boolean) => void;
}): Promise<TerminalReason> {
  const { params, ctx, log, transcript } = deps;
  const server = createStrataToolServer(ctx);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), params.wallTimeMs);
  const pending = new Map<
    string,
    { tool: string; args: unknown; turn: number; started: number }
  >();

  const options: Options = {
    mcpServers: { [STRATA_SERVER_NAME]: server },
    allowedTools: [...STRATA_QUALIFIED_TOOL_NAMES],
    tools: [],
    disallowedTools: BANNED_BUILTINS,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    systemPrompt: STRATA_SYSTEM_PROMPT,
    model: params.model,
    maxTurns: params.maxTurns,
    abortController,
    stderr: (data: string) =>
      log.append({
        type: "assistant_text",
        ts: Date.now(),
        turn: -1,
        text: `[stderr] ${data}`.slice(0, 240)
      })
  };

  let terminal: TerminalReason = "error_other";
  let turn = 0;

  try {
    for await (const message of query({
      prompt: singlePrompt(T03_PROMPT),
      options
    })) {
      if (message.type === "system" && message.subtype === "init") {
        assertOnlyStrataTools(message.tools);
        log.append({
          type: "init",
          ts: Date.now(),
          tools: message.tools,
          mcpServers: message.mcp_servers
        });
      } else if (message.type === "assistant") {
        for (const block of message.message.content) {
          const content = block as unknown;
          if (isTextBlock(content)) {
            log.append({
              type: "assistant_text",
              ts: Date.now(),
              turn,
              text: content.text.slice(0, 240)
            });
          } else if (isToolUseBlock(content)) {
            const toolName = unqualifyToolName(content.name);
            pending.set(content.id, {
              tool: toolName,
              args: content.input,
              turn,
              started: Date.now()
            });
            transcript.push({ tool: toolName, args: content.input });
          }
        }
        turn += 1;
      } else if (message.type === "user") {
        for (const observed of extractToolResults(message)) {
          const call = pending.get(observed.toolUseId);
          if (!call) {
            continue;
          }
          pending.delete(observed.toolUseId);
          const parsed = parseToolResultPayload(observed.result);
          applyObservedToolResult(
            call.tool,
            parsed,
            deps.setLiveTx,
            deps.setLastCommitOk
          );
          log.append({
            type: "tool_call",
            ts: Date.now(),
            tool: call.tool,
            args: call.args,
            result_summary: log.summarizeResult(parsed),
            ok: !observed.isError,
            error: observed.isError ? log.summarizeResult(parsed) : null,
            durationMs: Date.now() - call.started,
            turn: call.turn
          });
        }
      } else if (message.type === "result") {
        terminal = terminalFromResultSubtype(message.subtype);
        log.append({
          type: "result",
          ts: Date.now(),
          subtype: message.subtype,
          numTurns: message.num_turns,
          durationMs: message.duration_ms,
          durationApiMs: message.duration_api_ms,
          totalCostUsd: message.total_cost_usd,
          usage: {
            inputTokens: getUsageNumber(message.usage, "input_tokens"),
            outputTokens: getUsageNumber(message.usage, "output_tokens"),
            cacheReadInputTokens: getUsageNumber(
              message.usage,
              "cache_read_input_tokens"
            ),
            cacheCreationInputTokens: getUsageNumber(
              message.usage,
              "cache_creation_input_tokens"
            )
          },
          modelUsage: message.modelUsage,
          errors: "errors" in message ? message.errors : []
        });
      }
    }
  } catch (caught) {
    terminal = abortController.signal.aborted ? "error_wall_time" : "error_other";
    log.append({
      type: "assistant_text",
      ts: Date.now(),
      turn: -1,
      text: `[session error] ${
        caught instanceof Error ? caught.message : String(caught)
      }`.slice(0, 240)
    });
    if (!abortController.signal.aborted) {
      throw caught;
    }
  } finally {
    clearTimeout(timer);
    abortController.abort();
  }

  return terminal;
}

function terminalFromResultSubtype(subtype: string): TerminalReason {
  if (subtype === "success") {
    return "success";
  }
  if (subtype === "error_max_turns") {
    return "error_max_turns";
  }
  if (subtype === "error_during_execution") {
    return "error_during_execution";
  }
  return "error_other";
}

function assertOnlyStrataTools(tools: string[]): void {
  const expected = new Set(STRATA_QUALIFIED_TOOL_NAMES);
  for (const toolName of tools) {
    if (BANNED_BUILTINS.includes(toolName)) {
      throw new Error(
        `Runtime invariant violated: built-in tool ${toolName} present`
      );
    }
    if (!expected.has(toolName)) {
      throw new Error(
        `Runtime invariant violated: unexpected tool ${toolName} present`
      );
    }
  }
  for (const toolName of expected) {
    if (!tools.includes(toolName)) {
      throw new Error(
        `Runtime invariant violated: expected Strata tool ${toolName} missing`
      );
    }
  }
}

function unqualifyToolName(name: string): string {
  const prefix = `mcp__${STRATA_SERVER_NAME}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function parseToolHandlerResult(result: {
  content: { type: string; text?: string }[];
}): unknown {
  const block = result.content[0];
  if (!block || block.type !== "text" || block.text === undefined) {
    return null;
  }
  return JSON.parse(block.text) as unknown;
}

function parseToolResultPayload(value: unknown): unknown {
  if (isRecord(value)) {
    if (typeof value.content === "string") {
      return parseMaybeJson(value.content);
    }
    if (Array.isArray(value.content)) {
      const firstText = value.content.find(
        (block): block is { type: string; text: string } =>
          isRecord(block) &&
          block.type === "text" &&
          typeof block.text === "string"
      );
      if (firstText) {
        return parseMaybeJson(firstText.text);
      }
    }
  }
  return value;
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function applyObservedToolResult(
  toolName: string,
  parsed: unknown,
  setLiveTx: (tx: TxHandle) => void,
  setLastCommitOk: (ok: boolean) => void
): void {
  if (toolName === "begin_transaction" && isTxHandle(parsed)) {
    setLiveTx(parsed);
  } else if (toolName === "commit_transaction") {
    setLastCommitOk(isRecord(parsed) && parsed.ok === true);
  }
}

function extractToolResults(
  message: SDKUserMessage
): { toolUseId: string; result: unknown; isError: boolean }[] {
  const out: { toolUseId: string; result: unknown; isError: boolean }[] = [];
  collectToolResults(message.tool_use_result, out);
  if (Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      collectToolResults(block, out);
    }
  }
  return out;
}

function collectToolResults(
  value: unknown,
  out: { toolUseId: string; result: unknown; isError: boolean }[]
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolResults(item, out);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const type = value.type;
  const toolUseId =
    typeof value.tool_use_id === "string"
      ? value.tool_use_id
      : typeof value.toolUseId === "string"
        ? value.toolUseId
        : undefined;
  if (type === "tool_result" && toolUseId) {
    out.push({
      toolUseId,
      result: value,
      isError: value.is_error === true || value.isError === true
    });
    return;
  }
  for (const nested of Object.values(value)) {
    collectToolResults(nested, out);
  }
}

function isToolUseBlock(value: unknown): value is {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
} {
  return (
    isRecord(value) &&
    value.type === "tool_use" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    "input" in value
  );
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return (
    isRecord(value) &&
    value.type === "text" &&
    typeof value.text === "string"
  );
}

function isTxHandle(value: unknown): value is TxHandle {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.actor === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function getUsageNumber(usage: unknown, key: string): number {
  return isRecord(usage) && typeof usage[key] === "number"
    ? usage[key]
    : 0;
}
