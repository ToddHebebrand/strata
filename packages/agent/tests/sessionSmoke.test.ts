import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { collectSession } from "../src/session";

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
