import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import {
  begin,
  find_declarations,
  insertNodes,
  insertReferences,
  openDb,
  rename_symbol,
  rollback
} from "@strata/store";
import {
  commit,
  emptyT03Criteria,
  evaluateT03Criteria,
  validate,
  type Diagnostic,
  type T03Criteria
} from "@strata/verify";

export interface RunT03Input {
  corpusRoot: string;
}

export interface RunT03Result {
  commitOk: boolean;
  diagnostics?: Diagnostic[];
  wallTimeMs: number;
  criteria: T03Criteria;
}

export function runT03(input: RunT03Input): RunT03Result {
  const started = performance.now();
  const srcRoot = path.join(input.corpusRoot, "src");
  const modules = collectTsFiles(srcRoot);
  const batch = ingestBatch(modules);
  const db = openDb(":memory:");

  try {
    insertNodes(db, batch.allNodes);
    insertReferences(db, batch.references);

    const declarations = find_declarations(db, {
      name: "User",
      kind: "interface"
    });
    if (declarations.length !== 1) {
      throw new Error(
        `Expected exactly one InterfaceDeclaration named User; got ${declarations.length}`
      );
    }

    const tx = begin(db, "t03");
    rename_symbol(db, tx, declarations[0]!.id, "Account");
    const commitResult = commit(db, tx);
    if (!commitResult.ok) {
      return {
        commitOk: false,
        diagnostics: commitResult.diagnostics,
        wallTimeMs: elapsed(started),
        criteria: emptyT03Criteria()
      };
    }

    const checkTx = begin(db, "t03-check");
    const postCommitDiagnostics = validate(db, checkTx);
    rollback(db, checkTx);

    const criteria = evaluateT03Criteria(db, batch, srcRoot, {
      commitReturnedOk: commitResult.ok === true,
      validateAfterCommitClean: postCommitDiagnostics.length === 0,
      renameTxId: tx.id
    });

    return {
      commitOk: true,
      wallTimeMs: elapsed(started),
      criteria
    };
  } finally {
    db.close();
  }
}

function collectTsFiles(rootDir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const absolutePath = path.join(dir, entry);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        walk(absolutePath);
      } else if (entry.endsWith(".ts")) {
        out.push({
          path: absolutePath,
          text: readFileSync(absolutePath, "utf8")
        });
      }
    }
  }

  walk(rootDir);
  return out;
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 10) / 10;
}
