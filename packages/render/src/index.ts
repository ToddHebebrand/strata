import type { NodeRow } from "@strata/store";

export function render(_module: NodeRow, children: NodeRow[]): string {
  return [...children]
    .sort((left, right) => (left.childIndex ?? 0) - (right.childIndex ?? 0))
    .map((child) => child.payload)
    .join("");
}
