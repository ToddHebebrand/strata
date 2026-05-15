/**
 * Spec § "The symmetric retry/failure counting rule": one failure/retry =
 * a verification action that returned a negative result AND was followed by
 * at least one further mutating action in the same session. A failed check
 * with no subsequent mutation is terminal/success-side, not a retry.
 */

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

export interface BaselineToolEvent {
  tool: string;
  /** For Edit/Write/Read. */
  path?: string;
  /** For Bash. */
  command?: string;
  /** For Bash: process exit code. */
  exitCode?: number;
}

const BASELINE_MUTATING = new Set(["Edit", "Write"]);

function isFailedVerification(
  event: BaselineToolEvent,
  editedSoFar: Set<string>
): boolean {
  if (
    event.tool === "Bash" &&
    typeof event.command === "string" &&
    /\b(tsc|vitest|test)\b/.test(event.command) &&
    typeof event.exitCode === "number" &&
    event.exitCode !== 0
  ) {
    return true;
  }

  return (
    BASELINE_MUTATING.has(event.tool) &&
    typeof event.path === "string" &&
    editedSoFar.has(event.path)
  );
}

export function countBaselineRetries(events: BaselineToolEvent[]): number {
  let retries = 0;
  const editedSoFar = new Set<string>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (isFailedVerification(event, editedSoFar)) {
      const hasFollowingMutation = events
        .slice(i + 1)
        .some((next) => BASELINE_MUTATING.has(next.tool));
      if (hasFollowingMutation) {
        retries++;
      }
    }

    if (BASELINE_MUTATING.has(event.tool) && typeof event.path === "string") {
      editedSoFar.add(event.path);
    }
  }

  return retries;
}
