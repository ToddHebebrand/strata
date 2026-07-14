# Coordination scheduler result

**Decision:** PASS

**Executed:** 2026-07-14

**Implementation commit:** `1410eaa44db618a29a2398cd08c6503c3281d4fa`

**Corpus:** `examples/medium` (1,282 nodes and 614 references in the committed ingest-derived fixture)

The bounded coordination-scheduler gate passed. Typed intent records, graph-inferred semantic scopes, all-or-ticket scheduling, durable tickets and events, FIFO ordering and aging, fresh-state wakeups, service epochs, coordinated fencing, delta containment, and atomic claimed publication are implemented in the Rust kernel and pass deterministic tests. The acceptance harness uses typed intent parameters and the real graph to derive scopes; clients do not provide reservation keys.

This is a scheduler result, not the full Phase-6 proof. Rows 1–5 below are scheduler-level tests using an intent-and-graph-derived test analyzer. They do not establish production TypeScript rename or add-parameter semantics, rendering, compiler/test validation, the Node worker bridge, transport/authentication, or live multi-agent performance. Those remain separate gates.

## Toolchains

- `rustc 1.89.0 (29483883e 2025-08-04)`
- `cargo 1.89.0 (c24e10642 2025-06-23)`
- Node.js `v26.3.0`
- pnpm `10.26.2`
- TypeScript `5.9.3`
- redb `4.1.0`

No model, API, keyed command, sleep, or wall-clock scheduling dependency was used.

## Final gate commands

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

Formatting and both strict Clippy variants passed. The default kernel suite passed 59 tests, including the compile-fail proof that raw publication authority is not exported. The `redb-spike-api` suite passed 109 tests, including the bounded durability, crash, replay, legacy-fencing, coordinated-publication failpoint, and deterministic duplicate-finishing proofs. Ingest built and passed 8/8 tests. The recursive TypeScript build passed.

`pnpm -r test` exited 1 with exactly one authorized, pre-existing failure. Store passed 177/177, render 13/13, ingest 8/8, and verify passed 69/70. The sole failure was:

```text
FAIL  tests/extractFunctionCommit.test.ts > extract_function on the real corpus > extracts a contiguous span from a medium-corpus function and commits green
AssertionError: expected false to be true // Object.is equality
 ❯ tests/extractFunctionCommit.test.ts:228:25
    226|     if (!(analysis instanceof Error)) {
    227|       const result = commit(db, tx);
    228|       expect(result.ok).toBe(true);
```

As recorded by the preceding redb gate, the extractor accepts an unsafe `let args` span and the commit gate rejects TypeScript diagnostic TS2454 (`args` used before assignment). The scheduler work did not modify this test or the TypeScript extraction path. It remains the sole pnpm failure and is not classified as a scheduler failure.

## Approved deterministic acceptance matrix

| # | Approved acceptance item | Scheduler evidence | Result |
|---:|---|---|---|
| 1 | Two disjoint renames remain independently runnable and both commit | Scheduler-level intent+graph-derived test-analyzer proof: `disjoint_work_is_ready_together_and_commits_after_fresh_claims_in_either_order` uses two real declaration IDs and publishes in both orders with fresh generation-bound claims. | **PASS — scheduler level** |
| 2 | Two same-symbol renames are ordered; the second receives fresh state and `IntentNeedsDecision` | Scheduler-level intent+graph-derived test-analyzer proof: `same_symbol_is_fifo_then_wakes_with_bounded_context_and_needs_fresh_decision` verifies FIFO, post-publication reanalysis, bounded wake context, the blocking operation, and rejection of the stale requested delta. | **PASS — scheduler level** |
| 3 | Rename and reference-touching work are inferred as overlapping | Scheduler-level intent+graph-derived test-analyzer proof: `reference_overlap_and_claim_time_callsite_expansion_are_inferred_before_mutation` derives overlap from real graph references without client keys. | **PASS — scheduler level** |
| 4 | `add_parameter` discovers a callsite added while waiting and requeues before mutation | The scheduler-level intent+graph-derived test analyzer proves the expansion/requeue mechanism with a permitted scripted extra real reference, but it is not a production TypeScript analyzer. | **not part of scheduler gate — TypeScript validation bridge** |
| 5 | An older wide rename cannot be starved by newer small edits | Scheduler-level intent+graph-derived test-analyzer proof: `older_wide_ticket_ages_without_starvation_while_only_disjoint_work_passes` permits newer disjoint progress, blocks every younger overlap, and immediately offers the older wide ticket after release. | **PASS — scheduler level** |
| 6 | Stale fencing tokens and old service epochs cannot publish | Default coordinated claims reject stale generation/offer/fingerprint/epoch state; feature tests cover in-transaction fence rollback and the six legacy fencing cases, including token supersession, one-use claims, and restart epoch invalidation. | **PASS** |
| 7 | Queued tickets and unacknowledged events survive restart | `restart_preserves_ticket_event_identity_invalidates_offers_and_keeps_cursors_independent` plus the four durable recovery tests preserve ticket/event IDs, requeue expired authority once, and append the recovery event atomically. | **PASS** |
| 8 | Redb failure injection yields complete old or new state, never partial state | Inherited bounded redb spike PASS at the four explicit boundaries adjacent to the transaction/memory swap; scheduler publication additionally reopens after coordinated failpoints spanning fence mutation, graph/coordination inserts, successor writes, and pre-commit. Redb commit internals are not instruction-level fault-injected. | **PASS at the tested boundaries** |
| 9 | Snapshot-plus-operation replay produces equivalent state and digest | Inherited redb spike replay PASS: the feature suite verifies intermediate generation digests and rejects corrupt, missing, wrong-base, and wrong-key replay inputs. | **PASS** |
| 10 | Two changes valid only together commit as one validated change set | The scheduler proves two intents publish two real node changes in one generation and one aggregate operation, including atomic rollback. It does not run real grouped TypeScript validation. | **not part of scheduler gate — TypeScript validation bridge** |
| 11 | Duplicate event delivery is harmless through stable IDs and acknowledged cursors | `restart_preserves_ticket_event_identity_invalidates_offers_and_keeps_cursors_independent` returns byte-equal duplicate deliveries and maintains independent monotonic client cursors; durable event IDs are unique. | **PASS** |
| 12 | No client or Node worker can mutate canonical storage outside the kernel | Default Rust builds seal the raw store/publication/fencing/failpoint API, proven by `api_sealing` compile-fail coverage; claimed publication derives and commits graph, coordination, event, operation, and fence state inside the kernel. Transport/authentication and Node worker process isolation do not exist yet. | **PASS for default Rust API sealing; not part of scheduler gate — multi-client service plan** |

## Scope derivation clarification

The test analyzer versions node resources by hashing `(NodeRecord, appeared_at_generation)`: ordinary fixture nodes use appearance generation 0, while the deliberately scripted newly appearing callsite source node uses its actual appearance generation. Reference resources hash the complete `ReferenceRecord` without a generation component. The immutable `GraphGeneration`, ready offer, and claim separately carry global generation authority. Hashing the global graph generation into every existing-resource version would change every version after an unrelated publication, turn disjoint progress into a material scope change, and falsify acceptance item 1. This resolves the plan phrase “payload SHA-256 values plus graph generation” in favor of the accepted disjoint-progress invariant; it does not change the production schema.

## Bounded correctness result

Across the tested scheduler interleavings there were zero partial reservations, lost tickets or events, stale-claim publications, out-of-scope deltas, starvation cases, or non-atomic coordinated publications. Duplicate finishing returns the original generation and digest without rebuilding or appending a second event, including a deterministic racing duplicate and a retry after a later disjoint generation. Malicious node and reference deltas leave graph, ticket, event, operation, scheduler, digest, and fencing state unchanged.

**PASS.** The coordination scheduler is sufficient to unblock a separate TypeScript validation-bridge plan. The two-operation proof, full key-free acceptance, multi-client service boundary, and live falsifiable comparison remain open. This task does not begin or plan the bridge, authorize model spend, or replace the supported SQLite product path.
