import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { materializeCorpus } from "../src/configs/baseline";
import { tscNoEmit, vitestRun } from "../src/quality";

const CORPUS = path.resolve(__dirname, "../../../examples/medium");

describe("seed tsc-clean invariant (R1, no model, no key)", () => {
  it("unmodified seed src is tsc --noEmit clean under the corpus tsconfig", () => {
    const { root } = materializeCorpus(CORPUS, { initGit: false });
    try {
      expect(tscNoEmit(root).tscClean).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("corpus tsconfig include is src-only while tests are excluded from typecheck", () => {
    const tsconfig = JSON.parse(
      readFileSync(path.join(CORPUS, "tsconfig.json"), "utf8")
    ) as { include: string[] };
    expect(tsconfig.include).toEqual(["src/**/*.ts"]);
    expect(tsconfig.include.some((glob) => glob.includes("tests/"))).toBe(
      false
    );
  });

  it("tests/ stays on disk, in vitest.config.ts include, and remains a real fail-before signal", () => {
    expect(existsSync(path.join(CORPUS, "tests", "format.test.ts"))).toBe(
      true
    );
    expect(existsSync(path.join(CORPUS, "tests", "dateRange.test.ts"))).toBe(
      true
    );
    const vitestConfig = readFileSync(
      path.join(CORPUS, "vitest.config.ts"),
      "utf8"
    );
    expect(vitestConfig).toContain('include: ["tests/**/*.test.ts"]');

    const { root } = materializeCorpus(CORPUS, { initGit: false });
    try {
      expect(vitestRun(root).vitestPassed).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
