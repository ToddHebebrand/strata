import type {
  HermeticQuery,
  HermeticTerminalReason
} from "@strata-code/agent";
import type { Options, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  COORDINATION_BANNED_BUILTINS,
  COORDINATION_QUALIFIED_TOOL_NAMES,
  runCoordinationAgent
} from "../src/agent";

function scriptedQuery(
  messages: SDKMessage[],
  capture: { calls: number; prompt?: string; options?: Options }
): HermeticQuery {
  return ({ prompt, options }) => {
    capture.calls += 1;
    capture.options = options;
    return (async function* () {
      if (typeof prompt === "string") capture.prompt = prompt;
      else {
        for await (const message of prompt) {
          capture.prompt = String(message.message.content);
        }
      }
      for (const message of messages) yield message;
    })();
  };
}

function initMessage(): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: "test",
    cwd: "/tmp/coordination-agent-test",
    tools: [...COORDINATION_QUALIFIED_TOOL_NAMES],
    mcp_servers: [{ name: "coordination", status: "connected" }],
    model: "test-model",
    permissionMode: "bypassPermissions",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: "session-test"
  } as SDKMessage;
}

function resultMessage(): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 40,
    duration_api_ms: 25,
    is_error: false,
    num_turns: 2,
    result: "published",
    stop_reason: null,
    total_cost_usd: 0.125,
    usage: {
      input_tokens: 101,
      output_tokens: 29,
      cache_creation_input_tokens: 7,
      cache_read_input_tokens: 13,
      server_tool_use: null,
      service_tier: "standard"
    },
    modelUsage: { "test-model": { inputTokens: 101 } },
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-000000000004",
    session_id: "session-test"
  } as SDKResultMessage;
}

function safelyStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (typeof nested === "object" && nested !== null) {
      if (seen.has(nested)) return "[circular]";
      seen.add(nested);
    }
    return nested;
  });
}

describe("sealed coordination agent adapter", () => {
  it("runs with one coordination server, no ambient settings or builtins, and explicit bounds", async () => {
    const capture: { calls: number; prompt?: string; options?: Options } = { calls: 0 };
    const result = resultMessage();
    const queryFn = scriptedQuery([initMessage(), result], capture);

    const output = await runCoordinationAgent({
      socketPath: "/tmp/strata-lc/sensitive.sock",
      clientId: "opaque-client-token",
      prompt: "Rename the assigned stable node.",
      systemPrompt: "Operate only through the coordination lifecycle.",
      model: "test-model",
      maxTurns: 7,
      wallTimeMs: 2_000,
      maxBudgetUsd: 0.25,
      queryFn
    });

    expect(capture.calls).toBe(1);
    expect(capture.prompt).toBe("Rename the assigned stable node.");
    expect(Object.keys(capture.options?.mcpServers ?? {})).toEqual(["coordination"]);
    expect(capture.options).toMatchObject({
      strictMcpConfig: true,
      settingSources: [],
      tools: [],
      allowedTools: COORDINATION_QUALIFIED_TOOL_NAMES,
      disallowedTools: COORDINATION_BANNED_BUILTINS,
      systemPrompt: "Operate only through the coordination lifecycle.",
      model: "test-model",
      maxTurns: 7,
      maxBudgetUsd: 0.25
    });
    expect(safelyStringify(capture.options?.mcpServers)).not.toContain(
      "/tmp/strata-lc/sensitive.sock"
    );
    expect(safelyStringify(capture.options?.mcpServers)).not.toContain(
      "opaque-client-token"
    );
    expect(output.terminalReason).toBe("success" satisfies HermeticTerminalReason);
    expect(output.result).toBe(result);
  });

  it("preserves the complete assistant/tool transcript and cost/result log", async () => {
    const result = resultMessage();
    const messages = [
      initMessage(),
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect the stable target." },
            {
              type: "tool_use",
              id: "tool:1",
              name: "mcp__coordination__inspect_nodes",
              input: { node_ids: ["node:1"] }
            }
          ]
        }
      } as SDKMessage,
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool:1",
              content: '{"type":"nodes","graphGeneration":"0","nodes":[]}',
              is_error: false
            }
          ]
        }
      } as SDKMessage,
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] }
      } as SDKMessage,
      result
    ];

    const output = await runCoordinationAgent({
      socketPath: "/tmp/strata-lc/test.sock",
      clientId: "client:alpha",
      prompt: "Task-specific prompt bytes",
      systemPrompt: "System prompt bytes",
      model: "test-model",
      maxTurns: 7,
      wallTimeMs: 2_000,
      maxBudgetUsd: 0.25,
      queryFn: scriptedQuery(messages, { calls: 0 })
    });

    expect(output.taskPromptHash).toBe(
      createHash("sha256").update("Task-specific prompt bytes").digest("hex")
    );
    expect(output.systemPromptHash).toBe(
      createHash("sha256").update("System prompt bytes").digest("hex")
    );
    expect(output.transcript).toEqual([
      { type: "assistant_text", turn: 0, text: "I will inspect the stable target." },
      {
        type: "tool_use",
        turn: 0,
        toolUseId: "tool:1",
        tool: "inspect_nodes",
        args: { node_ids: ["node:1"] }
      },
      {
        type: "tool_result",
        turn: 0,
        toolUseId: "tool:1",
        tool: "inspect_nodes",
        args: { node_ids: ["node:1"] },
        result: { type: "nodes", graphGeneration: "0", nodes: [] },
        isError: false,
        durationMs: expect.any(Number)
      },
      { type: "assistant_text", turn: 1, text: "Done." }
    ]);
    expect(output.log.at(-1)).toEqual({
      type: "result",
      subtype: "success",
      numTurns: 2,
      durationMs: 40,
      durationApiMs: 25,
      totalCostUsd: 0.125,
      usage: {
        inputTokens: 101,
        outputTokens: 29,
        cacheCreationInputTokens: 7,
        cacheReadInputTokens: 13
      },
      modelUsage: { "test-model": { inputTokens: 101 } },
      errors: [],
      result
    });
    expect(output.result).toBe(result);
  });

  it.each(["db", "sqlitePath", "redbPath", "bridgeConfig", "filesystem", "bash"])(
    "rejects ambient or authority-bearing adapter field %s",
    async (field) => {
      await expect(
        runCoordinationAgent({
          socketPath: "/tmp/strata-lc/test.sock",
          clientId: "client:alpha",
          prompt: "Task",
          systemPrompt: "System",
          model: "test-model",
          maxTurns: 1,
          wallTimeMs: 100,
          maxBudgetUsd: 0.01,
          queryFn: scriptedQuery([], { calls: 0 }),
          [field]: "forbidden"
        } as never)
      ).rejects.toThrow();
    }
  );

  it("requires an injected query and refuses a real-query fallback", async () => {
    await expect(
      runCoordinationAgent({
        socketPath: "/tmp/strata-lc/test.sock",
        clientId: "client:alpha",
        prompt: "Task",
        systemPrompt: "System",
        model: "test-model",
        maxTurns: 1,
        wallTimeMs: 100,
        maxBudgetUsd: 0.01,
        queryFn: undefined
      } as never)
    ).rejects.toThrow("explicit queryFn");
  });
});
