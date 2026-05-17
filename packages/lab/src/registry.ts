import type { LabExperiment } from "./experiment";
import { perScopeAddParameter } from "./experiments/perScopeAddParameter";

// The temporary inline `noop` placeholder is GONE (Task 10). The registry
// now holds the first real experiment: the per-scope-expressive
// add_parameter variant — the substantive lever the sandbox exists to test.
export const REGISTRY: Record<string, LabExperiment> = {
  [perScopeAddParameter.id]: perScopeAddParameter
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
