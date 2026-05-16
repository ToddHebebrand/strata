import { describe, expect, it } from "vitest";
import {
  TASK_BEHAVIORAL_FIXTURES,
  behavioralFixturesForTask
} from "../src/index";

describe("behavioralFixturesForTask", () => {
  it("maps T01 to its fixture", () => {
    expect(behavioralFixturesForTask("T01")).toEqual(["tests/format.test.ts"]);
  });
  it("maps T05 to its fixture", () => {
    expect(behavioralFixturesForTask("T05")).toEqual([
      "tests/dateRange.test.ts"
    ]);
  });
  it("maps T03 to no fixtures (tsc+text criteria fully constrain it)", () => {
    expect(behavioralFixturesForTask("T03")).toEqual([]);
  });
  it("maps T08 to no fixtures (tsc+text criteria fully constrain it)", () => {
    expect(behavioralFixturesForTask("T08")).toEqual([]);
  });

  it("is fail-loud on an unknown task id (never silently whole-suite/empty)", () => {
    expect(() => behavioralFixturesForTask("T99")).toThrow(/unknown task id/i);
    expect(() => behavioralFixturesForTask("T99")).toThrow(
      /Registered ids:.*T01.*T03.*T05.*T08/
    );
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
