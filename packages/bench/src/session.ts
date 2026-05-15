import type { TerminalReason } from "./metrics";

export interface BaselineToolEvent {
  tool: string;
  path: string | undefined;
  command: string | undefined;
  exitCode: number | undefined;
}

export interface BaselineResultCapture {
  subtype: string;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  totalCostUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
}

export interface BaselineSession {
  terminalReason: TerminalReason;
  result?: BaselineResultCapture;
  toolEvents: BaselineToolEvent[];
  toolInvocations: number;
  initTools: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function usageNumber(usage: unknown, key: string): number {
  return isRecord(usage) && typeof usage[key] === "number"
    ? usage[key]
    : 0;
}

function terminalFromSubtype(subtype: string): TerminalReason {
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

function parseExitCode(result: unknown): number | undefined {
  let text: string | undefined;
  if (isRecord(result)) {
    if (typeof result.content === "string") {
      text = result.content;
    } else if (Array.isArray(result.content)) {
      const block = result.content.find(
        (value): value is { type: string; text: string } =>
          isRecord(value) &&
          value.type === "text" &&
          typeof value.text === "string"
      );
      text = block?.text;
    }
  }
  if (text === undefined) {
    return undefined;
  }
  const match = /exit(?:\s*code)?[:=]?\s*(\d+)/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

function collectToolResults(
  value: unknown,
  out: { id: string; result: unknown }[]
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

  if (value.type === "tool_result" && typeof value.tool_use_id === "string") {
    out.push({ id: value.tool_use_id, result: value });
    return;
  }

  for (const nested of Object.values(value)) {
    collectToolResults(nested, out);
  }
}

function inputPath(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  if (typeof input.file_path === "string") {
    return input.file_path;
  }
  if (typeof input.path === "string") {
    return input.path;
  }
  return undefined;
}

/**
 * Drive any async-iterable of SDK-shaped messages to completion, capturing
 * terminal SDKResult metrics and a flat tool-event list. Injectable by
 * design: key-free tests pass a synthetic generator; the later live runner
 * passes the real query(...) generator without changing this collector.
 */
export async function collectBaselineSession(
  stream: AsyncIterable<unknown>
): Promise<BaselineSession> {
  const session: BaselineSession = {
    terminalReason: "error_other",
    toolEvents: [],
    toolInvocations: 0,
    initTools: []
  };
  const pending = new Map<string, { tool: string; input: unknown }>();

  for await (const message of stream) {
    if (!isRecord(message)) {
      continue;
    }

    if (message.type === "system" && message.subtype === "init") {
      session.initTools = Array.isArray(message.tools)
        ? message.tools.filter((tool): tool is string => typeof tool === "string")
        : [];
    } else if (message.type === "assistant") {
      const content =
        isRecord(message.message) && Array.isArray(message.message.content)
          ? message.message.content
          : [];
      for (const block of content) {
        if (
          isRecord(block) &&
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          pending.set(block.id, { tool: block.name, input: block.input });
        }
      }
    } else if (message.type === "user") {
      const results: { id: string; result: unknown }[] = [];
      collectToolResults(message.tool_use_result, results);
      if (isRecord(message.message)) {
        collectToolResults(message.message.content, results);
      }

      for (const observed of results) {
        const call = pending.get(observed.id);
        if (!call) {
          continue;
        }
        pending.delete(observed.id);
        const input = isRecord(call.input) ? call.input : {};
        const command =
          typeof input.command === "string" ? input.command : undefined;
        session.toolEvents.push({
          tool: call.tool,
          path: inputPath(input),
          command,
          exitCode:
            call.tool === "Bash" ? parseExitCode(observed.result) : undefined
        });
        session.toolInvocations++;
      }
    } else if (message.type === "result") {
      const subtype =
        typeof message.subtype === "string" ? message.subtype : "error";
      session.terminalReason = terminalFromSubtype(subtype);
      session.result = {
        subtype,
        numTurns:
          typeof message.num_turns === "number" ? message.num_turns : 0,
        durationMs:
          typeof message.duration_ms === "number" ? message.duration_ms : 0,
        durationApiMs:
          typeof message.duration_api_ms === "number"
            ? message.duration_api_ms
            : 0,
        totalCostUsd:
          typeof message.total_cost_usd === "number"
            ? message.total_cost_usd
            : 0,
        usage: {
          inputTokens: usageNumber(message.usage, "input_tokens"),
          outputTokens: usageNumber(message.usage, "output_tokens"),
          cacheReadInputTokens: usageNumber(
            message.usage,
            "cache_read_input_tokens"
          ),
          cacheCreationInputTokens: usageNumber(
            message.usage,
            "cache_creation_input_tokens"
          )
        }
      };
    }
  }

  return session;
}
