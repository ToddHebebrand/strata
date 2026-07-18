/** MODEL-FREE pre-spend verification: does the import-complete per-scope
 *  op produce tsc-clean, test-passing output? (no API key) */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata-code/ingest";
import {
  openDb,
  insertNodes,
  insertReferences,
  begin,
  commitWithoutValidate,
  find_declarations
} from "@strata-code/store";
import { runCorpusAcceptance } from "@strata-code/verify";
import { applyPerScopeAddParameter } from "./experiments/perScopeAddParameter";
import { renderCommittedSrc } from "./experiment";

const CORPUS_ROOT = path.join(__dirname, "..", "corpus");
const SRC_ROOT = path.join(CORPUS_ROOT, "src");
function collectTsFiles(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...collectTsFiles(p));
    else if (p.endsWith(".ts")) out.push({ path: p, text: readFileSync(p, "utf8") });
  }
  return out;
}

const batch = ingestBatch(collectTsFiles(SRC_ROOT));
const db = openDb(":memory:");
insertNodes(db, batch.allNodes);
insertReferences(db, batch.references);

const fts = find_declarations(db, { name: "formatTimestamp", kind: "function" });
if (fts.length === 0) throw new Error("probe4: formatTimestamp not found");
const fid = fts[0]!.id;

const tx = begin(db, "probe4");
// Exactly what an agent SHOULD pass once it has read each scope's config:
const manifest = applyPerScopeAddParameter(
  db,
  tx,
  fid,
  "timezone",
  "string",
  1,
  '"UTC"',
  {
    "src/server/": { expr: "ZONE", importFrom: "./config.ts" },
    "src/ui/": { expr: "ZONE", importFrom: "./config.ts" }
  }
);
commitWithoutValidate(db, tx);

const renderedSrcPrefixed = renderCommittedSrc(db, SRC_ROOT);
const get = (k: string): string =>
  renderedSrcPrefixed.get(k) ?? `<<missing ${k}>>`;
// runCorpusAcceptance wants srcRoot-relative keys (no "src/" prefix);
// renderCommittedSrc uses "src/"-prefixed keys for the HD scorer's scopeOf.
const rendered = new Map(
  [...renderedSrcPrefixed].map(([k, v]) => [k.replace(/^src\//, ""), v])
);

console.log("=== rendered src/server/events.ts ===");
console.log(get("src/server/events.ts"));
console.log("=== rendered src/ui/timeline.ts ===");
console.log(get("src/ui/timeline.ts"));
console.log("=== rendered src/lib/startupStamp.ts ===");
console.log(get("src/lib/startupStamp.ts"));
console.log("=== rendered src/lib/format.ts (signature) ===");
console.log(get("src/lib/format.ts"));

const accept = runCorpusAcceptance(rendered, CORPUS_ROOT);
console.log("\n=== runCorpusAcceptance ===");
console.log(JSON.stringify(accept, null, 2).slice(0, 600));
const ok = accept.tscClean === true && accept.vitestPassed === true;
if (!ok) {
  console.log("\n--- failureOutput (truncated) ---");
  console.log(String(accept.failureOutput ?? "").slice(0, 2200));
}
console.log(
  `\n=== VERDICT === tscClean=${accept.tscClean} vitestPassed=${accept.vitestPassed} ` +
    `callsitesRewritten=${manifest.callsitesRewritten.length} OK=${ok}`
);
