import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCorpusAcceptance } from "../src/index";

const created: string[] = [];

function makeCorpus(): string {
  const root = mkdtempSync(path.join(tmpdir(), "strata-corpustest-"));
  created.push(root);
  writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true
      },
      include: ["src/**/*.ts"]
    })
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "corpus-fixture", private: true })
  );
  writeFileSync(
    path.join(root, "vitest.config.ts"),
    'import { defineConfig } from "vitest/config";\n' +
      'export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });\n'
  );
  mkdirSync(path.join(root, "tests"), { recursive: true });
  writeFileSync(
    path.join(root, "tests", "sum.test.ts"),
    'import { describe, expect, it } from "vitest";\n' +
      'import { sum } from "../src/sum";\n' +
      'describe("sum", () => { it("adds", () => { expect(sum(2, 3)).toBe(5); }); });\n'
  );
  return root;
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

describe("runCorpusAcceptance", () => {
  it("passes when rendered src makes the corpus tests green", () => {
    const root = makeCorpus();
    const rendered = new Map<string, string>([
      ["sum.ts", "export function sum(a: number, b: number): number { return a + b; }"]
    ]);
    const result = runCorpusAcceptance(rendered, root);
    expect(result.tscClean).toBe(true);
    expect(result.vitestPassed).toBe(true);
  });

  it("fails (tests red) and captures output when behavior is wrong", () => {
    const root = makeCorpus();
    const rendered = new Map<string, string>([
      ["sum.ts", "export function sum(a: number, b: number): number { return a - b; }"]
    ]);
    const result = runCorpusAcceptance(rendered, root);
    expect(result.vitestPassed).toBe(false);
    expect(result.failureOutput.length).toBeGreaterThan(0);
  });

  it("fails closed on an empty render", () => {
    const root = makeCorpus();
    const result = runCorpusAcceptance(new Map(), root);
    expect(result.tscClean).toBe(false);
    expect(result.vitestPassed).toBe(false);
    expect(result.failureOutput).toContain("no modules rendered");
  });
});
