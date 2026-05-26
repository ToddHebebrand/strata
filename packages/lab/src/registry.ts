import type { LabExperiment } from "./experiment";
import { perScopeAddParameter } from "./experiments/perScopeAddParameter";
import { canonicalControl } from "./experiments/canonicalControl";
import {
  perScopeAddParameterDirective,
  canonicalControlDirective
} from "./experiments/directiveVariants";
import { perScopeGated, canonicalGated } from "./experiments/gatedVariants";
import {
  perScopeHandlerGated,
  canonicalHandlerGated
} from "./experiments/handlerGatedVariants";
import {
  perScopeEquipped,
  canonicalEquipped
} from "./experiments/equippedVariants";
import { perScopeEquippedGated } from "./experiments/equippedGated";
import { perScopeEquippedGatedTrap } from "./experiments/equippedGatedTrap";
import {
  nodeRefAddParameter,
  nodeRefAddParameterEquippedGated,
  nodeRefAddParameterEquippedGatedTrap
} from "./experiments/nodeRefAddParameter";
import {
  preloadedCanonical,
  preloadedCanonicalV2,
  preloadedBugfixed,
  bugfixedOnly
} from "./experiments/preloadedCanonical";

// The temporary inline `noop` placeholder is GONE (Task 10). The registry
// holds the substantive lever (per-scope-expressive add_parameter) and its
// inverted control (vanilla canonical tools). The control/variant DELTA on
// the honest task is the signal; neither in isolation is.
export const REGISTRY: Record<string, LabExperiment> = {
  [perScopeAddParameter.id]: perScopeAddParameter,
  [canonicalControl.id]: canonicalControl,
  [perScopeAddParameterDirective.id]: perScopeAddParameterDirective,
  [canonicalControlDirective.id]: canonicalControlDirective,
  [perScopeGated.id]: perScopeGated,
  [canonicalGated.id]: canonicalGated,
  [perScopeHandlerGated.id]: perScopeHandlerGated,
  [canonicalHandlerGated.id]: canonicalHandlerGated,
  [perScopeEquipped.id]: perScopeEquipped,
  [canonicalEquipped.id]: canonicalEquipped,
  [perScopeEquippedGated.id]: perScopeEquippedGated,
  [perScopeEquippedGatedTrap.id]: perScopeEquippedGatedTrap,
  [nodeRefAddParameter.id]: nodeRefAddParameter,
  [nodeRefAddParameterEquippedGated.id]: nodeRefAddParameterEquippedGated,
  [nodeRefAddParameterEquippedGatedTrap.id]: nodeRefAddParameterEquippedGatedTrap,
  [preloadedCanonical.id]: preloadedCanonical,
  [preloadedCanonicalV2.id]: preloadedCanonicalV2,
  [preloadedBugfixed.id]: preloadedBugfixed,
  [bugfixedOnly.id]: bugfixedOnly
};

export function getExperiment(id: string): LabExperiment {
  const exp = REGISTRY[id];
  if (!exp) {
    throw new Error(
      `Unknown experiment "${id}". Known: ${Object.keys(REGISTRY).join(", ") || "(none)"}`
    );
  }
  return exp;
}
