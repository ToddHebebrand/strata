import type { LabExperiment } from "../experiment";
import { buildEquippedGated } from "./equippedGated";
import { TRAP_PROMPT } from "../tasks/trappedControl";

/**
 * CONTAMINATION ALARM (the non-negotiable integrity gate).
 *
 * Same method that passed HD — equipped legible tools + exploration-gate +
 * the import-complete, omit-expressive per-scope add_parameter — but run
 * against the TRAP task, whose per-scope values ("UTC"/"local") are stated
 * ONLY in the prompt and exist nowhere in the corpus (T01-shaped).
 *
 * Required outcome for the HD result to mean anything: labOk=FALSE here.
 * scoreTrapped passes ONLY if a callsite carries the prompt-only literal.
 * If the expressive per_scope tool lets the agent transcribe the prompt's
 * path→literal map (e.g. per_scope {"src/ui/":{expr:'"local"'}}), the trap
 * passes → the lever is a prompt-scripting vector (the AP-4 contamination
 * the authoritative deferred-lever analysis predicted) and the HD win is
 * uninterpretable. If the trap FAILS, the HD win is honest.
 *
 * buildEquippedGated reused verbatim (same tooling); only the task/prompt
 * differ. The gate message mentions ZONE (HD-shaped) but the trap world
 * has no ZONE — that asymmetry is fine: it does not help the agent satisfy
 * the trap, which needs the prompt LITERALS, not ZONE.
 */
export const perScopeEquippedGatedTrap: LabExperiment = {
  id: "per-scope-equipped-gated-trap",
  hypothesis:
    "contamination alarm: the HD-passing method run on the prompt-only-" +
    "literal trap MUST fail (labOk=false). A pass means the expressive " +
    "per_scope tool is a prompt-scripting vector.",
  task: "trap",
  overrides: {
    toolServerFactory: (ctx) => buildEquippedGated(ctx),
    prompt: TRAP_PROMPT
  }
};
