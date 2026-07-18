# Phase-6 live-comparison design review

**Date:** 2026-07-16

**Reviewed commit:** `ad0ccf64d59c04dd967f601629e41550ee94ca0f`

**Reviewer:** Codex CLI, `gpt-5.5`, reasoning `xhigh`, read-only sandbox,
ephemeral session, no web search

**Review verdict:** `REVISE`

## Command

```bash
codex exec \
  -C /Users/toddhebebrand/Strata/.worktrees/phase6-live-comparison \
  -m gpt-5.5 \
  -c 'model_reasoning_effort="xhigh"' \
  -s read-only \
  --ephemeral \
  - < /tmp/strata-phase6-codex-review-prompt.txt
```

The prompt was a self-contained brief covering the governing documents,
authority boundary, six task packets, corpus choice, role-specific bounds,
900-second team deadline, failure and stop rules, falsified alternatives, and
the implementation plan. It asked for a decision-grade verdict, exact
repo-grounded evidence, and explicit separation of blockers from non-blocking
observations.

## Accepted blocker

The design's phrase “same Vitest suite” contradicted the already-approved
canonical publication boundary:

- `decisions.md` and the deterministic acceptance evidence limit production
  candidate execution to the ingest-derived `src/**` projection; complete
  fixture candidate validation remains unproved.
- `examples/medium/tests/format.test.ts` imports `formatTimestamp` and
  `logEvent`, which are targets in D, M, G, and X, from outside that projection.
- That fixture also encodes the older T01 end state by requiring a second
  optional `formatTimestamp` parameter, which is false at the Phase-6 starting
  commit.
- `packages/verify/src/taskBehavioralFixtures.ts` explicitly documents that the
  historical whole-suite scope is unsatisfiable per task and registers scoped
  fixtures instead.

Approving the prior wording would have forced one of three invalid outcomes:
unrelated live packets fail, the verifier is weakened silently, or Strata's
canonical publication authority expands beyond the deterministic proof.

## Repository verification

The blocker was independently confirmed after the review with the indexed
worktree and source:

- codebase-memory found the `formatTimestamp` and `logEvent` imports and the
  incompatible signature expectation in `examples/medium/tests/format.test.ts`;
- codebase-memory found the scoped-fixture rationale and allowlist in
  `packages/verify/src/taskBehavioralFixtures.ts`;
- `packages/verify/src/corpusRun.ts` proves the supported contract already has
  strict source-only TypeScript roots plus an explicit Vitest fixture list; and
- the deterministic evidence and `decisions.md` both state the accepted
  `src/**` projection boundary.

## Resolution applied before approval

The design now defines experimental greenness as a frozen,
projection-compatible contract shared byte-for-byte across arms:

1. exact source-only TypeScript options and root names;
2. exact harness-owned, per-packet Phase-6 Vitest fixture allowlists and
   digests;
3. exact AST/text predicates and allowed deltas;
4. explicit exclusion and frozen digests for historical benchmark fixtures;
5. rejection of baseline edits outside canonical `src/**`; and
6. a deterministic preflight that enumerates and classifies every task-symbol
   occurrence outside canonical publication scope and stops if any accepted
   predicate would require changing it.

The caller-enriched option is tightened so its test exercises a stable wrapper
from the appended source module and never names a task target that would need a
non-canonical rewrite. The design also explicitly excludes any claim that the
historical whole corpus test suite is green.

No production code, `decisions.md` entry, experiment Agent SDK call, or live
comparison was made during this review and correction.

## Non-blocking review results

The reviewer found the small seven-operation authority boundary appropriate;
the role-based fairness and `24 * $0.75 + 6 * $4.00 = $42` accounting coherent;
the G `undefined as never` whitelist precise; the short Unix-socket path policy
acceptable; and the plan's TDD, unchanged deterministic gate,
post-implementation review, and separate live-budget approval correctly
sequenced.

This was the single pre-implementation independent review round. Its verified
blocker was resolved in documentation before the operator approval gate. The
separate, single post-implementation review in Task 8 remains required.

## Follow-up sign-off

The operator's 2026-07-16 message beginning “Reviewer sign-off on `ac39135`”
records the independent reviewer's confirmation that the resolution has no
remaining blocker. That message also requested the historical single-trial cost
calibration, expected non-canonical fixture dispositions, and generation-zero
verifier proof now incorporated in the design and plan. It did not select a
corpus variant, approve production implementation, or authorize Task 9/live
execution; those operator fields remained bracketed alternatives.

The follow-up facts were checked locally before documentation changed. A scan
of all retained benchmark-result `totalCostUsd.values` distributions found 150
per-trial observations and a maximum of USD 1.0433835, matching T01 substrate
trial 1 in `phase15-four-task-2026-05-17T00-29-06-119Z.json`.
`tests/format.test.ts` contains the expected `formatTimestamp` and `logEvent`
references; `tests/dateRange.test.ts` imports only `isWithinRange`, which is not
a Phase-6 task target.
