import type { LabExperiment } from "./experiment";

// TEMPORARY: Task 10 replaces this inline noop with
//   import { perScopeAddParameter } from "./experiments/perScopeAddParameter";
// and registers it under its real id. Until then the registry is non-empty
// with a control no-op so the CLI + tests are exercisable.
const noop: LabExperiment = {
  id: "noop",
  hypothesis:
    "control: canonical tools, no overrides — expect HD FAIL (no per-scope expressiveness)",
  task: "HD",
  overrides: {}
};

export const REGISTRY: Record<string, LabExperiment> = {
  [noop.id]: noop
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
