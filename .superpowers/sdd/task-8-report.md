# Task 8 report — deterministic multi-client scheduler acceptance

## Status

Implemented the key-free scheduler acceptance harness over the committed ingest-derived
`examples/medium` graph (1,282 nodes, 614 references). The harness is entirely under
`crates/strata-kernel/tests`; no production semantic analyzer, candidate builder, Node bridge,
transport, model call, sleep, or wall-clock dependency was added.

## TDD evidence

- RED: `cargo test -p strata-kernel --test coordination_acceptance -- --nocapture` failed with
  `E0583: file not found for module support` after the real-fixture acceptance test was written
  before its test support.
- GREEN focused default with output: `cargo test -p strata-kernel --test coordination_acceptance
  -- --nocapture` — 9 passed, 0 failed.
- GREEN focused feature: `cargo test -p strata-kernel --features redb-spike-api --test
  coordination_acceptance -- --nocapture` — 10 passed, 0 failed, including coordinated
  pre-commit graph/coordination/fence rollback.
- GREEN repeat gate: `for i in 1 2 3 4 5; do cargo test -p strata-kernel --test
  coordination_acceptance || exit 1; done` — five consecutive runs, each 9 passed, 0 failed.
- GREEN full default: `cargo test -p strata-kernel` — 57 passed, 0 failed.
- GREEN full feature: `cargo test -p strata-kernel --features redb-spike-api` — 107 passed,
  0 failed.
- Formatting/lints: `cargo fmt --all`; `cargo fmt --all -- --check`; strict default and
  `redb-spike-api` Clippy over all targets both passed with `-D warnings`.

## Acceptance coverage

- The analyzer matches only `IntentParameters::{RenameSymbol, AddParameter}`. It selects real
  declaration/function nodes by the supplied IDs, derives declaration identifiers from their
  graph children, discovers incoming references through `GraphGeneration::references_to`, and
  derives function-body dependencies from the snapshot's outgoing reference index. It never
  switches on or maps `intent_id` to a pre-authored scope.
- Node versions are SHA-256 over the complete real `NodeRecord`; reference versions are SHA-256
  over the complete real `ReferenceRecord`. Changing declaration/function IDs changes the scope,
  and unknown IDs fail. Existing resource versions remain content-addressed across unrelated
  graph generations. The sole allowed scripted interleaving adds a real callsite reference source
  at generation 1 and includes that appearance generation in the added resource's version.
- Serialized begin, typed add-intent, and submit inputs contain no reservation keys, scope
  fingerprints, fences, claim tokens, or resource tokens.
- Two disjoint real rename-shaped scopes are Ready together and commit after fresh claims in both
  publication orders. Generation-bound claim authority remains intact; the test does not weaken
  fences by carrying a pre-claimed handle across another publication.
- Same-symbol work is FIFO. The successor is atomically woken with blocking operation ID,
  before/after generations, and bounded affected-node context; fresh claim-time analysis sees the
  changed declaration payload and returns `IntentNeedsDecision` without applying its stale rename.
- `AddParameter(greet)` overlaps `RenameSymbol(User)` solely because `greet`'s real graph child
  references `User`. A generation-1 scripted extra callsite produces a strict additive scope,
  `ScopeExpanded`, and requeue before candidate construction or graph mutation.
- Malicious builders that update a different real node or retarget a real unreserved reference are
  rejected by containment. Digest, generation, change set, ticket, events, operation table, and
  scheduler projection remain unchanged.
- An older wide composite ticket ages while five newer disjoint jobs progress and five newer
  overlapping jobs remain queued. Cancelling the small priority hold immediately offers and claims
  the wide ticket before every younger overlap.
- Restart preserves both ticket IDs and earlier event IDs, invalidates the old ready offer/service
  epoch, appends `LeaseExpired`, returns byte-equal duplicate deliveries, and keeps client cursors
  independent and monotonic.
- A two-intent change set changes two real nodes in exactly one graph generation and one aggregate
  operation. The feature-gated pre-commit failpoint exposes neither node change, operation, event,
  nor fence mutation.

## Files

- `crates/strata-kernel/tests/coordination_acceptance.rs` — nine default acceptance tests plus one
  feature-gated coordinated rollback test.
- `crates/strata-kernel/tests/support/coordination.rs` — real-fixture lookup, graph-derived test
  analyzer, typed input helpers, and delta-only test candidate builders.

## Self-review and plan-wording resolution

- Audited the analyzer for intent-ID coupling: `intent_id` is never read; only typed parameters and
  the supplied immutable graph determine scope.
- Audited deterministic inputs: logical ticks are constants, UUID/event IDs are asserted only for
  persistence/equality rather than exact values, and there are no sleeps, model calls, or system
  time reads.
- The plan phrase “payload SHA-256 values plus graph generation” cannot mean hashing the global
  generation into every existing resource version: that would replace every version after any
  unrelated commit, classify disjoint work as materially changed, and contradict the accepted
  disjoint-progress semantics. The harness therefore uses content-addressed versions for existing
  nodes/references, carries graph generation through `GraphGeneration`/offers/claims, and hashes
  the selected appearance generation only into the permitted scripted extra-callsite resource.
  Task 9 should record this plan-wording clarification in `decisions.md`; no production design or
  schema changes are required.
- The kernel intentionally binds claims to one graph generation. Consequently the disjoint proof
  establishes simultaneous independent readiness and fresh claims after either publication order,
  rather than pre-claiming both and weakening stale-generation rejection.

## Concerns / deferred scope

- This analyzer models only scheduler authority and deterministic graph-derived scope. It is not a
  substitute for TypeScript rename/add-parameter semantics, rendering, tsc/vitest validation, or
  the later Node worker bridge.
- Successor `IntentReady` carries the persisted ticket fingerprint/offer plus bounded blocking
  context; the decisive freshness check occurs at claim, where same-symbol work becomes
  `IntentNeedsDecision`. Ready-time semantic reanalysis for every waiter would require an analyzer
  authority in the release path and remains outside this scheduler API.
