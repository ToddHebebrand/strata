import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import { renderWithSourceMap } from "@strata/render";
import {
  begin,
  find_declarations,
  insertNodes,
  insertReferences,
  loadModule,
  openDb,
  rename_symbol
} from "@strata/store";
import { commit, evaluateT03Criteria } from "@strata/verify";
import { describe, expect, it } from "vitest";
import {
  scoreBaselineWorkingTree,
  type SharedCriteria
} from "../src/score";

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

describe("scorer equivalence (BS-Bench-B gate)", () => {
  it("substrate path and baseline file adapter score the ten shared criteria identically", () => {
    const corpusRoot = path.resolve(__dirname, "../../../examples/medium");
    const srcRoot = path.join(corpusRoot, "src");
    const batch = ingestBatch(collect(srcRoot));
    const db = openDb(":memory:");

    try {
      insertNodes(db, batch.allNodes);
      insertReferences(db, batch.references);
      const decl = find_declarations(db, {
        name: "User",
        kind: "interface"
      })[0]!;
      const tx = begin(db, "equiv");
      rename_symbol(db, tx, decl.id, "Account");
      const commitResult = commit(db, tx);
      expect(commitResult.ok).toBe(true);

      const substrateFull = evaluateT03Criteria(db, batch, srcRoot, {
        commitReturnedOk: commitResult.ok === true,
        validateAfterCommitClean: true,
        renameTxId: tx.id
      });

      const tmp = mkdtempSync(path.join(tmpdir(), "strata-equiv-"));
      const tmpSrc = path.join(tmp, "src");
      for (const module of batch.modules) {
        const rel = path.relative(srcRoot, module.path).replaceAll("\\", "/");
        const loaded = loadModule(db, module.moduleId);
        const text = renderWithSourceMap(
          loaded.module,
          loaded.children
        ).text;
        const dest = path.join(tmpSrc, rel);
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, text);
      }

      const baseline: SharedCriteria = scoreBaselineWorkingTree({
        srcRoot: tmpSrc,
        commitReturnedOk: commitResult.ok === true,
        validateAfterCommitClean: true
      });

      const substrate: SharedCriteria = {
        commitReturnedOk: substrateFull.commitReturnedOk,
        validateAfterCommitClean: substrateFull.validateAfterCommitClean,
        importRenamed: substrateFull.importRenamed,
        typeAnnotationRenamed: substrateFull.typeAnnotationRenamed,
        genericPromiseRenamed: substrateFull.genericPromiseRenamed,
        namespaceImportRenamed: substrateFull.namespaceImportRenamed,
        auditLiteralUntouched: substrateFull.auditLiteralUntouched,
        auditLiteralOnlyRemainingUser:
          substrateFull.auditLiteralOnlyRemainingUser,
        indexReExportRenamed: substrateFull.indexReExportRenamed,
        jsdocReferencesRenamed: substrateFull.jsdocReferencesRenamed
      };

      expect(baseline).toEqual(substrate);
      for (const [key, value] of Object.entries(baseline)) {
        expect(value, `shared criterion ${key}`).toBe(true);
      }
    } finally {
      db.close();
    }
  });
});
