import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCorpusAcceptance, vitestRun } from "../src/index";

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

describe("vitestRun scoping (additive)", () => {
  function tmpTree(): string {
    const root = mkdtempSync(path.join(tmpdir(), "strata-vrun-"));
    mkdirSync(path.join(root, "tests"), { recursive: true });
    // Import-free config: the temp tree has no node_modules, so an
    // `import "vitest/config"` here only resolves when the surrounding
    // runner happens to leak a NODE_PATH — making the test pass or fail by
    // invocation context. A plain object export loads under any loader.
    writeFileSync(
      path.join(root, "vitest.config.ts"),
      'export default { test: { include: ["tests/**/*.test.ts"] } };\n'
    );
    writeFileSync(
      path.join(root, "tests", "pass.test.ts"),
      'import { expect, it } from "vitest";\nit("p", () => expect(1).toBe(1));\n'
    );
    writeFileSync(
      path.join(root, "tests", "fail.test.ts"),
      'import { expect, it } from "vitest";\nit("f", () => expect(1).toBe(2));\n'
    );
    return root;
  }

  it("empty fixture list skips vitest entirely (tsc-only task)", () => {
    const root = tmpTree();
    try {
      // fail.test.ts is red, but [] means 'no behavioral assertion'.
      expect(vitestRun(root, []).vitestPassed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs only the named fixture, ignoring an unrelated red file", () => {
    const root = tmpTree();
    try {
      expect(vitestRun(root, ["tests/pass.test.ts"]).vitestPassed).toBe(true);
      expect(vitestRun(root, ["tests/fail.test.ts"]).vitestPassed).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is fail-loud (not silent green) when a named fixture is missing", () => {
    const root = tmpTree();
    try {
      const r = vitestRun(root, ["tests/nope.test.ts"]);
      expect(r.vitestPassed).toBe(false);
      expect(r.output).toMatch(/not found/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("undefined fixtures preserves whole-suite behaviour (BG-3)", () => {
    const root = tmpTree();
    try {
      // whole suite includes fail.test.ts -> red, exactly as today.
      expect(vitestRun(root).vitestPassed).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runCorpusAcceptance scoping", () => {
  it("[] => vitest skipped, tsc-only; an unrelated seed red does NOT block", () => {
    const root = mkdtempSync(path.join(tmpdir(), "strata-acc-"));
    try {
      mkdirSync(path.join(root, "tests"), { recursive: true });
      writeFileSync(
        path.join(root, "vitest.config.ts"),
        'import { defineConfig } from "vitest/config";\n' +
          'export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });\n'
      );
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
        path.join(root, "tests", "other.test.ts"),
        'import { expect, it } from "vitest";\nit("x", () => expect(1).toBe(2));\n'
      );
      const rendered = new Map<string, string>([
        ["a.ts", "export const a: number = 1;\n"]
      ]);
      const r = runCorpusAcceptance(rendered, root, []);
      expect(r.tscClean).toBe(true);
      expect(r.vitestPassed).toBe(true); // [] means no behavioral assertion; seed red is irrelevant
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
