import { describe, expect, it } from "vitest";
import { createSchedule, type ExperimentSchedule } from "../src/schedule.js";

const SCENARIOS = ["D", "M", "R", "S", "X", "G"].sort();

function armCounts(schedule: ExperimentSchedule): Record<string, number> {
  const counts: Record<string, number> = { "strata-first": 0, "baseline-first": 0 };
  for (const entry of schedule.entries) counts[entry.armOrder]! += 1;
  return counts;
}

describe("seeded experiment schedule", () => {
  it("reconstructs identically from the same seed and balances the pilot exactly", () => {
    const first = createSchedule({ seed: "pilot-seed-1", trialsPerScenario: 1 });
    const second = createSchedule({ seed: "pilot-seed-1", trialsPerScenario: 1 });
    expect(second).toEqual(first);
    expect(first.entries).toHaveLength(6);
    expect(first.entries.map((entry) => entry.scenario).sort()).toEqual(SCENARIOS);
    expect(armCounts(first)).toEqual({ "strata-first": 3, "baseline-first": 3 });
    for (const entry of first.entries) {
      expect(entry.concurrentTaskRelease).toBe(true);
      expect(entry.repetition).toBe(1);
    }
  });

  it("alternates per scenario on extension with a seeded order per repetition", () => {
    const schedule = createSchedule({ seed: "pilot-seed-1", trialsPerScenario: 2 });
    expect(schedule.entries).toHaveLength(12);
    for (const scenario of SCENARIOS) {
      const rows = schedule.entries.filter((entry) => entry.scenario === scenario);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.armOrder).not.toBe(rows[1]!.armOrder);
    }
    const orders = [1, 2].map((repetition) =>
      schedule.entries
        .filter((entry) => entry.repetition === repetition)
        .map((entry) => entry.scenario)
    );
    expect(orders[0]!.slice().sort()).toEqual(SCENARIOS);
    expect(orders[1]!.slice().sort()).toEqual(SCENARIOS);
  });

  it("keeps the task-to-process mapping stable per scenario across repetitions", () => {
    const schedule = createSchedule({ seed: "pilot-seed-1", trialsPerScenario: 3 });
    for (const scenario of SCENARIOS) {
      const rows = schedule.entries.filter((entry) => entry.scenario === scenario);
      const mappings = new Set(rows.map((entry) => JSON.stringify(entry.taskProcessMapping)));
      expect(mappings.size).toBe(1);
      const mapping = rows[0]!.taskProcessMapping;
      expect(new Set([mapping["agent-1"], mapping["agent-2"]])).toEqual(
        new Set(["process-1", "process-2"])
      );
    }
  });

  it("rejects result-dependent mutation and varies with the seed", () => {
    const schedule = createSchedule({ seed: "pilot-seed-1", trialsPerScenario: 1 });
    expect(() => { (schedule.entries[0] as any).armOrder = "strata-first"; }).toThrow();
    expect(() => { (schedule.entries as any).push(schedule.entries[0]); }).toThrow();
    const other = createSchedule({ seed: "pilot-seed-2", trialsPerScenario: 1 });
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(schedule));
  });
});
