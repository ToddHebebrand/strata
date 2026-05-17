/** MODEL-FREE: replicate the agent's exact committed change, then run the
 *  HD scorer and print the PER-CALLSITE verdict to pinpoint why labOk=false
 *  (inspection, not inference). No API key. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ingestBatch } from "@strata/ingest";
import {
  openDb,
  insertNodes,
  insertReferences,
  begin,
  commitWithoutValidate,
  find_declarations
} from "@strata/store";
import { applyPerScopeAddParameter } from "./experiments/perScopeAddParameter";
import { renderCommittedSrc } from "./experiment";
import { scoreHonestDerivable, deriveOracle } from "./tasks/honestDerivable";

const SRC_ROOT = path.join(__dirname, "..", "corpus", "src");
function collect(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else if (p.endsWith(".ts")) out.push({ path: p, text: readFileSync(p, "utf8") });
  }
  return out;
}

const batch = ingestBatch(collect(SRC_ROOT));
const db = openDb(":memory:");
insertNodes(db, batch.allNodes);
insertReferences(db, batch.references);
const fid = find_declarations(db, { name: "formatTimestamp", kind: "function" })[0]!.id;

const tx = begin(db, "probe5");
applyPerScopeAddParameter(
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
  },
  true // omitUnmatched: other-scope callsites take the param default
);
commitWithoutValidate(db, tx);

const rendered = renderCommittedSrc(db, SRC_ROOT);
const verdict = scoreHonestDerivable(rendered);
console.log("oracle.scopes:", JSON.stringify(deriveOracle().scopes));
console.log("HD pass:", verdict.pass);
console.log("per-callsite:");
for (const c of verdict.perCallsite) {
  console.log(
    `  ${c.ok ? "OK " : "BAD"}  ${c.path}  expected=${JSON.stringify(
      c.expected
    )} got=${JSON.stringify(c.got)}`
  );
}
