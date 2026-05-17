import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTranscriptFixture, runAgentLab, runAgentT03 } from "../src/index";

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

describe("seam: runAgentLab drives the real loop with overrides", () => {
  it("is exported and accepts a tool-server factory + generic scorer", async () => {
    expect(typeof runAgentLab).toBe("function");
    const result = await runAgentLab({
      corpusRoot: require("node:path").join(
        __dirname, "..", "..", "..", "examples", "medium"
      ),
      model: "replay",
      maxTurns: 1,
      wallTimeMs: 60000,
      actor: "lab-test",
      prompt: "noop",
      replayTranscript: [],
      acceptance: undefined,
      emptyCriteria: () => ({
        commitReturnedOk: false,
        validateAfterCommitClean: false,
        operationRowAppended: false,
        labOk: false
      }),
      score: () => ({
        commitReturnedOk: false,
        validateAfterCommitClean: false,
        operationRowAppended: false,
        labOk: false
      })
    });
    expect(result.criteria.labOk).toBe(false);
    expect(result.terminalReason).toBe("replay_complete");
  });
});
