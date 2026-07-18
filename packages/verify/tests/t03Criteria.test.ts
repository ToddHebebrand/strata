import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata-code/ingest";
import {
  begin,
  find_declarations,
  insertNodes,
  insertReferences,
  openDb,
  rename_symbol
} from "@strata-code/store";
import { commit, evaluateT03Criteria } from "@strata-code/verify";
import { describe, expect, it } from "vitest";

function collect(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const abs = path.join(dir, entry);
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

describe("evaluateT03Criteria", () => {
  it("returns all 11 criteria true after a correct programmatic rename", () => {
    const corpusRoot = path.resolve(__dirname, "../../../examples/medium");
    const srcRoot = path.join(corpusRoot, "src");
    const batch = ingestBatch(collect(srcRoot));
    const db = openDb(":memory:");
    try {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);
      const decls = find_declarations(db, {
        name: "User",
        kind: "interface"
      });
      const tx = begin(db, "t03");
      rename_symbol(db, tx, decls[0]!.id, "Account");
      const commitResult = commit(db, tx);
      expect(commitResult.ok).toBe(true);

      const criteria = evaluateT03Criteria(db, batch, srcRoot, {
        commitReturnedOk: commitResult.ok === true,
        validateAfterCommitClean: true,
        renameTxId: tx.id
      });
      for (const [key, value] of Object.entries(criteria)) {
        expect(value, `criterion ${key}`).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("returns criteria false when no rename was applied", () => {
    const corpusRoot = path.resolve(__dirname, "../../../examples/medium");
    const srcRoot = path.join(corpusRoot, "src");
    const batch = ingestBatch(collect(srcRoot));
    const db = openDb(":memory:");
    try {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);
      const criteria = evaluateT03Criteria(db, batch, srcRoot, {
        commitReturnedOk: false,
        validateAfterCommitClean: false,
        renameTxId: "none"
      });

      expect(criteria.commitReturnedOk).toBe(false);
      expect(criteria.validateAfterCommitClean).toBe(false);
      expect(criteria.importRenamed).toBe(false);
      expect(criteria.indexReExportRenamed).toBe(false);
      expect(criteria.operationRowAppended).toBe(false);
    } finally {
      db.close();
    }
  });
});
