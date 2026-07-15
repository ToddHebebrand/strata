# Coordination authority and concurrency correction result

**Decision:** PASS — bounded deterministic Rust/redb coordination-kernel proof

**Executed:** 2026-07-14–15

**Integrated base:** `8422f4e`

**Final implementation commit:** `f02b9095aa0c9d8752f08068db5cc70b7bbf6337`

**Final pre-documentation evidence head:** `f8d0d99b42f0345bc4bd1926ab7b806353a47f19`

**Corpus:** committed ingest-derived `examples/medium` snapshot (1,282 nodes, 614 references)

This report supersedes the result, but does not erase the evidence, in
[`2026-07-14-coordination-scheduler.md`](2026-07-14-coordination-scheduler.md). The initial PASS was
withdrawn because default callers could mint semantic authority, simultaneous disjoint claims were
invalidated by global generation, candidate construction held global locks, release paths could
create stale Ready authority, and incomplete leases could strand authority. The correction closes
those failures at the bounded research-kernel level.

## Exact scope of the PASS

This is a deterministic, feature-gated Rust/redb research proof over a real ingest-derived graph.
It proves the tested kernel-owned semantic boundary, durable dependency clocks, centralized fresh
readiness, deterministic leases, unlocked optimistic claimed publication, fencing, recovery
validation, and atomic publication at the enumerated boundaries.

It does **not** prove a production coordination service. Default builds cannot install or execute a
semantic provider; they return `SemanticProviderUnavailable`. The common read-only recovery
integrity validator does run in default builds. Deterministic provider and builder injection exists
only behind the research feature.

The unlocked-work result applies only to claimed coordination publication: semantic analysis,
candidate building, graph application, digest validation, and readiness planning on that path run
outside the publication and scheduler mutexes. It is not a blanket statement about future worker or
bridge code. Attempt binding is cross-record consistency among the attempt, committed change set,
operation, graph event, generation, delta, and digest; it is not cryptographic provenance.

Crash evidence covers explicit enumerated pre-commit/in-transaction failpoints and redb transaction
rollback. It does not inject crashes within redb's internal commit instructions. The workspace is
not green: the authorized verify baseline and supplemental stale agent fixtures are disclosed
below.

Production TypeScript semantics and candidate generation, the Node worker bridge,
transport/authentication, process isolation, task decomposition or orchestration, multi-host
consensus, the two-operation proof, full key-free acceptance, and live model comparison remain
unimplemented and blocked. The supported SQLite product path is unchanged.

## Implementation lineage

The integrated correction is the repository range `8422f4e..f02b909`. The implementation sequence
sealed default authority (`0492a36`), added durable resource clocks and centralized readiness
(`90ce93c`, `bd1cc9a`, `88cd1d7`), added deterministic leases and durable attempts (`4faa8a2`,
`1eb6b37`, `f1ca9b5`, `09c041d`), moved claimed publication to unlocked optimistic validation
(`096a305`, `e3982f8`, `8d9be83`), hardened atomic recovery (`72215db`, `c7414d5`), closed the
integrated acceptance and review gaps (`0437246`, `1f3b2a8`), and added actual legacy physical-schema
migration (`f02b909`). Evidence-only commits through `f8d0d99` record the final audit without
changing kernel behavior.

## Toolchain

- `rustc 1.89.0 (29483883e 2025-08-04)`
- `cargo 1.89.0 (c24e10642 2025-06-23)`
- redb `4.1.0`
- Node.js `v26.3.0`
- pnpm `10.26.2`
- TypeScript `5.9.3`
- Vitest `3.2.4` (`darwin-arm64`)

No model key, sleep, wall-clock scheduling dependency, or live agent run was used by the gate.

## Final ordered gate

The parent agent ran this exact sequence at final pre-documentation head `f8d0d99`:

```bash
cargo fmt --all -- --check
cargo clippy -p strata-kernel --all-targets -- -D warnings
cargo clippy -p strata-kernel --features redb-spike-api --all-targets -- -D warnings
cargo test -p strata-kernel
cargo test -p strata-kernel --features redb-spike-api
pnpm --filter @strata/ingest build
pnpm --filter @strata/ingest test
pnpm -r build
pnpm -r test
```

Formatting and both strict Clippy variants passed with zero warnings. Default Rust passed 33/33;
`redb-spike-api` passed 171/171; focused `coordination_recovery` passed 23/23. Ingest built and
passed 8/8 tests. `pnpm -r build` completed all 8 buildable workspace projects.

The exact `pnpm -r test` command exited 1 with only the authorized first-failure baseline before
pnpm stopped: store 177/177, render 13/13, ingest 8/8, and verify 69/70. The sole reached failure is
`packages/verify/tests/extractFunctionCommit.test.ts:228`: the extractor accepts an unsafe
`let args` span and the commit gate rejects TS2454 (`args` used before assignment). No correction
file touches that TypeScript path.

A supplemental `pnpm -r --no-bail test` found the same verify failure plus two pre-existing stale
T03 replay-fixture failures in `@strata/agent`, both using declaration ID `5073ecfb56151b41`.
Store, ingest, render, CLI, bench, and the non-authoritative lab script passed. The integrated
correction diff is empty across `packages/agent`, `examples/medium`, `packages/store`,
`packages/ingest`, and `packages/verify`; these failures are disclosed as baseline debt, not called
new kernel failures. The workspace is not green.

## Eight-scenario acceptance matrix

Every scenario uses the committed medium snapshot. Durable evidence means canonical redb reads or
drop/reopen comparison; live evidence means the in-memory graph or scheduler projection.

| # | Falsifying scenario | Exact evidence | Result |
|---:|---|---|---|
| 1 | Default semantic authority sealing | `coordination_authority::default_kernel_rejects_semantic_execution_without_side_effects`; `api_sealing::semantic_authority_is_not_exported_by_default` | A real `User` intent returns `SemanticProviderUnavailable` without events or graph/lifecycle mutation; reopen agrees, and compile-fail coverage seals provider injection. **PASS.** |
| 2 | Two disjoint claims captured before either publication | `coordination_optimistic::two_disjoint_claims_captured_before_publication_both_commit_in_either_order` | Both generation-0 claims publish in either order, reach generation 2, mutate both real nodes, persist both Committed states, and reopen to the live digest. **PASS.** |
| 3 | Affected dependency invalidation | `coordination_optimistic::every_dependency_clock_class_invalidates_affected_work_but_unrelated_work_rebases` | Node, children, edge, references-to, namespace, and absence clocks invalidate affected authority without leaking candidates; unrelated work rebases and commits. **PASS.** |
| 4 | Lifecycle progress while a builder is active | `coordination_optimistic::builder_can_run_disjoint_lifecycle_and_event_replay_without_global_lock_blocking`; `candidate_builder_observes_both_global_mutexes_unlocked` | During a blocked builder, real disjoint work submits and claims, reconsideration and cancellation complete, a claim actually due at tick 61 expires, and events replay; publisher/disjoint/expired/cancelled durable states and lock freedom are asserted. **PASS.** |
| 5 | Fresh analysis on every release path | `coordination_leases::every_release_cause_uses_the_latest_provider_scope_and_current_generation`; `publication_successor_offer_uses_fresh_unlocked_analysis_on_committed_graph` | Cancellation, offer expiry, claim expiry, rejection, and successful publication use centralized fresh analysis and persist current-generation scope. **PASS.** |
| 6 | Restart and expiry fencing | `coordination_leases::restart_and_expiry_are_idempotent_and_old_epoch_claims_are_fenced` | Old-epoch authority returns `LeaseExpired`; graph state is unchanged across reopens; expiry is durable/idempotent with no duplicate event. **PASS.** |
| 7 | Same-attempt replay and mismatch rejection | `coordination_publication::same_attempt_same_digest_replays_but_changed_digest_is_rejected`; `coordination_recovery` attempt-corruption cases | Same digest replays the original generation/digest across reopen; changed digest is rejected without mutation; reopen verifies cross-record identity and digest consistency. **PASS.** |
| 8 | Complete-old-or-complete-new failpoint reopen | `coordination_publication::failure_after_in_transaction_fence_mutation_rolls_back_fences_graph_and_coordination`; `atomic_state_distinguishes_wrong_graph_publication_content` | Reopen at `AfterFenceMutation`, every actual `AfterInsert(1..=18)`, `AfterResourceClockWrite`, `AfterAttemptWrite`, and `BeforeCommit` equals normalized complete old or complete new state; deliberate content corruption compares unequal. **PASS at the enumerated boundaries.** |

The broader real-fixture `coordination_acceptance` harness passed 12/12. Provider-failure
regressions additionally prove that one failing queued semantic analysis cannot abort an unrelated
claimed publication, cancellation, or due claim expiry. The failed ticket remains nonselectable
and preserves FIFO blocking for younger overlapping work while disjoint work progresses. In the
expiry case, the live state durably exits `Executing` to `Queued`; reopen recovery replans it to
`Ready`, with no active claim in either state. The invariant is non-stranding, not byte-identical
live/reopen lifecycle records.

## Recovery and compatibility correction

`DurableStore::open` does not repair coordination metadata before validation. The same common
read-only integrity validation runs in default and feature builds before service-epoch recovery.
A retained recovery-validation version requires exact queue/event/revision metadata, lifecycle and
clock markers, event-ID mappings, resource clocks, publication-attempt tables, canonical digests,
and cross-record linkage. Corruption fails closed and failed open does not self-heal it.

The compatible legacy shape is reproduced from the physical schema at commit `8422f4e`: ten
coordination tables and two metadata keys, with no resource-clock or publication-attempt table. It
is not an archived database artifact. Complete absence of the recovery-validation version and both
subordinate markers is treated as legacy; that rule cannot distinguish genuine legacy state from
deliberate deletion of the complete marker triplet. Only this marker-absent state may treat the two
new tables as empty and derive a migration. Schema creation, marker/metadata backfill,
service-epoch advancement, and authority recovery commit in one transaction; a `BeforeCommit`
failpoint proves rollback together. Retained/versioned databases require both tables and all
markers and never receive this migration.

## Independent reviews

The fresh integrated whole-branch reviewer inspected `8422f4e..f8d0d99` and specifically tried to
falsify default authority sealing, simultaneous disjoint publication, lock freedom, centralized
Ready creation, non-stranded leases, durable clock/attempt/lifecycle integrity, provider-failure
isolation, and legacy recovery. After the fixes above, it approved with no findings.

The required external review used Codex `gpt-5.6-sol`, reasoning `xhigh`, read-only, against the
approved design, falsified prior evidence, integrated diff, tests, and gate output. Its pivotal
empirical compatibility concern produced the exact physical-schema regression rather than being
accepted on faith. After that fix and the wording limitations recorded here, its final verdict was
**APPROVE BOUNDED PASS** with only wording caveats, now incorporated.

## Decision

Restore only the roadmap's **Coordination kernel** item. Keep **Two-operation proof**, **Key-free
acceptance**, and **Live falsifiable comparison** open. Do not begin or claim the TypeScript
semantic/validation bridge, worker bridge, service/transport/authentication, process isolation, or
live model work from this result alone.
