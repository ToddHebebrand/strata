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
- Review RED: the publication-wake tests first failed because a same-symbol successor still
  received a stale Ready offer and because an unchanged successor event omitted its fresh
  `scopeFingerprint`. Reopen assertions also exposed that legitimate pre-submit Ready events must
  be counted rather than globally forbidden after crash recovery.
- GREEN focused default with output: `cargo test -p strata-kernel --test coordination_acceptance
  -- --nocapture` — 11 passed, 0 failed.
- GREEN focused feature: `cargo test -p strata-kernel --features redb-spike-api --test
  coordination_acceptance -- --nocapture` — 12 passed, 0 failed, including coordinated
  pre-commit graph/coordination/fence rollback.
- GREEN repeat gate: `for i in 1 2 3 4 5; do cargo test -p strata-kernel --test
  coordination_acceptance || exit 1; done` — five consecutive runs, each 11 passed, 0 failed.
- GREEN full default: `cargo test -p strata-kernel` — 59 passed, 0 failed.
- GREEN full feature: `cargo test -p strata-kernel --features redb-spike-api` — 109 passed,
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
- Same-symbol work is FIFO. Publication reanalyzes the successor against the prepared post-commit
  graph and atomically persists `IntentNeedsDecision` with the blocking operation ID,
  before/after generations, bounded affected-node context, and fresh fingerprint. It receives no
  stale Ready offer and never applies its stale rename.
- An unchanged successor is reanalyzed on the prepared graph before it receives authority; its
  durable scope, ticket, Ready offer, and event payload all carry the same fresh fingerprint.
- A publication-time `AddParameter` expansion persists the new scope and increments the bounded
  expansion count before scheduler selection is recomputed. If the expanded complete scope is
  eligible, the same redb transaction emits `ScopeExpanded`, then a fresh `IntentReady` offer.
- `AddParameter(greet)` overlaps `RenameSymbol(User)` solely because `greet`'s real graph child
  references `User`. A later scripted extra callsite also proves claim-time strict expansion,
  `ScopeExpanded`, and requeue before candidate construction or graph mutation.
- Malicious builders that update a different real node or retarget a real unreserved reference are
  rejected by containment. Digest, generation, change set, ticket, events, operation table,
  scheduler projection, and fences remain unchanged; the same claim still reaches a probe builder,
  and reopen proves no publication side effect survived before normal lease recovery requeues it.
- An older wide composite ticket ages while five newer disjoint jobs progress and five newer
  overlapping jobs remain queued. Cancelling the small priority hold immediately offers and claims
  the wide ticket before every younger overlap.
- Restart preserves both ticket IDs and earlier event IDs, invalidates the old ready offer/service
  epoch, appends `LeaseExpired`, returns byte-equal duplicate deliveries, and keeps client cursors
  independent and monotonic.
- A two-intent change set changes two real nodes in exactly one graph generation and one aggregate
  operation. The feature-gated pre-commit failpoint exposes neither node change, operation, event,
  nor fence mutation both immediately and after dropping/reopening the durable store and kernel.

## Files

- `crates/strata-kernel/src/coordination/coordinator.rs` — review-driven publication-time successor
  reanalysis and atomic lifecycle projection.
- `crates/strata-kernel/src/coordination/scheduler.rs` — review-driven queued-scope replacement on
  the cloned scheduler projection.
- `crates/strata-kernel/tests/coordination_acceptance.rs` — eleven default acceptance tests plus
  one feature-gated coordinated rollback test.
- `crates/strata-kernel/tests/support/coordination.rs` — real-fixture lookup, graph-derived test
  analyzer, typed input helpers, and delta-only test candidate builders.

## Self-review and plan-wording resolution

- Audited the analyzer for intent-ID coupling: `intent_id` is never read; only typed parameters and
  the supplied immutable graph determine scope.
- Audited deterministic inputs: logical ticks are constants, UUID/event IDs are asserted only for
  persistence/equality rather than exact values, and there are no sleeps, model calls, or system
  time reads.
- Audited publication atomicity: successor analysis runs over the prepared immutable generation;
  every scheduler and lifecycle mutation is confined to cloned/in-memory transition state until
  graph, operation, coordination, event, digest, and fences commit in one redb transaction. The
  live graph and scheduler projection install only after commit.
- Audited FIFO after scope expansion: selection is recomputed from the complete fresh scope. An
  older expanded ticket cannot claim through an overlapping active/Ready scope, and a younger
  pre-existing Ready offer cannot claim past the newly overlapping older queue position; bounded
  lease expiry or restart releases that transient hold.
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
- Cancellation/explicit reconsideration remain analyzer-free lifecycle paths; the publication path
  now owns the required post-commit successor reanalysis because it already receives analyzer
  authority. Extending equivalent semantic reanalysis to other release paths belongs with the
  later production TypeScript analyzer integration, not this deterministic Task 8 harness.
