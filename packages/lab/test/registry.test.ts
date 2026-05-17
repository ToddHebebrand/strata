import { describe, it, expect } from "vitest";
import { REGISTRY, getExperiment } from "../src/registry";

describe("registry", () => {
  // Task 10: when perScopeAddParameter is registered, ALSO assert
  // REGISTRY["noop"] === undefined — the temporary noop must be REMOVED,
  // not left alongside the real experiment.
  it("maps ids to experiments and throws on unknown", () => {
    expect(Object.keys(REGISTRY).length).toBeGreaterThan(0);
    expect(() => getExperiment("nope")).toThrow(/unknown experiment/i);
  });
});
