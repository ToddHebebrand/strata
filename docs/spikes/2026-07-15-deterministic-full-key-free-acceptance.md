# Deterministic full key-free acceptance evidence

**Date:** 2026-07-15

**Result:** projection-bounded PASS

**Implementation range:** `4455251..d65aa99`

**Fixture:** ingest-derived `examples/medium`; full semantic snapshot 1,282
nodes/614 references, production candidate source projection 1,203 nodes/592
references across 22 `src/**` modules

## Decision

The Phase-6 deterministic key-free coordination gate passes at the approved
source-projection boundary. Multiple independent logical clients submit real
typed operations through the public Rust kernel, receive scope and authority
derived by Rust from bounded Node semantic facts, and reach one shared green
redb-backed graph without branches, worktrees, text merges, direct canonical
storage, model credentials, or live-model spend.

All twelve governing acceptance rows have named integrated evidence. The
aggregate gate shows zero lost updates, dirty reads, partial publications, and
stale-fence publications; explicit ordering or a fresh decision for overlap;
and independent progress for disjoint scopes. The normal build continues to
seal semantic, fencing, publication, failpoint, and redb authority.

This is not full-fixture candidate validation. Candidate execution remains
bounded to the approved 1,203-node/592-reference `src/**` projection. It also
does not approve structural insert/delete/move concurrency, additional
operation classes, task assignment, a network protocol, multi-host consensus,
or a live-model comparison. The SQLite product path remains supported.

## Environment and method

- macOS 26.5.2 (25F84)
- Node v26.3.0; pnpm 10.26.2
- rustc/cargo 1.89.0
- implementation head `d65aa99a1d0748dbc2e3d0538a4d03da2ad5f3ad`
- fresh aggregate run used `env -u ANTHROPIC_API_KEY -u
  CLAUDE_CODE_OAUTH_TOKEN`
- no benchmark, agent session, model process, model credential, or network
  comparison was invoked
- deterministic actor, request, change-set, attempt, and event-cursor IDs;
  logical ticks only, with no sleep-based ordering

The aggregate root script contains only the bridge build/tests, the dedicated
real-worker acceptance target, all three Rust feature configurations, and the
explicit default authority-sealing target. It contains no `agent`, `bench`, or
live-model command.

## Fresh verification

| Command | Result | Detail |
| --- | --- | --- |
| `env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN pnpm kernel:full-key-free:test` | PASS | 282.59 s; 517 passes, 0 failures across all stages |
| `pnpm -r build` | PASS | 16.43 s; all nine participating workspace packages |
| `cargo fmt --all -- --check` | PASS | 1.23 s |
| `cargo clippy -p strata-kernel --all-targets --all-features -- -D warnings` | PASS | 0.96 s |
| `cargo check -p strata-kernel --no-default-features` | PASS | 5.01 s compiler time |
| `pnpm -r test` | BASELINE FAIL | verify 70/70 passed; stopped at the two known stale agent replay fixtures |
| `pnpm --filter @strata/agent test` | BASELINE FAIL | 53 passed, 2 failed, 2 skipped; both failures name stale declaration `5073ecfb56151b41` |

The aggregate 517 passes are: bridge Vitest 71, default real bridge 3,
integrated acceptance 12, default Rust 71, `coordination-test-api` Rust 142,
`redb-spike-api` Rust 216, and the deliberately repeated explicit sealing
target 2. The integrated target's manifest asserts that integers 1 through 12
are each present exactly once; rows 6, 7, and 11 intentionally share one
restart scenario while retaining distinct owner labels.

The older two-operation evidence reported an unrelated verify TS2454 baseline.
It did not reproduce in this fresh run: `@strata/verify` passed all 70 tests,
including all eight `extractFunctionCommit` cases. No claim is made that this
task fixed it; this branch did not modify the verify package. The only current
workspace-suite failures observed are the two already documented stale agent
replay fixtures in `tests/labSeam.test.ts` and `tests/replay.test.ts`.

## Twelve-row evidence map

| Row | Governing property | Primary integrated evidence |
| ---: | --- | --- |
| 1 | Disjoint progress and lost-update protection | `row_1_disjoint_real_renames_publish_in_both_orders` |
| 2 | Same-symbol FIFO and fresh decision | `row_2_same_symbol_real_renames_require_a_fresh_decision` |
| 3 | Reference-mediated overlap inferred before mutation | `row_3_real_reference_facts_infer_overlap_before_mutation` |
| 4 | Claim-time G+1 expansion requeues before candidate build | `row_4_add_parameter_requeues_before_build_and_updates_the_new_callsite` |
| 5 | Logical-tick aging and starvation freedom | `row_5_real_scopes_age_the_old_wide_ticket_while_only_disjoint_work_bypasses` |
| 6 | Restart fences an old real claim | `rows_6_7_11_restart_fences_old_claim_and_preserves_queue_events_and_exactly_once_publish` |
| 7 | Queue and unacknowledged events survive restart | same integrated restart owner |
| 8 | Real Node publication crashes complete-old or complete-new | `row_8_real_claimed_node_publication_crashes_complete_old_or_new` |
| 9 | Snapshot plus later-operation replay is byte-equivalent | `row_9_real_publications_replay_exactly_across_a_generation_two_snapshot` |
| 10 | Only-green-together composite is one atomic publication | `row_10_add_parameter_alone_fails_validation_without_publication` and `row_10_only_green_together_change_set_publishes_once` |
| 11 | Duplicate delivery, acknowledgement, and publish retry are harmless | same integrated restart owner |
| 12 | Node receives bounded facts/deltas and no coordination authority | `row_12_real_worker_requests_are_bounded_semantic_inputs_only` plus default `api_sealing` |

## Corpus, final-state, and stable-ID evidence

- The unchanged full fixture is 1,282 nodes/614 references. Full-snapshot
  semantic analysis verifies the projection boundary and the four deliberately
  excluded cross-boundary `formatTimestamp` reference sources.
- Production candidate validation uses exactly 1,203 nodes/592 references and
  22 recursively localized `src/**` modules.
- The deterministic G+1 and row-10 localized fixtures contain 1,212 nodes/594
  references. Their nine added nodes and two references have fixed logical IDs;
  the original projected nodes retain their IDs.
- Row 1 ends at generation 2 with the same graph digest in both publication
  orders: `6270d7e7378618bf6278ba3d269849d7203a41edb08f9e0c2785af68504f4de0`.
- Row 9 writes the generation-2 snapshot, publishes generation 3, reopens with
  one replayed operation and no Node process, and recovers digest
  `74fa455acb70bc6be116c94f6fb8b53118d38419ed7244ed1afb5f527ba3edba`.
  Canonical node bytes, reference bytes, reverse-reference index bytes,
  operation order, generation, and graph snapshot are equal before and after
  reopen.
- Row 10's localized composite ends at generation 1 with digest
  `517c14fdd3e2870e7c22fff5d73362adc2359ec31e013125bfc7d9183a45ea42`.
  It preserves the `User`, `greet`, and added-callsite logical IDs and records
  one aggregate `CompositeChangeSet(2)` operation.

Every successful integrated scenario renders and runs TypeScript validation
against its localized real corpus before the test accepts the final state.

## Concurrency, publication, and recovery evidence

- Two G0 disjoint real rename claims publish in either order. Both changes
  survive optimistic rebase, final history has two Rust-owned operations, and
  both orderings converge to the same digest.
- Two same-symbol submissions do not race lexically. The successor observes a
  fresh generation/fingerprint and transitions to `IntentNeedsDecision`
  without a second publication.
- The real `User` reference inside `greet`'s signature causes rename and
  add-parameter to overlap before either client can mutate.
- A waiting add-parameter is reanalyzed against G+1, requeued before candidate
  construction, then updates the new callsite exactly once.
- An older wide, Node-derived scope permits disjoint bypass while blocking
  younger overlap; logical aging makes it claimable after its predecessor
  clears.
- Restart increments the service epoch, rejects the held old claim through the
  normal execution surface, retains the queued ticket and independent event
  cursor, and lets a fresh claim publish once. Redelivery before acknowledgement
  and repeated acknowledgement do not republish.
- The row-10 negative control fails TypeScript validation (`Account` unresolved)
  with bounded diagnostics and no graph/history/generation change. The ordered
  rename plus add-parameter pair validates in one Node scratch transaction and
  becomes one Rust generation and operation, with no visible intermediate
  graph.

## Crash-boundary matrix

The bridge-integrated child-process case carries a real claimed Node candidate
through the same production publication implementation and crashes at four
adjacent process boundaries:

| Boundary | Required durable state after Node-free reopen |
| --- | --- |
| `beforeRedbTransaction` | complete old tuple |
| `insideRedbTransaction` | complete old tuple |
| `afterRedbCommitBeforeMemoryPublish` | complete new tuple |
| `afterMemoryPublish` | complete new tuple |

The normalized tuple compares graph snapshot/digest, table counts, operations,
deltas, events, tickets, idempotency mappings, change sets, offers, claims,
attempts, fences, live and durable clocks, scheduler revisions, metadata, and
service epoch. No mixed tuple is accepted.

These four process-kill joins complement, rather than replace, the existing 22
in-transaction rollback points: after fence mutation, after each of 18 durable
inserts, after resource-clock write, after attempt write, and before commit.
The evidence does not claim instruction-level fault injection inside the redb
engine.

## Authority and protocol sealing

Rust remains authoritative for resource keys, dependency clocks, reservations,
fencing, containment, dynamic expansion policy, idempotency class, candidate
digest, publication, history, and recovery. Node requests are checked against
exact analyze/candidate key allowlists and a recursive 22-key authority deny
list; they contain approved source paths and anti-replay bindings, but no redb
path or canonical store handle. Node returns only bounded semantic facts or a
validated graph delta.

`PublishFailpoint` and the crash execution entry point exist only with
`redb-spike-api`. Default-feature trybuild tests prove callers cannot access raw
publication, semantic-provider injection, production execution authority, or
coordinated crash execution. The existing 22-point coordinated rollback hook
remains feature-gated. Clients never enumerate reservation keys and never open
redb directly.

## Divergence and remaining boundary

No implementation result diverged from the approved acceptance design, so no
new `decisions.md` entry was required. The only production change centralizes
the already-approved four crash boundary names and connects a hidden,
feature-gated crash executor to the same installed production candidate and
publication path; it does not create client-visible authority.

The deterministic gate is complete. Live Strata-versus-worktrees comparison
remains unrun and is a separate operator decision. Structural
insert/delete/move concurrency remains deferred pending stable logical IDs
independent of sibling position.
