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
- Initially approved corpus variant: `current`.
- Post-stop-gate direction: the operator selected option 2, task/corpus
  redesign, in the message `ok. proceed with 2`, then approved the exact
  `displayUser`/`serialize` proposal by replying `ok. can you write up the
  results pls` to the approval request.
- Revised approved corpus variant: `x-namespace-enriched-v1`. This adds no
  `greet` callers; R/S/G retain their approved single-site classification.
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
- Task 5 task/verification qualification: the original X pair reached its real
  dynamic-expansion stop gate. A credential-free replacement feasibility probe
  subsequently passed through the production daemon; formal full-variant
  requalification and the Task-5 production/test commit remain pending.

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
remain uncommitted. Per the approved design's Step-7 stop rule, execution
stopped before Task 6 and the operator was presented with: a semantic redesign
with a new deterministic proof; a fully requalified X task/corpus redesign; or
a design amendment that drops X and the dynamic-live-coordination claim. The
next section records the selected direction and its feasibility evidence.

## Task 5 X redesign feasibility result and disposition

The operator selected the fully requalified X task/corpus redesign. A
credential-free search first exhausted the current corpus under the approved
`rename_symbol` and uniform-value `add_parameter` classes. Same-module and
named-import candidates necessarily changed an old rename-scope node version.
The only namespace import was `UserTypes`, whose only export (`User`) was
already referenced. The two remaining syntactic candidates did not create a
persisted target reference:

- `User -> Account` plus
  `actor: import("../types/user.ts").User = undefined as never` on `userAudit`
  built an 11-change candidate, but fresh rename analysis remained at 15
  references and 1,065 validation nodes, with zero added target references and
  zero added validation nodes. Through the real daemon X2 published generation
  1 and X1 ended `validation_failed`; no `ScopeExpanded` occurred.
- A dynamic-import property access targeting `formatTimestamp` also built, but
  added zero persisted target references and zero validation resources.

The approved `x-namespace-enriched-v1` feasibility corpus instead makes two
bounded source changes:

```ts
// src/types/user.ts — appended without reordering existing declarations
export function displayUser(user: User): string {
  return user.email;
}
```

```ts
// src/users/serializer.ts — replaces the existing type-only namespace import
import * as UserTypes from "../types/user.ts";
```

The replacement X tasks are:

- X1: rename exported function `displayUser` to `formatUser` throughout the
  registered canonical projection;
- X2: add
  `displayLabel: string = UserTypes.displayUser(user)` at position 1 of
  `serialize` using one uniform value.

The production-daemon feasibility probe passed both publication orders:

- **X2 first:** X2 submitted `ready`, X1 submitted `queued`, and X2 published
  generation 1. Before any X1 `advance_change_set` request, `read_events`
  returned `ScopeExpanded` followed by `intent_ready`. The next X1 advance
  published generation 2 with
  `displayLabel: string = UserTypes.formatUser(user)`.
- **X1 first:** X1 published generation 1. Stale X2 returned `NeedsDecision`.
  A fresh X2 using `UserTypes.formatUser(user)` submitted `ready` and published
  generation 2.
- Both orders produced the same final publication digest. Generation-zero
  source-only TypeScript validation and every bridge-built candidate were
  green.

At the probe's unchanged physical corpus root, the projection moved from 1,203
nodes/592 references to 1,209 nodes/595 references. The existing `User` and
`serialize` declaration IDs and serializer import-statement ID were preserved;
the import payload changed and the appended helper received a new derived ID.
Probe-only abbreviated digests were source `41c9059a…3c6eb8` and graph
`733f260a…48446b`; they are evidence, not frozen manifest values. Task 5 must
regenerate complete source, graph, registration, target, prompt, predicate,
verifier, and final-state digests at the committed physical root.

Observing `ScopeExpanded` through `read_events` required one additive service
protocol extension: `ServiceEvent` frames gained a `kind` field that maps the
kernel's existing internal `CoordinationEventKind` (including `scope_expanded`)
onto the wire verbatim. This changes no scope classification or coordination
semantics — the kernel already recorded these event kinds internally — but it
does amend the protocol-v1 conformance fixture frozen at `9b9c79f`. The
extension is part of the uncommitted Task-5 working set; it must be covered by
its own Rust and TypeScript protocol tests, the updated frozen fixture, and
committed explicitly rather than riding along silently.

This is a disclosed post-falsification existence probe selected before any live
result. It supports only the narrow claim that this namespace-member reference
can trigger safe dynamic expansion. It does not establish prevalence or broad
propagation performance: both X tasks are single-site-class at generation zero,
X1 gains one reference after X2, and the added `displayLabel` parameter is not
otherwise consumed. The new `User` reference slightly changes D/R/G, so results
remain fair within the frozen variant but cannot be pooled with historical
current-corpus measurements.

The operator's approval unblocks Task 5 only. Before Task 6, deterministic TDD
must freeze `x-namespace-enriched-v1`, prove existing logical IDs remain stable,
rerun generation-zero verification and D/M/R/S/X/G in both orders, reclassify
the historical boundary inventory, requalify the extended event-frame protocol
shape (the `kind` field and its frozen conformance fixture), and assert that
`ScopeExpanded` is
externally visible after X2 publication and before X1 candidate advance. No
kernel semantic change or test hook is authorized. No live-model call or spend
is authorized.

## Formal Task-5 requalification result (2026-07-16 evening)

The deterministic requalification ran credential-free through the production
daemon on the frozen `x-namespace-enriched-v1` variant. The committed corpus
edits reproduce the feasibility probe byte-for-byte (frozen source digest
`41c9059a91e814995471708fa3cd165dc15a1f45f492b809d01831978b3c6eb8`). Passed:
manifest freeze with fail-closed drift rows; the pre-enrichment stable-ID
gate (all 82 semantic statements across 22 modules, trivia excluded per the
decisions entry); generation-zero verification for all six packet
configurations; the discovered (not hard-coded) boundary inventory with both
X targets absent outside `src/**`; the exact-X allowed-delta rows; the
extended protocol fixture in both the Rust and TypeScript conformance suites;
D/R/S/G in both publication orders (D with zero fresh decisions, asserted;
R/S/G recording fresh decisions where the kernel refused stale
generation-zero authority, per the full-key-free row-2 semantics — the
identical stable-ID typed intents resubmit unchanged across sibling renames);
and X in both orders with `ScopeExpanded` then `intent_ready` observable
through `read_events` before any X1 advance, the stale-X2 `NeedsDecision`
path, and identical cross-order publication and final-tree digests.

Three harness/manifest defects were found and fixed with no kernel change:
materialization now inspects only operation-affected statements (the sealed
256-child read bound rejects `inspect_nodes` on the corpus's 314-child
`KvStore` class); target scope now collects references into the declaration
subtree (declaration-only matching missed the `src/index.ts`
`export type { User }` re-export that the kernel correctly rewrites); and
tree-level boundary checks compare the root-independent textual inventory
(resolved counts are physical-path- and generation-dependent).

**Stopped at the M same-module gate.** M2 submits `queued` behind the shared
`formatTimestamp` callee reference and returns `needs_decision` after M1
publishes; a cross-module discriminator sharing only the callee also queued
but published cleanly on reanalysis. The design's M clause forbids relabeling
this without review. The M gate test is left red, the Task-5 working set
remains uncommitted, and Task 6 remains blocked pending operator selection
among: amending M's acceptance to the observed protocol semantics; a kernel
scope-inference refinement with a new deterministic proof; or an M
redesign/removal with full requalification. No credential, Agent SDK call, or
spend was used.
