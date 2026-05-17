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
      // NOTE: operationRowAppended is a conservative PROXY equal to
      // commitReturnedOk for the sandbox — no add_parameter-kind-specific
      // operation-log check is implemented yet; a graduating method must add
      // a real op-log assertion before making any claim based on this field.
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
 * Defensive: if db is falsy (degenerate unit-test `undefined as any` case),
 * returns new Map() so the caller gets labOk:false without a throw.
 * A genuine DB or render failure is intentionally NOT swallowed — it throws
 * so the harness/test surfaces the failure immediately. Silent failure would
 * corrupt measurement.
 *
 * Exported for direct testing of the key-format contract: the instrument's
 * correctness depends on `src/`-prefixed posix keys feeding `scopeOf`.
 */
export function renderCommittedSrc(db: Db, srcRoot: string): Map<string, string> {
  if (!db) {
    return new Map();
  }

  // Strip any trailing path separators so "path/to/src/" is treated the same
  // as "path/to/src" — a caller passing a trailing slash still gets the right
  // corpusRoot (i.e. path.dirname does not see an empty final segment).
  const normalizedSrcRoot = srcRoot.replace(/[/\\]+$/, "");

  // corpusRoot is the parent of srcRoot (e.g. ".../lab/corpus").
  // Relativizing module.payload (an absolute path) against corpusRoot yields
  // "src/server/events.ts" — the key format scopeOf() expects.
  const corpusRoot = path.dirname(normalizedSrcRoot);

  const rendered = new Map<string, string>();

  // Let listModules throw naturally — a real DB failure must not be silently
  // swallowed (that would corrupt measurement by returning an empty map).
  const modules = listModules(db);

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
