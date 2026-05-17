import type { RunAgentLabParams } from "../seam";

/**
 * The exploration-discipline lever (a loop-AFFORDANCE change, NOT a prompt
 * change and NOT the per-scope tool).
 *
 * Observed failure (3 runs, control + variant + directive-variant): the
 * agent burns its entire budget in read-only exploration
 * (find_declarations/get_references/read_node), guessing nonexistent
 * constant names, and never opens a transaction — so the per-scope
 * `add_parameter` lever is never even reached. Prompt directiveness did
 * not move this (re-confirming the falsified BS-P-B prompt class).
 *
 * This gate counts pre-transaction read-only calls; once the budget is
 * spent with no `begin_transaction`, it DENIES further read-only calls
 * with an actionable message forcing the agent into the act phase. It
 * never blocks transaction/mutation/validate/commit calls, and once a
 * transaction is open it gets out of the way entirely.
 *
 * Integrity: the deny message contains NO per-scope value ("UTC"/"local"
 * appear nowhere) — it pushes the agent to ACT, it does not solve the
 * task. Per-scope values stay code-derived from each scope's config.ts.
 *
 * State is per-process: one CLI invocation = one run = one fresh gate.
 */
const READONLY = ["find_declarations", "get_references", "read_node"];

function bare(toolName: string): string {
  const cut = Math.max(toolName.lastIndexOf("__"), toolName.lastIndexOf("."));
  return cut >= 0 ? toolName.slice(cut + (toolName[cut] === "_" ? 2 : 1)) : toolName;
}

export function explorationGate(
  readBudget = 14
): NonNullable<RunAgentLabParams["canUseTool"]> {
  let reads = 0;
  let txOpen = false;
  return async (toolName, input) => {
    const name = bare(toolName);
    if (name === "begin_transaction") {
      txOpen = true;
      return { behavior: "allow", updatedInput: input };
    }
    if (txOpen || !READONLY.includes(name)) {
      return { behavior: "allow", updatedInput: input };
    }
    reads += 1;
    if (reads <= readBudget) {
      return { behavior: "allow", updatedInput: input };
    }
    return {
      behavior: "deny",
      message:
        `Exploration budget spent (${reads} read-only calls, no transaction ` +
        `opened). STOP exploring. Call begin_transaction now, then ` +
        `add_parameter on formatTimestamp — it rewrites every direct ` +
        `callsite in ONE operation; supply its per_scope option mapping ` +
        `each module-path prefix to the ZONE import you read for that ` +
        `scope. Then validate and commit_transaction. Do not call ` +
        `${name} again before acting.`
    };
  };
}
