# Phase-6 live-comparison implementation record

**Date:** 2026-07-16

**Starting commit:** `9aed98c1ceeaaf5d175aeea7993c4abb26b4ba88`

**Worktree:** `/Users/toddhebebrand/Strata/.worktrees/phase6-live-comparison`

**Branch:** `feature/phase6-live-comparison-design`

## Approval gate 1

- Design review:
  `docs/spikes/2026-07-16-phase-6-live-comparison-design-review.md`
- Reviewed and corrected design head before operator decision: `dbfcf0c`
- Approval message reference: operator message dated 2026-07-16 immediately
  following `dbfcf0c`, with exact fields `Corpus: current` and
  `Implementation: approved`.
- Approved corpus variant: `current`.
- Approved scope: deterministic production-code implementation of
  `docs/superpowers/plans/2026-07-16-phase-6-live-comparison.md` under the
  reviewed authority boundary and stop conditions.

This approval does not authorize Task 9, a keyed Agent SDK experiment call, or
live-model spend. The exact provider, model, trial count, session bounds,
900-second team deadline, projected maximum spend, credential source, qualified
task set, seed, and frozen manifest still require the separate live-budget
approval gate after deterministic implementation.

## Execution ledger

- Approval recorded before Task 1: PASS.
- Isolated linked worktree on the approved branch: PASS.
- Merge base with `main`: PASS,
  `9aed98c1ceeaaf5d175aeea7993c4abb26b4ba88`.
- Credential-free deterministic kernel baseline: PASS,
  `env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN pnpm
  kernel:full-key-free:test`.
- Credential-free agent package baseline: 53 passed, 2 failed, 2 skipped. The
  only failures are the documented stale declaration `5073ecfb56151b41` in
  `labSeam.test.ts` and `replay.test.ts`.
- Task 1 Agent SDK extraction and query-budget enforcement: code complete at
  `dc7fc3d`, process gate BLOCKED pending operator disposition.

The Task-1 package verification preserves the already-documented two stale
agent replay-fixture failures as the baseline; focused Task-1 tests and the
package build must pass, and no additional full-package failure is accepted.
Those fixtures are outside Task 1 and are not regenerated.

## Task 1 process-gate incident

During the credential-free RED run for Task 1, the new compatibility test
passed a scripted `queryFn` property to the pre-extraction `runLiveSession`.
That old implementation did not accept the property, entered the real Agent SDK
`query()` path, and returned `error_wall_time` after the test's two-second abort.
Both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` were removed. No model
result, reported cost, tool call, or canonical/source mutation occurred. The
SDK CLI process nevertheless likely started, contrary to the plan's stricter
rule that no experimental Agent SDK model process may start in Tasks 1–8.

The committed GREEN implementation uses only injected scripted SDK streams.
Evidence at `dc7fc3d` is:

- focused Task-1 tests: 12 passed, 1 credential-gated skip;
- package build: PASS; and
- full agent suite: 59 passed, the same 2 documented stale-fixture failures,
  and 2 skipped.

The independent task review found no Critical, Important, or Minor code issue.
It confirmed the generic runner is storage-agnostic, the hermetic options and
exact init-tool guard are present, `error_max_budget_usd` maps to the distinct
`max_budget` terminal while retaining cost/usage, no retry loop was added, and
SQLite/T03 observations remain in wrapper callbacks. It still returned
`Task quality: Needs fixes` because the historical no-process violation cannot
be represented as compliant RED evidence or repaired after the fact.

Execution stops before Task 2. The operator must explicitly choose whether to
accept this one uncredentialed, zero-result, zero-reported-cost process incident
as a recorded exception and retain `dc7fc3d`, or terminate/restart the approved
implementation effort. No further SDK process or Task-2 production change is
authorized by the earlier implementation approval.

**Operator disposition:** accepted by the operator's next message dated
2026-07-16, with exact text `Disposition: accept recorded Task-1 process
exception and proceed`. Task 1 is therefore complete with this exception
permanently attached to its evidence, and Task 2 is authorized. The disposition
does not authorize another SDK process or any Task-9/live call.

This is an execution-procedure divergence, not a change to Strata's approved
architecture or production behavior, so it is recorded here rather than in
`decisions.md`.
