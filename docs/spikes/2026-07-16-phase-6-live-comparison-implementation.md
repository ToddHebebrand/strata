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
- Task 5 task/verification qualification: deterministic implementation BLOCKED
  at the real X dynamic-expansion stop gate; no Task-5 production/test commit
  was made.

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

## Task 5 deterministic stop gate

Task 5 first exposed a harness identity defect rather than an operation-semantics
result. The helper ingested virtual `/project/...` paths, then rewrote Module
payload paths to physical absolute paths without rekeying the ingest-derived
stable IDs. The corrected helper ingests physical absolute paths from the outset
and performs no post-ingest Module rewrite. A regression row proves that every
top-level statement ID derives from its unchanged physical Module path. The
correct physical-path `eventLine` ID is `13debac05f973311`, not the invalid
virtual-path ID `55fffd2a919faf4c`.

After that correction, the registered task tests prove the exact X2 complex
default constructs and exports a validated graph delta:

```bash
cd packages/live-compare
env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
  pnpm exec vitest run tests/tasks.test.ts
```

Result: **PASS**, 1 file and 6 tests passed. The corrected registration digest
is `58b47f4d6da22e39c8b1cec223bae1b9ca335bcce2b45ccbaf1f0cef0d0e5329`.

The real-daemon X2-first stop-gate command was:

```bash
cd packages/live-compare
env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN \
  pnpm exec vitest run tests/dynamicPreflight.test.ts -t 'qualifies X'
```

Result: **EXPECTED STOP-GATE FAILURE**, 1 failed and 3 skipped. X2 publishes
generation 1. Advancing the already-analyzed X1 returns `state:
needs_decision`, `ticketState: needs_decision`, `graphGeneration: "1"`,
`operationId: null`, and `publicationDigest: null`; no `ScopeExpanded` event or
requeue occurs. The response's coherent run used change set
`change:8eda320e5185f92e1a1f4f1f8eb7a4d6e8cd1fc896c77bf8952af397d15c9be9`.

The controller independently reproduced the physical-path ingest result,
confirmed that the exact complex default is valid, and verified the scope
internals. Fresh X1 analysis discovers the new c5a reference and `eventLine`
write expansion, but the existing `eventLine` validation-node version drift and
positional Identifier semantic reuse prevent classification as a pure superset.
`ScopeChange::MateriallyChanged` therefore drives the planner's terminal
`NeedsDecision` result. Broad node-version drift tolerance would weaken
containment and was not implemented.

No credential was available to either command, no Agent SDK or live-model call
was made, and no spend was incurred. Partial Task-5 production and test changes
remain uncommitted. Per the approved design's Step-7 stop rule, execution stops
before Task 6 pending explicit operator selection among: a semantic redesign
with a new deterministic proof; a fully requalified X task/corpus redesign; or
a design amendment that drops X and the dynamic-live-coordination claim.
