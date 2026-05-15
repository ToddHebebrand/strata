import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentT03 } from "../src/index";

const hasAuth =
  !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_CODE_OAUTH_TOKEN;

describe.skipIf(!hasAuth)("agent drives T03 end-to-end (BS-A, live)", () => {
  it(
    "passes all 11 T03 criteria and the runtime invariant guard",
    async () => {
      const corpusRoot = path.resolve(__dirname, "../../../examples/medium");
      const result = await runAgentT03({
        corpusRoot,
        model: "claude-sonnet-4-6",
        maxTurns: 25,
        wallTimeMs: 240_000
      });

      expect(result.terminalReason).toBe("success");
      for (const [key, value] of Object.entries(result.criteria)) {
        expect(
          value,
          `criterion ${key} (terminal=${result.terminalReason})`
        ).toBe(true);
      }

      const resultEvent = result.log.events.find(
        (event) => event.type === "result"
      );
      expect(resultEvent).toBeDefined();

      const initEvent = result.log.events.find(
        (event) => event.type === "init"
      );
      expect(initEvent).toBeDefined();
    },
    300_000
  );
});
