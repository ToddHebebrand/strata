import type { LabExperiment } from "../experiment";
import { buildVariantToolServer } from "./perScopeAddParameter";
import { HD_DIRECTIVE_PROMPT } from "./directivePrompt";

/**
 * Iteration 2: same per-scope-expressive `add_parameter` variant, but with
 * the directive (still-honest) prompt. Tests whether prompt directiveness
 * gets the agent past the observed pure-exploration thrash and into the
 * act phase, where the per-scope tool can finally be exercised. Expect (if
 * directiveness works): the agent reaches `add_parameter` with a per_scope
 * policy and passes HD in one structural op.
 */
export const perScopeAddParameterDirective: LabExperiment = {
  id: "per-scope-add-parameter-directive",
  hypothesis:
    "per-scope variant + directive honest prompt — does directiveness end " +
    "the exploration thrash so the per-scope tool is actually reached/used?",
  task: "HD",
  overrides: {
    toolServerFactory: (ctx) => buildVariantToolServer(ctx),
    prompt: HD_DIRECTIVE_PROMPT
  }
};

/**
 * Iteration 2 inverted control: canonical tools + the SAME directive
 * prompt. Keeps the delta honest — if the directive variant passes but
 * this fails, the per-scope tool is doing the work (not just the prompt).
 * If BOTH pass, the prompt alone closed it (the lever is directiveness,
 * not the tool). If BOTH still thrash, exploration discipline is deeper
 * than prompt directiveness.
 */
export const canonicalControlDirective: LabExperiment = {
  id: "canonical-control-directive",
  hypothesis:
    "canonical tools + directive honest prompt — isolates whether prompt " +
    "directiveness alone (no per-scope tool) ends the thrash",
  task: "HD",
  overrides: {
    prompt: HD_DIRECTIVE_PROMPT
  }
};
