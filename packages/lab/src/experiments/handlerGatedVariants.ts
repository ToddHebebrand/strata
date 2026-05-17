import type { LabExperiment } from "../experiment";
import { buildGatedToolServer } from "./explorationGateServer";
import { HD_DIRECTIVE_PROMPT } from "./directivePrompt";

/**
 * Iteration 4 — the loop-affordance lever, now enforced where it actually
 * works (tool-handler layer, since bypassPermissions kills canUseTool):
 * exploration-gate + per-scope tool + directive honest prompt. Full stack.
 * A PASS is the first real evidence the substrate helps this multi-step
 * refactor; it would then require the trapped-control contamination check
 * before any graduation talk.
 */
export const perScopeHandlerGated: LabExperiment = {
  id: "per-scope-handler-gated",
  hypothesis:
    "tool-handler exploration-gate + per-scope tool + directive prompt — " +
    "does forcing the act phase (where canUseTool could not) make the " +
    "per-scope lever reachable and sufficient for HD?",
  task: "HD",
  overrides: {
    toolServerFactory: (ctx) => buildGatedToolServer(ctx, { variant: true }),
    prompt: HD_DIRECTIVE_PROMPT
  }
};

/**
 * Iteration 4 inverted control: tool-handler exploration-gate + CANONICAL
 * tools + directive prompt (no per-scope tool). Isolates the gate from the
 * tool. per-scope passes & this fails ⇒ the per-scope tool does the work
 * once reachable. Both pass ⇒ the gate alone closes it. Both fail ⇒ the
 * blocker is deeper than exploration discipline.
 */
export const canonicalHandlerGated: LabExperiment = {
  id: "canonical-handler-gated",
  hypothesis:
    "tool-handler exploration-gate + canonical tools + directive prompt — " +
    "isolates the gate's effect from the per-scope tool's",
  task: "HD",
  overrides: {
    toolServerFactory: (ctx) => buildGatedToolServer(ctx, { variant: false }),
    prompt: HD_DIRECTIVE_PROMPT
  }
};
