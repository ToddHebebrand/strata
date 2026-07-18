import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("store has no forbidden runtime package imports", () => {
  it("store package.json declares neither @strata-code/ingest nor @strata-code/render as a runtime dependency", () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(__dirname, "../package.json"), "utf8")
    ) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps).not.toContain("@strata-code/ingest");
    expect(deps).not.toContain("@strata-code/render");
  });
});
