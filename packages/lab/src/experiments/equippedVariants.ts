import type { LabExperiment } from "../experiment";
import { buildEquippedToolServer } from "./equippedToolServer";
import { HD_DIRECTIVE_PROMPT } from "./directivePrompt";

/**
 * Iteration 5 — equip the agent with the structural navigation the probes
 * proved was the actual gap (find const/Module by name; node→scope), via
 * same-named enriched tools (zero canonical change). + per-scope
 * add_parameter + directive prompt. THIS is the real test of the question
 * the earlier runs could not reach: with the artificial legibility
 * deprivation removed, can the substrate + per-scope lever do the
 * multi-step refactor? A PASS → run the trapped control before any
 * graduation talk.
 */
export const perScopeEquipped: LabExperiment = {
  id: "per-scope-equipped",
  hypothesis:
    "enriched find_declarations(+FirstStatement)/read_node(+scope) + " +
    "per-scope add_parameter + directive prompt — with attribution no " +
    "longer artificially withheld, is the multi-step refactor reachable " +
    "and the per-scope lever sufficient?",
  task: "HD",
  overrides: {
    toolServerFactory: (ctx) => buildEquippedToolServer(ctx, { variant: true }),
    prompt: HD_DIRECTIVE_PROMPT
  }
};

/**
 * Iteration 5 inverted control: SAME enriched navigation, CANONICAL
 * add_parameter (uniform value, no per_scope). Isolates the per-scope
 * tool's contribution once both have legible navigation. equipped passes
 * & this fails ⇒ per-scope tool does the work. Both pass ⇒ legible
 * navigation alone closes it (canonical add_parameter sufficed, agent
 * differentiated some other honest way). Both fail ⇒ the blocker is
 * genuinely deeper than tool legibility.
 */
export const canonicalEquipped: LabExperiment = {
  id: "canonical-equipped",
  hypothesis:
    "enriched navigation + canonical add_parameter + directive prompt — " +
    "isolates the per-scope tool's effect once navigation is legible",
  task: "HD",
  overrides: {
    toolServerFactory: (ctx) =>
      buildEquippedToolServer(ctx, { variant: false }),
    prompt: HD_DIRECTIVE_PROMPT
  }
};
