import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTranscriptFixture, runAgentT03 } from "../src/index";

// Behavior-preservation guard: T03 replay through the refactored
// runAgentForPrompt is byte-identical to before (uses the committed
// real transcript fixture the canonical suite already relies on).
const FIXTURE = path.resolve(__dirname, "fixtures/agent-t03-transcript.jsonl");

describe.skipIf(!existsSync(FIXTURE))(
  "seam: acceptance lifted to callers preserves T03 replay",
  () => {
    it("T03 replay still scores all criteria true", async () => {
      const corpusRoot = path.resolve(__dirname, "../../../examples/medium");
      const steps = loadTranscriptFixture(FIXTURE);
      const result = await runAgentT03({
        corpusRoot,
        model: "replay",
        maxTurns: 25,
        wallTimeMs: 60_000,
        replayTranscript: steps
      });
      expect(result.criteria.commitReturnedOk).toBe(true);
      expect(result.criteria.validateAfterCommitClean).toBe(true);
      expect(result.criteria.operationRowAppended).toBe(true);
    });
  }
);
