import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestBatch } from "@strata-code/ingest";
import { insertNodes, openDb } from "@strata-code/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildModuleIndex } from "../src/moduleIndex";

interface Fixture {
  corpusRoot: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const corpusRoot = mkdtempSync(path.join(tmpdir(), "strata-mi-"));
  mkdirSync(path.join(corpusRoot, "src"), { recursive: true });
  return {
    corpusRoot,
    cleanup: () => rmSync(corpusRoot, { recursive: true, force: true })
  };
}

function writeSrc(corpusRoot: string, relPath: string, text: string): string {
  const abs = path.join(corpusRoot, "src", relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
  return abs;
}

describe("buildModuleIndex", () => {
  let fix: Fixture;

  beforeEach(() => {
    fix = makeFixture();
  });

  afterEach(() => {
    fix.cleanup();
  });

  it("lists every module's declarations with kind, name, and export tag", () => {
    const a = writeSrc(
      fix.corpusRoot,
      "lib/dateRange.ts",
      "export function isWithinRange(t: number, lo: number, hi: number): boolean {\n" +
        "  return t >= lo && t <= hi;\n" +
        "}\n"
    );
    const b = writeSrc(
      fix.corpusRoot,
      "lib/format.ts",
      "export function formatTimestamp(ts: number): string {\n" +
        "  return new Date(ts).toISOString();\n" +
        "}\n"
    );
    const c = writeSrc(
      fix.corpusRoot,
      "types/user.ts",
      "export interface User { id: string; }\n" +
        "export type UserRole = 'admin' | 'user';\n"
    );

    const batch = ingestBatch([
      { path: a, text: require("node:fs").readFileSync(a, "utf8") },
      { path: b, text: require("node:fs").readFileSync(b, "utf8") },
      { path: c, text: require("node:fs").readFileSync(c, "utf8") }
    ]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);

    const index = buildModuleIndex(db, fix.corpusRoot);

    expect(index).toContain("src/lib/dateRange.ts:");
    expect(index).toContain("function isWithinRange [exported]");
    expect(index).toContain("src/lib/format.ts:");
    expect(index).toContain("function formatTimestamp [exported]");
    expect(index).toContain("src/types/user.ts:");
    expect(index).toContain("interface User [exported]");
    expect(index).toContain("type UserRole [exported]");
    expect(index.endsWith("\n")).toBe(true);

    db.close();
  });

  it("omits the [exported] tag for non-exported declarations", () => {
    const f = writeSrc(
      fix.corpusRoot,
      "internal.ts",
      "function privateHelper(): number {\n  return 42;\n}\n" +
        "export function publicEntry(): number {\n  return privateHelper();\n}\n"
    );
    const batch = ingestBatch([
      { path: f, text: require("node:fs").readFileSync(f, "utf8") }
    ]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);

    const index = buildModuleIndex(db, fix.corpusRoot);

    expect(index).toMatch(/function privateHelper(?! \[exported\])/);
    expect(index).toContain("function publicEntry [exported]");

    db.close();
  });

  it("lists test files under tests/ and test/ in the tests/ section", () => {
    writeSrc(
      fix.corpusRoot,
      "x.ts",
      "export function x(): number { return 1; }\n"
    );
    mkdirSync(path.join(fix.corpusRoot, "tests"), { recursive: true });
    mkdirSync(path.join(fix.corpusRoot, "test"), { recursive: true });
    writeFileSync(
      path.join(fix.corpusRoot, "tests", "alpha.test.ts"),
      "// test\n"
    );
    writeFileSync(
      path.join(fix.corpusRoot, "test", "beta.spec.ts"),
      "// test\n"
    );
    writeFileSync(
      path.join(fix.corpusRoot, "tests", "ignored.txt"),
      "ignored\n"
    );

    const xPath = path.join(fix.corpusRoot, "src", "x.ts");
    const batch = ingestBatch([
      {
        path: xPath,
        text: require("node:fs").readFileSync(xPath, "utf8")
      }
    ]);
    const db = openDb(":memory:");
    insertNodes(db, batch.allNodes);

    const index = buildModuleIndex(db, fix.corpusRoot);

    expect(index).toContain("tests/ (not in graph, use read_test_file):");
    expect(index).toContain("tests/alpha.test.ts");
    expect(index).toContain("test/beta.spec.ts");
    expect(index).not.toContain("ignored.txt");

    db.close();
  });

  it("returns an empty-but-well-formed string for an empty corpus", () => {
    const db = openDb(":memory:");
    const index = buildModuleIndex(db, fix.corpusRoot);

    expect(index).toContain("Codebase shape");
    expect(index).toContain("(empty)");
    expect(index).toContain("tests/ (not in graph, use read_test_file):");
    expect(index).toContain("(none)");
    expect(index.endsWith("\n")).toBe(true);

    db.close();
  });
});
