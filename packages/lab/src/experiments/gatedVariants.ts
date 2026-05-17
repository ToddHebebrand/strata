import type { LabExperiment } from "../experiment";
import { buildVariantToolServer } from "./perScopeAddParameter";
import { explorationGate } from "./explorationGate";
import { HD_DIRECTIVE_PROMPT } from "./directivePrompt";

/**
 * Iteration 3 — the genuinely-different lever: exploration-gate
 * (loop-affordance) + the per-scope tool + the directive honest prompt.
 *
 * Tests the full stack: if the gate forces the agent to stop exploring
 * and act, does the per-scope `add_parameter` then let it pass HD in one
 * structural op? A PASS here is the first evidence the substrate helps a
 * multi-step refactor — and would then require the trapped-control
 * contamination check before any graduation talk.
 */
export const perScopeGated: LabExperiment = {
  id: "per-scope-gated",
  hypothesis:
    "exploration-gate (force act after N reads) + per-scope tool + " +
    "directive prompt — does ending the thrash make the per-scope lever " +
    "reachable and sufficient for HD?",
  task: "HD",
  overrides: {
    toolServerFactory: (ctx) => buildVariantToolServer(ctx),
    canUseTool: explorationGate(14),
    prompt: HD_DIRECTIVE_PROMPT
  }
};

/**
 * Iteration 3 inverted control: exploration-gate + CANONICAL tools +
 * directive prompt (NO per-scope tool). Isolates the gate's effect from
 * the tool's. If perScopeGated passes but this fails → the per-scope tool
 * is doing the work once the gate makes it reachable. If both pass → the
 * gate alone closes it (canonical add_parameter sufficed once forced to
 * act). If both still fail → the failure is deeper than exploration
 * discipline.
 */
export const canonicalGated: LabExperiment = {
  id: "canonical-gated",
  hypothesis:
    "exploration-gate + canonical tools + directive prompt — isolates the " +
    "gate's effect from the per-scope tool's",
  task: "HD",
  overrides: {
    canUseTool: explorationGate(14),
    prompt: HD_DIRECTIVE_PROMPT
  }
};
