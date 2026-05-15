import { describe, expect, expectTypeOf, it } from "vitest";
import { formatTimestamp } from "../src/lib/format.ts";
import { logEvent } from "../src/server/events.ts";

describe("formatTimestamp timezone parameter (T01)", () => {
  it("accepts an optional timezone that defaults to UTC", () => {
    expectTypeOf(formatTimestamp).parameter(1).toEqualTypeOf<string | undefined>();
    const t = Date.UTC(2020, 0, 1, 12, 0, 0);
    expect(formatTimestamp(t)).toContain("2020-01-01");
    expect(formatTimestamp(t, "UTC")).toContain("2020-01-01");
  });

  it("server callsites format without throwing (UTC wiring)", () => {
    expect(logEvent(Date.UTC(2020, 0, 1), "login")).toContain("login");
  });
});
