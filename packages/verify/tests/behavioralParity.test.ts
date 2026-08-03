// Behavioral rejection/parity gate — PRODUCT path (item-B2 Task 8, spec B-2
// gate c). This is an ACCEPTANCE gate against `commitWithBehavioralGate`'s
// already-landed behavior (consumed AS-IS, no changes here), not
// failing-first TDD. It drives the identical two mutations, over the
// identical fixture, as packages/live-compare/tests/behavioralGate.test.ts
// (the kernel path) — that is the parity oracle. THE STOP RULE: if the two
// gates disagree on either verdict, that divergence is the gate doing its
// job — report both verdicts verbatim, do not normalize.
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestBatch } from "@strata-code/ingest";
import { begin, find_declarations, insertNodes, insertReferences, openDb, rename_symbol } from "@strata-code/store";
import { commitWithBehavioralGate } from "../src/index";

const corpusSourceRoot = resolve(import.meta.dirname, "../../../examples/medium");

const FIXTURE_REL_PATH = "tests/behavioral/greet-contract.test.ts";
// Byte-identical to packages/live-compare/tests/behavioralGate.test.ts's
// fixture — see that file's header comment for why the email is
// "Ada@example.com" (capitalized, matching greet's real
// `` `hello ${user.email}` `` body) rather than the v1 brief's
// lowercase-email/unsound-cast skeleton.
const FIXTURE_BODY =
  'import { describe, expect, it } from "vitest";\n' +
  'import { greet } from "../../src/users/greet.ts";\n' +
  'import type { User } from "../../src/types/user.ts";\n' +
  "\n" +
  'describe("greet behavioral contract", () => {\n' +
  '  it("greets by name", () => {\n' +
  '    const user: User = { id: "u1", email: "Ada@example.com" };\n' +
  '    expect(greet(user)).toContain("Ada");\n' +
  "  });\n" +
  "});\n";

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) rmSync(created.pop() as string, { recursive: true, force: true });
});

// Same recursive-collect pattern as t03Criteria.test.ts.
function collect(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
      } else if (entry.endsWith(".ts")) {
        out.push({ path: abs, text: readFileSync(abs, "utf8") });
      }
    }
  }

  walk(rootDir);
  return out;
}

function buildParityCorpus(): { corpusRoot: string; srcRoot: string } {
  const corpusRoot = mkdtempSync(join(tmpdir(), "strata-bgate-parity-"));
  created.push(corpusRoot);
  cpSync(corpusSourceRoot, corpusRoot, {
    recursive: true,
    filter: (source) => basename(source) !== "node_modules"
  });
  mkdirSync(join(corpusRoot, "tests", "behavioral"), { recursive: true });
  writeFileSync(join(corpusRoot, FIXTURE_REL_PATH), FIXTURE_BODY, "utf8");
  return { corpusRoot, srcRoot: join(corpusRoot, "src") };
}

describe("commitWithBehavioralGate parity — product path (spec B-2 gate c)", () => {
  it("rejects the same compiles-but-behaviorally-wrong rename (greet -> welcomeUser)", () => {
    const { corpusRoot, srcRoot } = buildParityCorpus();
    const batch = ingestBatch(collect(srcRoot));
    const db = openDb(":memory:");
    try {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);
      const decls = find_declarations(db, { name: "greet", kind: "function" });
      expect(decls.length).toBe(1);
      const tx = begin(db, "parity-reject");
      rename_symbol(db, tx, decls[0]!.id, "welcomeUser");
      const result = commitWithBehavioralGate(db, tx, {
        corpusRoot,
        srcRoot,
        behavioralFixtures: [FIXTURE_REL_PATH],
        strictSrcOnlyTscScope: true
      });
      expect(result.ok).toBe(false);
      if (result.ok === false && "testFailures" in result) {
        expect(result.testFailures).toContain("greet");
      } else {
        throw new Error("expected testFailures failure shape");
      }
    } finally {
      db.close();
    }
  }, 60_000);

  it("publishes the same clean rename (User -> Account)", () => {
    const { corpusRoot, srcRoot } = buildParityCorpus();
    const batch = ingestBatch(collect(srcRoot));
    const db = openDb(":memory:");
    try {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);
      const decls = find_declarations(db, { name: "User", kind: "interface" });
      expect(decls.length).toBe(1);
      const tx = begin(db, "parity-clean");
      rename_symbol(db, tx, decls[0]!.id, "Account");
      const result = commitWithBehavioralGate(db, tx, {
        corpusRoot,
        srcRoot,
        behavioralFixtures: [FIXTURE_REL_PATH],
        strictSrcOnlyTscScope: true
      });
      expect(result.ok).toBe(true);
    } finally {
      db.close();
    }
  }, 60_000);
});
