import {
  createSdkMcpServer,
  tool,
  type Options,
  type SDKMessage,
  type SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { SessionLog } from "../src/log";
import { STRATA_SYSTEM_PROMPT } from "../src/prompt";
import {
  collectSession,
  runLiveSession,
  T03_PROMPT,
  type ReplayStep
} from "../src/session";
import {
  STRATA_QUALIFIED_TOOL_NAMES,
  STRATA_SERVER_NAME,
  type StrataSessionContext
} from "../src/tools";

function compatibilityMessages(): SDKMessage[] {
  return [
    {
      type: "system",
      subtype: "init",
      apiKeySource: "none",
      claude_code_version: "test",
      cwd: "/tmp/session-smoke",
      tools: [...STRATA_QUALIFIED_TOOL_NAMES],
      mcp_servers: [{ name: STRATA_SERVER_NAME, status: "connected" }],
      model: "test-model",
      permissionMode: "bypassPermissions",
      slash_commands: [],
      output_style: "default",
      skills: [],
      plugins: [],
      uuid: "00000000-0000-4000-8000-000000000011",
      session_id: "session-smoke"
    },
    {
      type: "assistant",
      message: {
        id: "message-smoke",
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [
          { type: "text", text: "Starting the transaction." },
          {
            type: "tool_use",
            id: "tool-begin",
            name: `mcp__${STRATA_SERVER_NAME}__begin_transaction`,
            input: { reasoning: "rename User" }
          },
          {
            type: "tool_use",
            id: "tool-commit",
            name: `mcp__${STRATA_SERVER_NAME}__commit_transaction`,
            input: { tx: { id: "tx-live", actor: "agent-t03" } }
          }
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        }
      },
      parent_tool_use_id: null,
      uuid: "00000000-0000-4000-8000-000000000012",
      session_id: "session-smoke"
    },
    {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-begin",
            content: JSON.stringify({ id: "tx-live", actor: "agent-t03" })
          },
          {
            type: "tool_result",
            tool_use_id: "tool-commit",
            content: JSON.stringify({ ok: true })
          }
        ]
      },
      uuid: "00000000-0000-4000-8000-000000000013",
      session_id: "session-smoke"
    },
    {
      type: "result",
      subtype: "success",
      duration_ms: 50,
      duration_api_ms: 40,
      is_error: false,
      num_turns: 1,
      result: "done",
      stop_reason: null,
      total_cost_usd: 0.125,
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 4,
        server_tool_use: null,
        service_tier: "standard"
      },
      modelUsage: {},
      permission_denials: [],
      uuid: "00000000-0000-4000-8000-000000000014",
      session_id: "session-smoke"
    }
  ] as SDKMessage[];
}

describe("runLiveSession compatibility wrapper", () => {
  it("preserves the T03 prompt, isolation, transcript, logs, and tx observations", async () => {
    const server = createSdkMcpServer({
      name: STRATA_SERVER_NAME,
      version: "0.0.0",
      tools: []
    });
    const capture: { prompt?: string; options?: Options; calls: number } = {
      calls: 0
    };
    const queryFn = ({ prompt, options }: Parameters<
      typeof import("@anthropic-ai/claude-agent-sdk").query
    >[0]) => {
      capture.calls += 1;
      capture.options = options;
      return (async function* () {
        if (typeof prompt !== "string") {
          for await (const message of prompt) {
            capture.prompt = String((message as SDKUserMessage).message.content);
          }
        }
        for (const message of compatibilityMessages()) {
          yield message;
        }
      })();
    };
    const log = new SessionLog();
    const transcript: ReplayStep[] = [];
    let liveTx: unknown;
    let lastCommitOk = false;
    const now = vi.spyOn(Date, "now").mockReturnValue(1_234);

    try {
      const terminal = await runLiveSession({
        params: {
          corpusRoot: "/unused",
          model: "test-model",
          maxTurns: 7,
          wallTimeMs: 2_000,
          toolServerFactory: () => server
        },
        ctx: {} as StrataSessionContext,
        log,
        transcript,
        setLiveTx: (tx) => {
          liveTx = tx;
        },
        setLastCommitOk: (ok) => {
          lastCommitOk = ok;
        },
        queryFn
      });

      expect(terminal).toBe("success");
      expect(capture.calls).toBe(1);
      expect(capture.prompt).toBe(T03_PROMPT);
      expect(capture.options).toMatchObject({
        mcpServers: { [STRATA_SERVER_NAME]: server },
        strictMcpConfig: true,
        settingSources: [],
        allowedTools: [...STRATA_QUALIFIED_TOOL_NAMES],
        tools: [],
        disallowedTools: [
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
        ],
        systemPrompt: STRATA_SYSTEM_PROMPT,
        model: "test-model",
        maxTurns: 7
      });
      expect(capture.options).not.toHaveProperty("maxBudgetUsd");
      expect(transcript).toEqual([
        { tool: "begin_transaction", args: { reasoning: "rename User" } },
        {
          tool: "commit_transaction",
          args: { tx: { id: "tx-live", actor: "agent-t03" } }
        }
      ]);
      expect(liveTx).toEqual({ id: "tx-live", actor: "agent-t03" });
      expect(lastCommitOk).toBe(true);

      const expectedEvents = [
        {
          type: "init",
          ts: 1_234,
          tools: [...STRATA_QUALIFIED_TOOL_NAMES],
          mcpServers: [{ name: STRATA_SERVER_NAME, status: "connected" }]
        },
        {
          type: "assistant_text",
          ts: 1_234,
          turn: 0,
          text: "Starting the transaction."
        },
        {
          type: "tool_call",
          ts: 1_234,
          tool: "begin_transaction",
          args: { reasoning: "rename User" },
          result_summary: '{"id":"tx-live","actor":"agent-t03"}',
          ok: true,
          error: null,
          durationMs: 0,
          turn: 0
        },
        {
          type: "tool_call",
          ts: 1_234,
          tool: "commit_transaction",
          args: { tx: { id: "tx-live", actor: "agent-t03" } },
          result_summary: '{"ok":true}',
          ok: true,
          error: null,
          durationMs: 0,
          turn: 0
        },
        {
          type: "result",
          ts: 1_234,
          subtype: "success",
          numTurns: 1,
          durationMs: 50,
          durationApiMs: 40,
          totalCostUsd: 0.125,
          usage: {
            inputTokens: 12,
            outputTokens: 8,
            cacheReadInputTokens: 4,
            cacheCreationInputTokens: 2
          },
          modelUsage: {},
          errors: []
        }
      ];
      expect(log.toJsonl()).toBe(
        `${expectedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`
      );
    } finally {
      now.mockRestore();
    }
  });
});

const hasAuth =
  !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_CODE_OAUTH_TOKEN;

describe.skipIf(!hasAuth)("BS-B: headless one-tool SDK session", () => {
  it(
    "runs with tools:[] and only the custom tool appears in init",
    async () => {
      let pingCalled = false;
      const pingTool = tool(
        "ping",
        "Return pong. Call this exactly once, then stop.",
        {},
        async () => {
          pingCalled = true;
          return { content: [{ type: "text" as const, text: "pong" }] };
        }
      );
      const server = createSdkMcpServer({
        name: "probe",
        version: "0.0.0",
        tools: [pingTool]
      });

      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), 60_000);
      try {
        const session = await collectSession({
          prompt:
            "Call the ping tool exactly once and then stop. Do not do anything else.",
          options: {
            mcpServers: { probe: server },
            allowedTools: ["mcp__probe__ping"],
            tools: [],
            disallowedTools: [
              "Read",
              "Write",
              "Edit",
              "Bash",
              "Glob",
              "Grep",
              "WebFetch",
              "WebSearch"
            ],
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            maxTurns: 6,
            model: "claude-sonnet-4-6",
            abortController
          }
        });

        expect(session.initTools).toBeDefined();
        for (const banned of ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]) {
          expect(session.initTools).not.toContain(banned);
        }
        expect(session.initTools).toContain("mcp__probe__ping");
        expect(pingCalled).toBe(true);
        const result = session.messages.find((m) => m.type === "result");
        expect(result).toBeDefined();
      } finally {
        clearTimeout(timer);
        abortController.abort();
      }
    },
    90_000
  );
});
