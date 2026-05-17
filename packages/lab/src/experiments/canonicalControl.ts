import type { LabExperiment } from "../experiment";

/**
 * BASELINE / INVERTED CONTROL — canonical Strata tools, no overrides, on the
 * honest-derivable task.
 *
 * Why this exists: a `per-scope-add-parameter` result is uninterpretable in
 * isolation. We need to know whether a *vanilla* agent fails the honest task
 * the way it failed T01 (the diagnosed `add_parameter`/`replace_body`
 * callsite-collision thrash). The delta between this control and the variant
 * is the actual signal — the same inverted-control logic that made the
 * original T03/T05 result credible.
 *
 * Expectation (hypothesis, NOT a claim): FAIL on HD — the canonical
 * `add_parameter` inserts a single uniform value at every callsite, so the
 * agent must hand-differentiate the per-scope callsites with `replace_body`
 * and collide, exactly as on T01.
 */
export const canonicalControl: LabExperiment = {
  id: "canonical-control",
  hypothesis:
    "vanilla canonical tools on the honest task — baseline; expect FAIL " +
    "(canonical add_parameter is uniform-value, so per-scope differentiation " +
    "forces the same hand-patch/collision as T01)",
  task: "HD",
  overrides: {}
};
