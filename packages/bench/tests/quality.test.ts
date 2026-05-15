import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import {
  begin,
  find_declarations,
  insertNodes,
  insertReferences,
  openDb,
  rename_symbol
} from "@strata/store";
import { commit } from "@strata/verify";
import { describe, expect, it } from "vitest";
import { renderStoreToDir, tscNoEmit } from "../src/quality";

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

describe("renderStoreToDir + tscNoEmit (no model, no key)", () => {
  it("renders committed modules to a scratch dir that tsc accepts clean", () => {
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
      const tx = begin(db, "quality");
      rename_symbol(db, tx, decl.id, "Account");
      expect(commit(db, tx).ok).toBe(true);

      const out = mkdtempSync(path.join(tmpdir(), "strata-quality-"));
      const outSrc = renderStoreToDir(db, batch, srcRoot, out, corpusRoot);
      const result = tscNoEmit(out);
      expect(result.tscClean).toBe(true);
      expect(
        readFileSync(path.join(outSrc, "types", "user.ts"), "utf8")
      ).toContain("interface Account");
    } finally {
      db.close();
    }
  });
});
