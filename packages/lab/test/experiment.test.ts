import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import { insertNodes, insertReferences, openDb } from "@strata/store";
import { scopeOf } from "../src/tasks/callsites";
import type { LabExperiment } from "../src/experiment";
import { makeLabScorer, renderCommittedSrc } from "../src/experiment";

describe("experiment interface", () => {
  it("makeLabScorer adapts the HD oracle into a LabCriteria scorer", () => {
    const score = makeLabScorer("HD");
    const c = score(
      undefined as any,
      undefined as any,
      "",
      { commitReturnedOk: false, validateAfterCommitClean: false, txId: "t" } as any
    );
    expect(c).toHaveProperty("labOk");
    expect(c).toHaveProperty("commitReturnedOk");
  });

  it("a LabExperiment is a self-contained unit", () => {
    const exp: LabExperiment = {
      id: "noop",
      hypothesis: "control: canonical tools, expect HD fail (no per-scope expressiveness)",
      task: "HD",
      overrides: {}
    };
    expect(exp.task).toBe("HD");
  });
});

// ---------------------------------------------------------------------------
// Real-render path: corpus-root-relative posix keys with src/ prefix
// ---------------------------------------------------------------------------

const CORPUS_ROOT = path.join(__dirname, "..", "corpus");
const SRC_ROOT = path.join(CORPUS_ROOT, "src");

function collectTsFiles(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  function walk(d: string): void {
    for (const entry of readdirSync(d).sort()) {
      const abs = path.join(d, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith(".ts")) out.push({ path: abs, text: readFileSync(abs, "utf8") });
    }
  }
  walk(dir);
  return out;
}

function buildCorpusStore(): ReturnType<typeof openDb> {
  const files = collectTsFiles(SRC_ROOT);
  const batch = ingestBatch(files);
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  return db;
}

describe("experiment real-render path (src/-prefixed posix keys)", () => {
  it("rendered map keys are src/-prefixed posix paths, and scopes bucket correctly", () => {
    const db = buildCorpusStore();
    try {
      // Call the REAL exported renderCommittedSrc — not a mirror.
      const rendered = renderCommittedSrc(db, SRC_ROOT);

      // Map must be non-empty and contain the three expected files.
      expect(rendered.size).toBeGreaterThan(0);

      // 1. All keys start with "src/"
      for (const key of rendered.keys()) {
        expect(key, `key should start with src/: ${key}`).toMatch(/^src\//);
      }

      // 2. server/events.ts is present and scopes as "server"
      expect(rendered.has("src/server/events.ts"), "src/server/events.ts must be in rendered keys").toBe(true);
      expect(scopeOf("src/server/events.ts")).toBe("server");

      // 3. ui/timeline.ts is present and scopes as "ui"
      expect(rendered.has("src/ui/timeline.ts"), "src/ui/timeline.ts must be in rendered keys").toBe(true);
      expect(scopeOf("src/ui/timeline.ts")).toBe("ui");

      // 4. lib/startupStamp.ts is present and scopes as "other"
      expect(rendered.has("src/lib/startupStamp.ts"), "src/lib/startupStamp.ts must be in rendered keys").toBe(true);
      expect(scopeOf("src/lib/startupStamp.ts")).toBe("other");
    } finally {
      db.close();
    }
  });

  it("makeLabScorer('HD') does not throw on a real corpus store and returns a LabCriteria", () => {
    const files = collectTsFiles(SRC_ROOT);
    const batch = ingestBatch(files);
    const db = openDb(":memory:");
    try {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);

      const score = makeLabScorer("HD");
      const result = score(
        db,
        batch,
        SRC_ROOT,
        { commitReturnedOk: false, validateAfterCommitClean: false, txId: "t" } as any
      );

      expect(result).toHaveProperty("commitReturnedOk", false);
      expect(result).toHaveProperty("validateAfterCommitClean", false);
      expect(result).toHaveProperty("operationRowAppended", false);
      // labOk is a boolean — pre-task corpus (no HD changes) → false
      expect(typeof result.labOk).toBe("boolean");
    } finally {
      db.close();
    }
  });
});
