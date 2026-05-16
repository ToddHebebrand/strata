import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestBatch } from "@strata/ingest";
import { begin, insertNodes, insertReferences, openDb } from "@strata/store";
import { commitWithBehavioralGate } from "../src/index";

const created: string[] = [];

function makeCorpus(testBody: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "strata-bgate-"));
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
    JSON.stringify({ name: "bgate-fixture", private: true })
  );
  writeFileSync(
    path.join(root, "vitest.config.ts"),
    'import { defineConfig } from "vitest/config";\n' +
      'export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });\n'
  );
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "tests"), { recursive: true });
  writeFileSync(path.join(root, "tests", "a.test.ts"), testBody);
  return root;
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() as string, { recursive: true, force: true });
  }
});

describe("commitWithBehavioralGate", () => {
  it("refuses to finalize when the corpus tests fail, returning testFailures", () => {
    const root = makeCorpus(
      'import { describe, expect, it } from "vitest";\n' +
        'import { greet } from "../src/g";\n' +
        'describe("g", () => { it("greets", () => { expect(greet("x")).toBe("hi x"); }); });\n'
    );
    const srcRoot = path.join(root, "src");
    const gSource =
      'export function greet(n: string): string { return "bye " + n; }\n';
    // Mirror production: the corpus is always on disk, so validate()'s
    // tsconfig include glob is non-empty. The in-memory store is what gets
    // rendered and gated; this on-disk seed only satisfies config loading.
    writeFileSync(path.join(srcRoot, "g.ts"), gSource);
    const batch = ingestBatch([
      { path: path.join(srcRoot, "g.ts"), text: gSource }
    ]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);
    const tx = begin(db, "test");
    const result = commitWithBehavioralGate(db, tx, {
      corpusRoot: root,
      srcRoot,
      behavioralFixtures: ["tests/a.test.ts"]
    });
    expect(result.ok).toBe(false);
    if (result.ok === false && "testFailures" in result) {
      expect(result.testFailures.length).toBeGreaterThan(0);
    } else {
      throw new Error("expected testFailures failure shape");
    }
    db.close();
  });

  it("finalizes when tsc is clean and the corpus tests pass", () => {
    const root = makeCorpus(
      'import { describe, expect, it } from "vitest";\n' +
        'import { greet } from "../src/g";\n' +
        'describe("g", () => { it("greets", () => { expect(greet("x")).toBe("hi x"); }); });\n'
    );
    const srcRoot = path.join(root, "src");
    const gSource =
      'export function greet(n: string): string { return "hi " + n; }\n';
    writeFileSync(path.join(srcRoot, "g.ts"), gSource);
    const batch = ingestBatch([
      { path: path.join(srcRoot, "g.ts"), text: gSource }
    ]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);
    const tx = begin(db, "test");
    const result = commitWithBehavioralGate(db, tx, {
      corpusRoot: root,
      srcRoot,
      behavioralFixtures: ["tests/a.test.ts"]
    });
    expect(result.ok).toBe(true);
    db.close();
  });

  it("[] behavioralFixtures: tsc-only commit ignores an unrelated red test", () => {
    const root = makeCorpus(
      'import { describe, expect, it } from "vitest";\n' +
        'import { greet } from "../src/g";\n' +
        'describe("g", () => { it("greets", () => { expect(greet("x")).toBe("NOPE"); }); });\n'
    );
    const srcRoot = path.join(root, "src");
    const gSource =
      'export function greet(n: string): string { return "hi " + n; }\n';
    writeFileSync(path.join(srcRoot, "g.ts"), gSource);
    const batch = ingestBatch([
      { path: path.join(srcRoot, "g.ts"), text: gSource }
    ]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);
    const tx = begin(db, "test");
    const result = commitWithBehavioralGate(db, tx, {
      corpusRoot: root,
      srcRoot,
      behavioralFixtures: []
    });
    expect(result.ok).toBe(true); // BG-4 mechanism gone at the gate level
    db.close();
  });
});
