import {
  query,
  type McpServerConfig,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";

export type HermeticTerminalReason =
  | "success"
  | "error_max_turns"
  | "max_budget"
  | "error_wall_time"
  | "error_during_execution"
  | "error_other";

export type HermeticQuery = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

export interface HermeticToolUseEvent {
  toolUseId: string;
  tool: string;
  args: unknown;
  turn: number;
}

export interface HermeticToolResultEvent {
  toolUseId: string;
  tool: string;
  args: unknown;
  result: unknown;
  isError: boolean;
  durationMs: number;
  turn: number;
}

export interface HermeticSessionCallbacks {
  onInit?: (message: SDKSystemMessage) => void;
  onAssistantText?: (event: { text: string; turn: number }) => void;
  onToolUse?: (event: HermeticToolUseEvent) => void;
  onToolResult?: (event: HermeticToolResultEvent) => void;
  onResult?: (message: SDKResultMessage) => void;
  onStderr?: (data: string) => void;
  onError?: (caught: unknown) => void;
}

export interface RunHermeticSessionParams {
  prompt: string;
  systemPrompt: string;
  serverName: string;
  server: McpServerConfig;
  allowedTools: readonly string[];
  bannedBuiltins: readonly string[];
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  maxBudgetUsd?: number;
  canUseTool?: Options["canUseTool"];
  queryFn?: HermeticQuery;
  callbacks?: HermeticSessionCallbacks;
}

export interface HermeticSessionResult {
  terminalReason: HermeticTerminalReason;
  result?: SDKResultMessage;
}

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

/**
 * Run one Agent SDK query with only the explicitly supplied MCP server/tools.
 * This boundary is storage agnostic; callers observe normalized SDK events via
 * callbacks and retain ownership of any product-specific state.
 */
export async function runHermeticSession(
  params: RunHermeticSessionParams
): Promise<HermeticSessionResult> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), params.wallTimeMs);
  const pending = new Map<
    string,
    { tool: string; args: unknown; turn: number; started: number }
  >();
  const callbacks = params.callbacks ?? {};
  const options: Options = {
    mcpServers: { [params.serverName]: params.server },
    // SDK 0.2.118 otherwise inherits ambient MCP servers and can inject LSP
    // despite tools: []. Keep both MCP/settings isolation and the explicit
    // hard-removal list; the exact init-tool guard below is the final check.
    strictMcpConfig: true,
    settingSources: [],
    allowedTools: [...params.allowedTools],
    tools: [],
    disallowedTools: [...params.bannedBuiltins],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    systemPrompt: params.systemPrompt,
    model: params.model,
    maxTurns: params.maxTurns,
    ...(params.maxBudgetUsd === undefined
      ? {}
      : { maxBudgetUsd: params.maxBudgetUsd }),
    ...(params.canUseTool ? { canUseTool: params.canUseTool } : {}),
    abortController,
    stderr: (data: string) => callbacks.onStderr?.(data)
  };

  let terminalReason: HermeticTerminalReason = "error_other";
  let result: SDKResultMessage | undefined;
  let turn = 0;

  try {
    const queryFn = params.queryFn ?? query;
    for await (const message of queryFn({
      prompt: singlePrompt(params.prompt),
      options
    })) {
      if (message.type === "system" && message.subtype === "init") {
        assertExactTools(
          message.tools,
          params.allowedTools,
          params.bannedBuiltins
        );
        callbacks.onInit?.(message);
      } else if (message.type === "assistant") {
        for (const block of message.message.content) {
          const content = block as unknown;
          if (isTextBlock(content)) {
            callbacks.onAssistantText?.({ text: content.text, turn });
          } else if (isToolUseBlock(content)) {
            const tool = unqualifyToolName(content.name, params.serverName);
            pending.set(content.id, {
              tool,
              args: content.input,
              turn,
              started: Date.now()
            });
            callbacks.onToolUse?.({
              toolUseId: content.id,
              tool,
              args: content.input,
              turn
            });
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
          callbacks.onToolResult?.({
            toolUseId: observed.toolUseId,
            tool: call.tool,
            args: call.args,
            result: parseToolResultPayload(observed.result),
            isError: observed.isError,
            durationMs: Date.now() - call.started,
            turn: call.turn
          });
        }
      } else if (message.type === "result") {
        result = message;
        terminalReason = terminalFromResultSubtype(message.subtype);
        callbacks.onResult?.(message);
      }
    }
  } catch (caught) {
    const classified = classifySessionError(
      caught,
      abortController.signal.aborted
    );
    terminalReason = classified.terminal;
    callbacks.onError?.(caught);
    if (classified.rethrow) {
      throw caught;
    }
  } finally {
    clearTimeout(timer);
    abortController.abort();
  }

  return { terminalReason, ...(result ? { result } : {}) };
}

/**
 * SDK 0.2.118 throws for maxTurns instead of always yielding an
 * error_max_turns result. Treat that bound and wall-time aborts as expected
 * terminal outcomes; unexpected SDK errors still fail loud. No retry occurs.
 */
export function classifySessionError(
  caught: unknown,
  aborted: boolean
): {
  terminal: "error_max_turns" | "error_wall_time" | "error_other";
  rethrow: boolean;
} {
  if (aborted) {
    return { terminal: "error_wall_time", rethrow: false };
  }
  const message = caught instanceof Error ? caught.message : String(caught);
  if (/maximum number of turns/i.test(message)) {
    return { terminal: "error_max_turns", rethrow: false };
  }
  return { terminal: "error_other", rethrow: true };
}

function terminalFromResultSubtype(subtype: string): HermeticTerminalReason {
  if (subtype === "success") {
    return "success";
  }
  if (subtype === "error_max_turns") {
    return "error_max_turns";
  }
  if (subtype === "error_max_budget_usd") {
    return "max_budget";
  }
  if (subtype === "error_during_execution") {
    return "error_during_execution";
  }
  return "error_other";
}

function assertExactTools(
  tools: string[],
  allowedTools: readonly string[],
  bannedBuiltins: readonly string[]
): void {
  const expected = new Set(allowedTools);
  for (const toolName of tools) {
    if (bannedBuiltins.includes(toolName)) {
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
        `Runtime invariant violated: expected tool ${toolName} missing`
      );
    }
  }
}

function unqualifyToolName(name: string, serverName: string): string {
  const prefix = `mcp__${serverName}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
