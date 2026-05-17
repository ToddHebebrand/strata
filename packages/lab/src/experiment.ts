import path from "node:path";
import { renderWithSourceMap } from "@strata/render";
import { listModules, loadModule, type Db } from "@strata/store";
import type { LabCriteria, RunAgentLabParams } from "./seam";
import { scoreHonestDerivable } from "./tasks/honestDerivable";
import { scoreTrapped } from "./tasks/trappedControl";

export interface LabExperiment {
  id: string;
  hypothesis: string;
  task: "HD" | "trap";
  overrides: {
    toolServerFactory?: RunAgentLabParams["toolServerFactory"];
    canUseTool?: RunAgentLabParams["canUseTool"];
    prompt?: string;
  };
}

export function makeLabScorer(task: "HD" | "trap"): RunAgentLabParams["score"] {
  return (db: Db, _batch, srcRoot: string, input): LabCriteria => {
    const rendered = renderCommittedSrc(db, srcRoot);
    const verdict =
      task === "HD" ? scoreHonestDerivable(rendered) : scoreTrapped(rendered);
    return {
      commitReturnedOk: input.commitReturnedOk,
      validateAfterCommitClean: input.validateAfterCommitClean,
      operationRowAppended: input.commitReturnedOk,
      labOk: verdict.pass
    };
  };
}

/**
 * Render all committed Module nodes in the store to a Map keyed by
 * CORPUS-ROOT-relative POSIX paths WITH the `src/` prefix
 * (e.g. "src/server/events.ts").
 *
 * KEY-PREFIX RATIONALE: The HD/trap scorers use scopeOf(relPath) from
 * callsites.ts, which checks relPath.startsWith("src/server/") /
 * "src/ui/". The canonical t03Criteria.ts evaluateT03Criteria() keys by
 * path.relative(srcRoot, …) which yields "server/events.ts" (no src/
 * prefix). If we copied that idiom verbatim, scopeOf would bucket every
 * callsite as "other" and the instrument would silently break. We
 * therefore relativize to corpusRoot (= path.dirname(srcRoot)) so keys
 * carry the "src/" prefix the scorer requires.
 *
 * The render idiom (loadModule + renderWithSourceMap) is byte-faithful to
 * evaluateT03Criteria; the ONLY intentional difference is the
 * corpusRoot-relative key instead of srcRoot-relative.
 *
 * Defensive: if db is falsy or no modules exist, returns new Map() so
 * the unit test (which passes undefined db) does not throw.
 *
 * Exported for direct testing of the key-format contract: the instrument's
 * correctness depends on `src/`-prefixed posix keys feeding `scopeOf`.
 */
export function renderCommittedSrc(db: Db, srcRoot: string): Map<string, string> {
  if (!db) {
    return new Map();
  }

  // corpusRoot is the parent of srcRoot (e.g. ".../lab/corpus").
  // Relativizing module.payload (an absolute path) against corpusRoot yields
  // "src/server/events.ts" — the key format scopeOf() expects.
  const corpusRoot = path.dirname(srcRoot);

  const rendered = new Map<string, string>();

  let modules: ReturnType<typeof listModules>;
  try {
    modules = listModules(db);
  } catch {
    return new Map();
  }

  for (const module of modules) {
    const loaded = loadModule(db, module.id);
    const text = renderWithSourceMap(loaded.module, loaded.children).text;
    // Normalize to POSIX (replaces \ on Windows), then relativize to
    // corpusRoot so the key starts with "src/".
    const posixKey = toPosix(path.relative(corpusRoot, module.payload));
    rendered.set(posixKey, text);
  }

  return rendered;
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}
