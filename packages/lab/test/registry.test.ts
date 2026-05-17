import { describe, it, expect } from "vitest";
import { REGISTRY, getExperiment } from "../src/registry";

describe("registry", () => {
  it("maps ids to experiments and throws on unknown", () => {
    expect(Object.keys(REGISTRY).length).toBeGreaterThan(0);
    expect(() => getExperiment("nope")).toThrow(/unknown experiment/i);
  });
});
