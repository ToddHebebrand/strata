import path from "node:path";
import { renderWithSourceMap } from "@strata-code/render";
import { listModules, loadModule, type Db } from "@strata-code/store";
import type { LabCriteria, RunAgentLabParams } from "./seam";
import { scoreHonestDerivable } from "./tasks/honestDerivable";
import { scoreTrapped } from "./tasks/trappedControl";

/**
 * Optional post-scorer discipline gate. Receives the db AFTER the agent has
 * committed and returns {gatePass, violations}. If gatePass=false, the scorer
 * forces labOk=false regardless of the task verdict, and prints the violations
 * so the operator knows what was caught.
 *
 * Design: Option A (per-experiment scorer override) — backward-compatible.
 * Experiments that don't supply extraGate behave exactly as before. The gate
 * is defined near the op it guards (in nodeRefAddParameter.ts), not in the
 * framework. This keeps experiment.ts minimal and avoids entangling the
 * framework with any specific gate logic.
 */
export type ExtraGate = (db: Db) => { gatePass: boolean; violations: string[] };

export interface LabExperiment {
  id: string;
  hypothesis: string;
  task: "HD" | "trap";
  overrides: {
    toolServerFactory?: RunAgentLabParams["toolServerFactory"];
    canUseTool?: RunAgentLabParams["canUseTool"];
    prompt?: string;
    /**
     * Optional op-log discipline gate. Called after the task scorer. If it
     * returns gatePass=false, labOk is forced false and violations are printed.
     * Leave undefined for experiments that don't need an op-log check (all
     * prior experiments are unaffected).
     */
    extraGate?: ExtraGate;
  };
}

/**
 * Build the score function for a lab experiment. If the experiment supplies
 * an extraGate, it is run after the task scorer; a gate failure overrides
 * labOk to false regardless of the task verdict.
 */
export function makeLabScorer(
  task: "HD" | "trap",
  extraGate?: ExtraGate
): RunAgentLabParams["score"] {
  return (db: Db, _batch, srcRoot: string, input): LabCriteria => {
    const rendered = renderCommittedSrc(db, srcRoot);
    const verdict =
      task === "HD" ? scoreHonestDerivable(rendered) : scoreTrapped(rendered);

    let labOk = verdict.pass;

    // Run the optional discipline gate AFTER the task scorer. If the gate
    // fires, force labOk=false and print violations so the operator sees
    // what was caught. We always run the gate (even if labOk is already false)
    // to surface discipline violations for observability.
    let gatePass = true;
    if (extraGate) {
      const gateResult = extraGate(db);
      gatePass = gateResult.gatePass;
      if (!gatePass) {
        console.log(
          `[lab] DISCIPLINE GATE FIRED — labOk forced false. Violations:`
        );
        for (const v of gateResult.violations) {
          console.log(`  · ${v}`);
        }
        labOk = false;
      }
    }

    return {
      commitReturnedOk: input.commitReturnedOk,
      validateAfterCommitClean: input.validateAfterCommitClean,
      // NOTE: operationRowAppended is a conservative PROXY equal to
      // commitReturnedOk for the sandbox — no add_parameter-kind-specific
      // operation-log check is implemented yet; a graduating method must add
      // a real op-log assertion before making any claim based on this field.
      operationRowAppended: input.commitReturnedOk,
      labOk,
      // Extra field for observability — gatePass=true if no gate or gate passed.
      // LabCriteria has [extra: string]: boolean so this is type-safe.
      gatePass
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
