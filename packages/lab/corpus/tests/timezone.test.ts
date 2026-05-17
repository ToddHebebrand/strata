import { describe, it, expect } from "vitest";
import { formatTimestamp } from "../src/lib/format";

// Behavioral fail-before: until `timezone` is added with a "UTC" default
// and threaded, this asserts the post-change contract.
describe("formatTimestamp timezone", () => {
  it("defaults to UTC and honors an explicit zone", () => {
    expect(formatTimestamp(0)).toContain("UTC");
    expect(formatTimestamp(0, "local")).toContain("local");
  });
});
