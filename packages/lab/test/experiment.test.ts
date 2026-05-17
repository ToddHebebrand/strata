import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import { listModules, loadModule, insertNodes, insertReferences, openDb } from "@strata/store";
import { renderWithSourceMap } from "@strata/render";
import { scopeOf } from "../src/tasks/callsites";
import type { LabExperiment } from "../src/experiment";
import { makeLabScorer } from "../src/experiment";

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

/**
 * Build the rendered map the same way renderCommittedSrc does: listModules,
 * loadModule, renderWithSourceMap — then relativize to corpusRoot so keys
 * are "src/"-prefixed. This mirrors experiment.ts internals directly and
 * proves the key format is correct for scopeOf().
 */
function buildRenderedKeys(db: ReturnType<typeof openDb>, corpusRoot: string): string[] {
  const modules = listModules(db);
  const corpusRootPosix = corpusRoot.replaceAll("\\", "/");
  const keys: string[] = [];
  for (const mod of modules) {
    const loaded = loadModule(db, mod.id);
    void renderWithSourceMap(loaded.module, loaded.children).text;
    // Replicate the key logic in renderCommittedSrc:
    // corpusRoot-relative posix path (adds "src/" prefix).
    const posixPayload = mod.payload.replaceAll("\\", "/");
    // path.relative produces OS-sep; we need posix:
    const key = posixPayload.startsWith(corpusRootPosix + "/")
      ? posixPayload.slice(corpusRootPosix.length + 1)
      : path.relative(corpusRoot, mod.payload).replaceAll("\\", "/");
    keys.push(key);
  }
  return keys;
}

describe("experiment real-render path (src/-prefixed posix keys)", () => {
  it("rendered map keys are src/-prefixed posix paths, and scopes bucket correctly", () => {
    const files = collectTsFiles(SRC_ROOT);
    const batch = ingestBatch(files);
    const db = openDb(":memory:");
    try {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);

      const keys = buildRenderedKeys(db, CORPUS_ROOT);

      // 1. All keys start with "src/"
      for (const key of keys) {
        expect(key, `key should start with src/: ${key}`).toMatch(/^src\//);
      }

      // 2. server/events.ts is present and scopes as "server"
      const serverKey = keys.find((k) => k === "src/server/events.ts");
      expect(serverKey, "src/server/events.ts must be in rendered keys").toBeDefined();
      expect(scopeOf(serverKey!)).toBe("server");

      // 3. ui/timeline.ts is present and scopes as "ui"
      const uiKey = keys.find((k) => k === "src/ui/timeline.ts");
      expect(uiKey, "src/ui/timeline.ts must be in rendered keys").toBeDefined();
      expect(scopeOf(uiKey!)).toBe("ui");

      // 4. lib/startupStamp.ts scopes as "other"
      const otherKey = keys.find((k) => k === "src/lib/startupStamp.ts");
      expect(otherKey, "src/lib/startupStamp.ts must be in rendered keys").toBeDefined();
      expect(scopeOf(otherKey!)).toBe("other");
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
