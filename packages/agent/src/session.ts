import {
  query,
  type Options,
  type SDKMessage,
  type SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";

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
