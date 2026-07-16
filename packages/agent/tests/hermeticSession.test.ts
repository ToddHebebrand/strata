import {
  createSdkMcpServer,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  runHermeticSession,
  type HermeticQuery
} from "../src/hermeticSession";

const TOOL = "mcp__probe__ping";

function initMessage(tools: string[]): SDKSystemMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: "test",
    cwd: "/tmp/hermetic-session-test",
    tools,
    mcp_servers: [{ name: "probe", status: "connected" }],
    model: "test-model",
    permissionMode: "bypassPermissions",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: "session-test"
  } as SDKSystemMessage;
}

function resultMessage(
  subtype: "success" | "error_max_budget_usd" = "success"
): SDKResultMessage {
  const common = {
    type: "result" as const,
    subtype,
    duration_ms: 20,
    duration_api_ms: 15,
    is_error: subtype !== "success",
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0.125,
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 5,
      server_tool_use: null,
      service_tier: "standard"
    },
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-000000000002",
    session_id: "session-test"
  };
  return (subtype === "success"
    ? { ...common, subtype, result: "done" }
    : { ...common, subtype, errors: ["budget reached"] }) as SDKResultMessage;
}

function scriptedQuery(
  messages: SDKMessage[],
  capture: { prompt?: string; options?: Options; calls: number }
): HermeticQuery {
  return ({ prompt, options }) => {
    capture.calls += 1;
    capture.options = options;
    return (async function* () {
      if (typeof prompt === "string") {
        capture.prompt = prompt;
      } else {
        for await (const message of prompt) {
          capture.prompt = String(
            (message as SDKUserMessage).message.content
          );
        }
      }
      for (const message of messages) {
        yield message;
      }
    })();
  };
}

describe("runHermeticSession", () => {
  it("constructs an explicitly isolated storage-agnostic SDK query", async () => {
    const server = createSdkMcpServer({
      name: "probe",
      version: "0.0.0",
      tools: []
    });
    const capture: { prompt?: string; options?: Options; calls: number } = {
      calls: 0
    };

    const output = await runHermeticSession({
      prompt: "Use the probe.",
      systemPrompt: "Only use the supplied probe.",
      serverName: "probe",
      server,
      allowedTools: [TOOL],
      bannedBuiltins: ["Read", "Write", "Bash", "LSP"],
      model: "test-model",
      maxTurns: 4,
      wallTimeMs: 2_000,
      maxBudgetUsd: 0.25,
      queryFn: scriptedQuery(
        [initMessage([TOOL]), resultMessage()],
        capture
      )
    });

    expect(output.terminalReason).toBe("success");
    expect(capture.calls).toBe(1);
    expect(capture.prompt).toBe("Use the probe.");
    expect(capture.options).toMatchObject({
      mcpServers: { probe: server },
      strictMcpConfig: true,
      settingSources: [],
      allowedTools: [TOOL],
      tools: [],
      disallowedTools: ["Read", "Write", "Bash", "LSP"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt: "Only use the supplied probe.",
      model: "test-model",
      maxTurns: 4,
      maxBudgetUsd: 0.25
    });
    expect(capture.options?.abortController).toBeInstanceOf(AbortController);
  });

  it.each(["Read", "mcp__ambient__unexpected"])(
    "rejects unexpected init tool %s",
    async (unexpectedTool) => {
      const server = createSdkMcpServer({
        name: "probe",
        version: "0.0.0",
        tools: []
      });
      const capture = { calls: 0 };

      await expect(
        runHermeticSession({
          prompt: "Use the probe.",
          systemPrompt: "Only use the supplied probe.",
          serverName: "probe",
          server,
          allowedTools: [TOOL],
          bannedBuiltins: ["Read", "Write", "Bash", "LSP"],
          model: "test-model",
          maxTurns: 4,
          wallTimeMs: 2_000,
          queryFn: scriptedQuery(
            [initMessage([TOOL, unexpectedTool])],
            capture
          )
        })
      ).rejects.toThrow(`tool ${unexpectedTool} present`);
      expect(capture.calls).toBe(1);
    }
  );

  it("rejects an init response missing an explicitly allowed tool", async () => {
    const server = createSdkMcpServer({
      name: "probe",
      version: "0.0.0",
      tools: []
    });

    await expect(
      runHermeticSession({
        prompt: "Use the probe.",
        systemPrompt: "Only use the supplied probe.",
        serverName: "probe",
        server,
        allowedTools: [TOOL],
        bannedBuiltins: ["Read", "Write", "Bash", "LSP"],
        model: "test-model",
        maxTurns: 4,
        wallTimeMs: 2_000,
        queryFn: scriptedQuery([initMessage([])], { calls: 0 })
      })
    ).rejects.toThrow(`expected tool ${TOOL} missing`);
  });
});
