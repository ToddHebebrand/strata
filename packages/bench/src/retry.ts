/**
 * Spec § "The symmetric retry/failure counting rule": one failure/retry =
 * a verification action that returned a negative result AND was followed by
 * at least one further mutating action in the same session. A failed check
 * with no subsequent mutation is terminal/success-side, not a retry.
 */

export {
  countBaselineRetries,
  type BaselineToolEvent
} from "@strata-code/agent";

export interface SubstrateToolEvent {
  tool: string;
  ok: boolean;
  /** validate returned a non-empty Diagnostic[]. */
  returnedDiagnostics?: boolean;
  /** commit_transaction returned { ok: true|false }. */
  commitOk?: boolean;
}

const SUBSTRATE_MUTATING = new Set([
  "rename_symbol",
  "begin_transaction",
  "rollback_transaction"
]);

export function countSubstrateRetries(events: SubstrateToolEvent[]): number {
  let retries = 0;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const failedCheck =
      (event.tool === "validate" && event.returnedDiagnostics === true) ||
      (event.tool === "commit_transaction" && event.commitOk === false);
    if (!failedCheck) {
      continue;
    }
    const hasFollowingMutation = events
      .slice(i + 1)
      .some((next) => SUBSTRATE_MUTATING.has(next.tool));
    if (hasFollowingMutation) {
      retries++;
    }
  }
  return retries;
}
