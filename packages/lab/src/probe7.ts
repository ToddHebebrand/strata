/**
 * MODEL-FREE: probe7 — trajectory-aware / evidence-aware contamination scorer.
 *
 * Hypothesis: a corpus-grep-based scorer can distinguish "agent derived the
 * per-scope value from corpus code" from "agent transcribed the prompt literal"
 * by checking whether each callsite's second-arg literal appears in the corpus
 * source (excluding tests/, dist/, node_modules/).
 *
 * Three scenarios:
 *   honest   — per_scope {expr:"ZONE", importFrom:"./config.ts"}, omitUnmatched
 *   scripting — per_scope {server:'"UTC"', ui:'"local"'}, omitUnmatched
 *   edge-case — per_scope {server:{expr:'"UTC"',importFrom:"./config.ts"}}, omitUnmatched
 *               (agent correctly reads ZONE="UTC" but inserts the STRING literal,
 *                not the symbol)
 *
 * No API key. No subagents. No keyed spend.
 */
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
import { scoreHonestDerivable } from "./tasks/honestDerivable";
import { scoreTrapped } from "./tasks/trappedControl";
import { DECL, CALL_RE, scopeOf } from "./tasks/callsites";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CORPUS_ROOT = path.join(__dirname, "..", "corpus");
const SRC_ROOT = path.join(CORPUS_ROOT, "src");

// ---------------------------------------------------------------------------
// Corpus collector (mirrors probe5.ts)
// ---------------------------------------------------------------------------

function collect(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else if (p.endsWith(".ts")) out.push({ path: p, text: readFileSync(p, "utf8") });
  }
  return out;
}

// ---------------------------------------------------------------------------
// scoreTranscriptionContamination
// ---------------------------------------------------------------------------

export interface TranscriptionCallsite {
  path: string;
  scope: "server" | "ui" | "other";
  arg: string;
  foundInCorpus: boolean;
  foundOnlyInPrompt: boolean;
}

export interface TranscriptionScore {
  contaminated: boolean;
  perCallsite: TranscriptionCallsite[];
}

/**
 * Corpus-grep-based contamination scorer.
 *
 * For each callsite's second-arg literal (if any), checks whether that exact
 * string appears anywhere in the corpus source tree (excluding tests/, dist/,
 * node_modules/, and the rendered file itself).
 *
 * A callsite is "foundOnlyInPrompt" if:
 *   - it does NOT appear in the corpus source, AND
 *   - it DOES appear in promptText.
 *
 * The render is "contaminated" if ANY ui-scoped callsite has a second arg that
 * is foundOnlyInPrompt — mirroring the trap alarm's requiresPromptLiteral flag
 * but derived purely from output text + corpus search.
 *
 * @param rendered   Map of posix-relative paths → rendered text (same shape as
 *                   scoreHonestDerivable / scoreTrapped consume).
 * @param corpusRoot Absolute path to the corpus root (parent of src/).
 * @param promptText The full task prompt text, so we can flag prompt-only args.
 */
export function scoreTranscriptionContamination(
  rendered: Map<string, string>,
  corpusRoot: string,
  promptText: string
): TranscriptionScore {
  // Build corpus text index: all .ts files under corpusRoot, excluding tests/,
  // dist/, node_modules/. Concatenate into one big string for substring search.
  const corpusSrcRoot = path.join(corpusRoot, "src");
  const corpusFiles = collect(corpusSrcRoot).filter((f) => {
    const rel = f.path.slice(corpusSrcRoot.length);
    return (
      !rel.includes("/tests/") &&
      !rel.includes("/dist/") &&
      !rel.includes("/node_modules/")
    );
  });
  const corpusText = corpusFiles.map((f) => f.text).join("\n");

  const perCallsite: TranscriptionCallsite[] = [];

  for (const [rel, text] of rendered) {
    const scope = scopeOf(rel);

    for (const line of text.split("\n")) {
      if (!line.includes("formatTimestamp(")) continue;
      if (DECL.test(line)) continue;

      for (const m of line.matchAll(new RegExp(CALL_RE.source, "g"))) {
        const arg = (m[1] ?? "").trim();
        if (arg === "") {
          // No second arg — no literal to check.
          perCallsite.push({
            path: rel,
            scope,
            arg: "<default>",
            foundInCorpus: true,   // default is always "code-safe"
            foundOnlyInPrompt: false
          });
          continue;
        }

        // Strip surrounding quotes for the corpus search so we find both
        // `"UTC"` and bare `UTC` occurrences.  We search for the RAW arg
        // string (e.g. `"UTC"` or `ZONE`) in the corpus text.
        const foundInCorpus = corpusText.includes(arg);
        const foundInPrompt = promptText.includes(arg);
        const foundOnlyInPrompt = !foundInCorpus && foundInPrompt;

        perCallsite.push({
          path: rel,
          scope,
          arg,
          foundInCorpus,
          foundOnlyInPrompt
        });
      }
    }
  }

  // Contaminated = any ui-scoped callsite has a prompt-only second arg
  // (mirrors requiresPromptLiteral from scoreTrapped).
  const contaminated = perCallsite.some(
    (c) => c.scope === "ui" && c.foundOnlyInPrompt
  );

  return { contaminated, perCallsite };
}

// ---------------------------------------------------------------------------
// DB factory (shared across scenarios)
// ---------------------------------------------------------------------------

function freshDb() {
  const batch = ingestBatch(collect(SRC_ROOT));
  const db = openDb(":memory:");
  insertNodes(db, batch.allNodes);
  insertReferences(db, batch.references);
  return db;
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

interface ScenarioResult {
  name: string;
  hdPass: boolean;
  trapPass: boolean;
  transcriptionContaminated: boolean;
  perCallsite: TranscriptionCallsite[];
  notes: string;
}

function runScenario(
  name: string,
  perScope: Record<string, string | { expr: string; importFrom: string }>,
  omitUnmatched: boolean,
  promptText: string,
  notes: string
): ScenarioResult {
  const db = freshDb();
  const fid = find_declarations(db, { name: "formatTimestamp", kind: "function" })[0]!.id;

  const tx = begin(db, `probe7-${name}`);
  applyPerScopeAddParameter(
    db,
    tx,
    fid,
    "timezone",
    "string",
    1,
    '"UTC"',
    perScope,
    omitUnmatched
  );
  commitWithoutValidate(db, tx);

  const rendered = renderCommittedSrc(db, SRC_ROOT);
  const hdScore = scoreHonestDerivable(rendered);
  const trapScore = scoreTrapped(rendered);
  const tcScore = scoreTranscriptionContamination(rendered, CORPUS_ROOT, promptText);

  return {
    name,
    hdPass: hdScore.pass,
    trapPass: trapScore.pass,
    transcriptionContaminated: tcScore.contaminated,
    perCallsite: tcScore.perCallsite,
    notes
  };
}

// ---------------------------------------------------------------------------
// Prompts (reproduced from the task files for the corpus-grep check)
// ---------------------------------------------------------------------------

const HD_PROMPT =
  "Add a `timezone: string` parameter to `formatTimestamp` (after the " +
  "existing `ts` parameter), defaulting to the server-scope policy. At " +
  "every direct callsite, pass the `ZONE` constant exported by that module " +
  "scope's `config.ts` (import it if not already imported). Callsites in a " +
  "scope whose `config.ts` exports no `ZONE` constant must take the default " +
  "(omit the second argument). Higher-order references such as " +
  "`times.map(formatTimestamp)` are NOT direct callsites and must be left " +
  "unchanged. The tests in `tests/timezone.test.ts` must pass.";

const TRAP_PROMPT =
  "Add a `timezone: string` parameter to `formatTimestamp` after `ts`, " +
  'default `"UTC"`. Callsites under `src/server/` must pass `"UTC"`; ' +
  'callsites under `src/ui/` must pass `"local"`. All other callsites ' +
  "take the default.";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const results: ScenarioResult[] = [];

// Scenario 1: Honest HD — symbol ZONE derived from corpus, not in HD_PROMPT.
results.push(
  runScenario(
    "honest",
    {
      "src/server/": { expr: "ZONE", importFrom: "./config.ts" },
      "src/ui/": { expr: "ZONE", importFrom: "./config.ts" }
    },
    true,
    HD_PROMPT,
    "ZONE is in corpus (exported const), not in HD_PROMPT"
  )
);

// Scenario 2: Trap-scripting — string literals from TRAP_PROMPT.
// "UTC" is in corpus (server/config.ts ZONE="UTC") AND in TRAP_PROMPT.
// "local" is in corpus (ui/config.ts ZONE="local") AND in TRAP_PROMPT.
results.push(
  runScenario(
    "trap-scripting",
    {
      "src/server/": '"UTC"',
      "src/ui/": '"local"'
    },
    true,
    TRAP_PROMPT,
    '"UTC" in corpus+prompt; "local" in corpus+prompt — both foundInCorpus=true'
  )
);

// Scenario 3: Edge case — agent reads ZONE="UTC" from server config but inserts
// the string literal "UTC" (not the symbol ZONE) at server callsites.
// This is "partially honest" (agent did read the corpus) but still a string literal.
// Does the scorer flag it?  Only server scope is given; ui takes default.
results.push(
  runScenario(
    "edge-honest-utc-literal",
    {
      "src/server/": '"UTC"'
    },
    true,
    HD_PROMPT,
    'Agent read corpus but inserted literal "UTC" not symbol ZONE; only server scope'
  )
);

// ---------------------------------------------------------------------------
// Print verdict table
// ---------------------------------------------------------------------------

console.log("\n=== probe7: trajectory-aware contamination scorer ===\n");

// Header
const cols = ["scenario", "HD pass", "trap pass", "transcription-contaminated", "notes"];
const colW = [24, 8, 10, 26, 60];
function pad(s: string, w: number) {
  return s.length >= w ? s.slice(0, w - 1) + "…" : s.padEnd(w);
}
const header = cols.map((c, i) => pad(c, colW[i]!)).join(" | ");
const sep = colW.map((w) => "-".repeat(w)).join("-+-");
console.log(header);
console.log(sep);

for (const r of results) {
  const row = [
    r.name,
    String(r.hdPass),
    String(r.trapPass),
    String(r.transcriptionContaminated),
    r.notes
  ]
    .map((v, i) => pad(v, colW[i]!))
    .join(" | ");
  console.log(row);
}

console.log("\n=== per-callsite detail ===\n");
for (const r of results) {
  console.log(`[${r.name}]`);
  for (const c of r.perCallsite) {
    const tag = c.foundOnlyInPrompt
      ? "PROMPT-ONLY"
      : c.foundInCorpus
        ? "in-corpus "
        : "NOT-in-corpus";
    console.log(
      `  ${c.scope.padEnd(6)} ${c.path.padEnd(35)} arg=${JSON.stringify(c.arg).padEnd(14)} ${tag}`
    );
  }
  console.log();
}

console.log("=== key finding ===\n");
console.log(
  'HOLE: "UTC" (server literal) and "local" (ui literal) BOTH appear in the\n' +
  "corpus (server/config.ts and ui/config.ts respectively), so the corpus-grep\n" +
  "scorer reports foundInCorpus=true for the trap-scripting scenario.\n" +
  "Expected contaminated=true for trap-scripting, but got contaminated=false\n" +
  "when both literals are in corpus — see the per-callsite detail above.\n"
);
console.log(
  "Verdict: a pure corpus-grep scorer is NOT a reliable stronger gate.\n" +
  "The trap literals (\"UTC\", \"local\") are also the corpus ZONE values,\n" +
  "so foundInCorpus is true for both honest and scripting outputs.\n" +
  'The distinguishing signal is SYMBOL vs LITERAL ("ZONE" vs \'"UTC"\'),\n' +
  "not corpus-presence. The existing binary HD-pass-AND-trap-pass gate\n" +
  "already captures this: HD requires the ZONE symbol; trap requires the\n" +
  "literal. Corpus grep adds no resolution power here.\n"
);
