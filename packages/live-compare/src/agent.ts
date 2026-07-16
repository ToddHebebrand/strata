import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  runHermeticSession,
  type HermeticQuery,
  type HermeticTerminalReason
} from "@strata/agent";
import { createHash } from "node:crypto";
import { createCoordinationClient } from "./client.js";
import {
  COORDINATION_QUALIFIED_TOOL_NAMES,
  COORDINATION_SERVER_NAME,
  createCoordinationToolServer
} from "./tools.js";

export { COORDINATION_QUALIFIED_TOOL_NAMES } from "./tools.js";

export const COORDINATION_BANNED_BUILTINS = [
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
  "WebSearch",
  "LSP"
] as const;

export interface RunCoordinationAgentParams {
  socketPath: string;
  clientId: string;
  prompt: string;
  systemPrompt: string;
  model: string;
  maxTurns: number;
  wallTimeMs: number;
  maxBudgetUsd: number;
  /** Required explicitly so key-free callers can never fall back to a live SDK query. */
  queryFn: HermeticQuery;
}

export type CoordinationTranscriptEntry =
  | { type: "assistant_text"; turn: number; text: string }
  | {
      type: "tool_use";
      turn: number;
      toolUseId: string;
      tool: string;
      args: unknown;
    }
  | {
      type: "tool_result";
      turn: number;
      toolUseId: string;
      tool: string;
      args: unknown;
      result: unknown;
      isError: boolean;
      durationMs: number;
    };

export type CoordinationAgentLogEntry =
  | {
      type: "session_start";
      model: string;
      maxTurns: number;
      wallTimeMs: number;
      maxBudgetUsd: number;
      taskPromptHash: string;
      systemPromptHash: string;
    }
  | { type: "init"; tools: string[]; mcpServers: { name: string; status: string }[] }
  | { type: "assistant_text"; turn: number; text: string }
  | {
      type: "tool_call";
      turn: number;
      toolUseId: string;
      tool: string;
      args: unknown;
      result: unknown;
      isError: boolean;
      durationMs: number;
    }
  | { type: "stderr"; text: string }
  | { type: "session_error"; message: string }
  | {
      type: "result";
      subtype: string;
      numTurns: number;
      durationMs: number;
      durationApiMs: number;
      totalCostUsd: number;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheCreationInputTokens: number;
        cacheReadInputTokens: number;
      };
      modelUsage: Record<string, unknown>;
      errors: string[];
      result: SDKResultMessage;
    };

export interface CoordinationAgentResult {
  terminalReason: HermeticTerminalReason;
  prompt: string;
  systemPrompt: string;
  taskPromptHash: string;
  systemPromptHash: string;
  transcript: CoordinationTranscriptEntry[];
  log: CoordinationAgentLogEntry[];
  result?: SDKResultMessage;
}

const PARAMETER_KEYS = new Set<keyof RunCoordinationAgentParams>([
  "socketPath",
  "clientId",
  "prompt",
  "systemPrompt",
  "model",
  "maxTurns",
  "wallTimeMs",
  "maxBudgetUsd",
  "queryFn"
]);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function usageNumber(usage: unknown, key: string): number {
  if (typeof usage !== "object" || usage === null) return 0;
  const value = (usage as Record<string, unknown>)[key];
  return typeof value === "number" ? value : 0;
}

function validateParams(params: RunCoordinationAgentParams): void {
  for (const key of Object.keys(params)) {
    if (!PARAMETER_KEYS.has(key as keyof RunCoordinationAgentParams)) {
      throw new Error(`unsupported coordination agent parameter ${key}`);
    }
  }
  if (typeof params.queryFn !== "function") {
    throw new Error("coordination agent requires an explicit queryFn");
  }
  if (!params.prompt || !params.systemPrompt || !params.model) {
    throw new Error("coordination prompt, system prompt, and model must be non-empty");
  }
  if (!Number.isSafeInteger(params.maxTurns) || params.maxTurns < 1) {
    throw new Error("maxTurns must be a positive safe integer");
  }
  if (!Number.isSafeInteger(params.wallTimeMs) || params.wallTimeMs < 1) {
    throw new Error("wallTimeMs must be a positive safe integer");
  }
  if (!Number.isFinite(params.maxBudgetUsd) || params.maxBudgetUsd <= 0) {
    throw new Error("maxBudgetUsd must be a positive finite number");
  }
}

/** Run one coordination-only Agent SDK session with complete in-memory evidence. */
export async function runCoordinationAgent(
  params: RunCoordinationAgentParams
): Promise<CoordinationAgentResult> {
  validateParams(params);
  const taskPromptHash = hash(params.prompt);
  const systemPromptHash = hash(params.systemPrompt);
  const transcript: CoordinationTranscriptEntry[] = [];
  const log: CoordinationAgentLogEntry[] = [
    {
      type: "session_start",
      model: params.model,
      maxTurns: params.maxTurns,
      wallTimeMs: params.wallTimeMs,
      maxBudgetUsd: params.maxBudgetUsd,
      taskPromptHash,
      systemPromptHash
    }
  ];
  const client = createCoordinationClient({
    socketPath: params.socketPath,
    clientId: params.clientId
  });
  const server = createCoordinationToolServer(client);

  const output = await runHermeticSession({
    prompt: params.prompt,
    systemPrompt: params.systemPrompt,
    serverName: COORDINATION_SERVER_NAME,
    server,
    allowedTools: COORDINATION_QUALIFIED_TOOL_NAMES,
    bannedBuiltins: COORDINATION_BANNED_BUILTINS,
    model: params.model,
    maxTurns: params.maxTurns,
    wallTimeMs: params.wallTimeMs,
    maxBudgetUsd: params.maxBudgetUsd,
    queryFn: params.queryFn,
    callbacks: {
      onInit: (message) => {
        log.push({
          type: "init",
          tools: [...message.tools],
          mcpServers: [...message.mcp_servers]
        });
      },
      onAssistantText: ({ text, turn }) => {
        const entry = { type: "assistant_text" as const, turn, text };
        transcript.push(entry);
        log.push(entry);
      },
      onToolUse: ({ toolUseId, tool, args, turn }) => {
        transcript.push({ type: "tool_use", turn, toolUseId, tool, args });
      },
      onToolResult: ({ toolUseId, tool, args, result, isError, durationMs, turn }) => {
        const entry = {
          type: "tool_result" as const,
          turn,
          toolUseId,
          tool,
          args,
          result,
          isError,
          durationMs
        };
        transcript.push(entry);
        log.push({ ...entry, type: "tool_call" });
      },
      onResult: (message) => {
        log.push({
          type: "result",
          subtype: message.subtype,
          numTurns: message.num_turns,
          durationMs: message.duration_ms,
          durationApiMs: message.duration_api_ms,
          totalCostUsd: message.total_cost_usd,
          usage: {
            inputTokens: usageNumber(message.usage, "input_tokens"),
            outputTokens: usageNumber(message.usage, "output_tokens"),
            cacheCreationInputTokens: usageNumber(
              message.usage,
              "cache_creation_input_tokens"
            ),
            cacheReadInputTokens: usageNumber(message.usage, "cache_read_input_tokens")
          },
          modelUsage: message.modelUsage,
          errors: "errors" in message ? message.errors : [],
          result: message
        });
      },
      onStderr: (text) => log.push({ type: "stderr", text }),
      onError: (caught) =>
        log.push({
          type: "session_error",
          message: caught instanceof Error ? caught.message : String(caught)
        })
    }
  });

  return {
    terminalReason: output.terminalReason,
    prompt: params.prompt,
    systemPrompt: params.systemPrompt,
    taskPromptHash,
    systemPromptHash,
    transcript,
    log,
    ...(output.result ? { result: output.result } : {})
  };
}
