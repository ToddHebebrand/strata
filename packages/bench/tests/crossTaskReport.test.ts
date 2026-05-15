import { describe, expect, it } from "vitest";
import type { TrialMetrics } from "../src/metrics";
import { buildSuiteReport, renderSuiteMarkdown } from "../src/report";

function tm(
  config: "substrate" | "baseline",
  trial: number,
  tokens: number
): TrialMetrics {
  return {
    config,
    trial,
    totalTokens: tokens,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    wallTimeMs: 1000,
    harnessWallTimeMs: 1000,
    toolInvocations: 5,
    failuresRetries: 0,
    totalCostUsd: 0.01,
    success: true,
    resultQuality: { tscClean: true, vitestPassed: true },
    terminalReason: "success",
    operationRowAppended: config === "substrate" ? true : null
  };
}

describe("cross-task suite report", () => {
  it("emits per-task distributions and a pattern section with its falsifier", () => {
    const report = buildSuiteReport({
      model: "m",
      n: 3,
      perTask: {
        T01: {
          substrate: [
            tm("substrate", 1, 100),
            tm("substrate", 2, 110),
            tm("substrate", 3, 120)
          ],
          baseline: [
            tm("baseline", 1, 400),
            tm("baseline", 2, 410),
            tm("baseline", 3, 420)
          ]
        },
        T03: {
          substrate: [
            tm("substrate", 1, 100),
            tm("substrate", 2, 110),
            tm("substrate", 3, 120)
          ],
          baseline: [
            tm("baseline", 1, 400),
            tm("baseline", 2, 410),
            tm("baseline", 3, 420)
          ]
        },
        T08: {
          substrate: [
            tm("substrate", 1, 100),
            tm("substrate", 2, 110),
            tm("substrate", 3, 120)
          ],
          baseline: [
            tm("baseline", 1, 400),
            tm("baseline", 2, 410),
            tm("baseline", 3, 420)
          ]
        },
        T05: {
          substrate: [
            tm("substrate", 1, 300),
            tm("substrate", 2, 310),
            tm("substrate", 3, 320)
          ],
          baseline: [
            tm("baseline", 1, 300),
            tm("baseline", 2, 305),
            tm("baseline", 3, 315)
          ]
        }
      },
      totalCostUsd: 1.23
    });

    expect(Object.keys(report.perTask).sort()).toEqual([
      "T01",
      "T03",
      "T05",
      "T08"
    ]);
    const markdown = renderSuiteMarkdown(report);
    expect(markdown).toContain("cross-task pattern");
    expect(markdown.toLowerCase()).toContain("holds iff");
    expect(report.patternHolds).toBe(true);
  });

  it("reports pattern broken honestly when the control separates", () => {
    const report = buildSuiteReport({
      model: "m",
      n: 3,
      perTask: {
        T01: { substrate: [tm("substrate", 1, 100)], baseline: [tm("baseline", 1, 400)] },
        T03: { substrate: [tm("substrate", 1, 100)], baseline: [tm("baseline", 1, 400)] },
        T08: { substrate: [tm("substrate", 1, 100)], baseline: [tm("baseline", 1, 400)] },
        T05: { substrate: [tm("substrate", 1, 100)], baseline: [tm("baseline", 1, 900)] }
      },
      totalCostUsd: 1
    });

    expect(report.patternHolds).toBe(false);
  });
});
