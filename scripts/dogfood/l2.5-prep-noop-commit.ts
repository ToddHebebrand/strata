import { openDb, begin, rollback } from "@strata-code/store";
import { commit } from "@strata-code/verify";

const dbPath = process.argv[2];
const corpusRoot = process.argv[3];
if (!dbPath || !corpusRoot) {
  console.error("Usage: tsx scripts/l2.5-prep-noop-commit.ts <db> <corpusRoot>");
  process.exit(2);
}

const db = openDb(dbPath);
const tx = begin(db, "l2.5-prep-smoke");  // begin(db, actor, triggeringPrompt?)

try {
  const result = commit(db, tx);
  console.log(JSON.stringify({ ok: result.ok, diagnostics: (result as any).diagnostics ?? [] }, null, 2));
} catch (err) {
  console.error("commit threw:", (err as Error).message);
  try { rollback(db, tx); } catch {}
  process.exit(1);
}
