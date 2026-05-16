import { describe, expect, it } from "vitest";
import {
  TASK_BEHAVIORAL_FIXTURES,
  behavioralFixturesForTask
} from "../src/index";

describe("behavioralFixturesForTask", () => {
  it("maps T01 and T05 to their own fixture, T03/T08 to none", () => {
    expect(behavioralFixturesForTask("T01")).toEqual(["tests/format.test.ts"]);
    expect(behavioralFixturesForTask("T05")).toEqual([
      "tests/dateRange.test.ts"
    ]);
    expect(behavioralFixturesForTask("T03")).toEqual([]);
    expect(behavioralFixturesForTask("T08")).toEqual([]);
  });

  it("is fail-loud on an unknown task id (never silently whole-suite/empty)", () => {
    expect(() => behavioralFixturesForTask("T99")).toThrow(/unknown task id/i);
  });

  it("exposes the map as the single source of truth", () => {
    expect(Object.keys(TASK_BEHAVIORAL_FIXTURES).sort()).toEqual([
      "T01",
      "T03",
      "T05",
      "T08"
    ]);
  });
});
