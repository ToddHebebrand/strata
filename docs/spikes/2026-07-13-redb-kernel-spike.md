# Redb kernel spike result

**Decision:** PASS

**Executed:** 2026-07-14

**Implementation commit:** `62bd6c7e866ee416aaa207c43a1a696a73d68c12`

**Corpus:** `examples/medium`

The bounded redb spike passed its stop/go gate. Atomic publication, digest-verified crash recovery and snapshot replay, concurrent immutable readers, and stale fencing rejection all passed on the real corpus. This result unblocks a separate coordination-scheduler plan; it does not claim that the scheduler, validation bridge, multi-client service, or live agent experiment exists.

## Toolchains

- `rustc 1.89.0 (29483883e 2025-08-04)`
- `cargo 1.89.0 (c24e10642 2025-06-23)`
- Node.js `v26.3.0`
- pnpm `10.26.2`
- TypeScript `5.9.3`
- redb `4.1.0` (locked in `Cargo.lock`)

No model, API, or keyed command was run.

## Commands

```bash
cargo run -p strata-kernel --bin redb-spike -- \
  make-rename-publication \
  --snapshot crates/strata-kernel/tests/fixtures/examples-medium.snapshot.json \
  --out target/examples-medium.rename-publication.json

pnpm --filter @strata/ingest build
pnpm --filter @strata/ingest test
cargo fmt --all -- --check
cargo clippy -p strata-kernel --all-targets -- -D warnings
cargo test -p strata-kernel
pnpm -r build
pnpm -r test

cargo run -p strata-kernel --bin redb-spike -- \
  seed \
  --db target/redb-spike.redb \
  --snapshot crates/strata-kernel/tests/fixtures/examples-medium.snapshot.json

# Run three consecutive times against the same seeded database.
cargo run -p strata-kernel --bin redb-spike -- \
  measure \
  --db target/redb-spike.redb \
  --publication target/examples-medium.rename-publication.json \
  --iterations 100

git rev-parse HEAD
rustc --version
cargo --version
node --version
pnpm --version
pnpm exec tsc --version
```

The publication helper reported 16 affected `User` identifier nodes. The ingest build and all 7 ingest tests passed. `cargo fmt`, clippy with warnings denied, and all 34 kernel tests passed after the final measurement-interface correction. The full pnpm build passed.

`pnpm -r test` reproduced one authorized, pre-existing failure in `@strata/verify`: 69 of 70 verify tests passed, with `tests/extractFunctionCommit.test.ts:228` expecting an unsafe real-corpus extraction to commit. The analyzer accepts extraction of `let args`, then the commit gate correctly rejects TypeScript diagnostic 2454 (`args` used before assignment). Before the recursive run stopped, store passed 177/177, render 13/13, and ingest 7/7. This defect was reproduced before the spike, is unrelated to Rust/redb, and was not changed or counted as a durability, recovery, reader, or fencing failure.

## Seed evidence

Unedited JSON output:

```json
{"command":"seed","digest":"ba789c618092f9df9bbbb5d34ee16f0c45effb023659a226e4fcccd271f64eea","generation":0,"nodeCount":1282,"redbFileBytes":1056768,"referenceCount":614,"seedNs":219865083,"serviceEpoch":1}
```

## Measurement evidence

There was no performance pass threshold and no SQLite comparison. Each run used the same real 16-node rename affected set, but rewrote the base generation, operation/change-set/ticket/event IDs, event sequence, idempotency key, and authoritative fence for every publication.

Run 1, unedited JSON output:

```json
{"averageNs":51761714,"command":"measure","currentNodeCount":1282,"currentReferenceCount":614,"digest":"852364175e42878099d8eaf8b6311f3ab89ae26968649786bbfd2e4a2ae47075","generation":100,"initialNodeCount":1282,"initialReferenceCount":614,"iterations":100,"memoryPublishNs":{"max":4209,"p50":1667,"p95":2583},"publicationPersistenceNs":{"max":44742584,"p50":10388041,"p95":32618709},"recoveryNs":51815583,"redbFileBytes":1585152,"replayedOperations":0,"totalNs":5176171459}
```

Run 2, unedited JSON output:

```json
{"averageNs":47476803,"command":"measure","currentNodeCount":1282,"currentReferenceCount":614,"digest":"92d27bf0ddce39023c2f6cb5f4fb15de53f00a2bb81426d452940bfe6f5968fe","generation":200,"initialNodeCount":1282,"initialReferenceCount":614,"iterations":100,"memoryPublishNs":{"max":13083,"p50":1667,"p95":2291},"publicationPersistenceNs":{"max":68120708,"p50":9510709,"p95":29801084},"recoveryNs":3056953750,"redbFileBytes":2375680,"replayedOperations":100,"totalNs":4747680375}
```

Run 3, unedited JSON output:

```json
{"averageNs":57354635,"command":"measure","currentNodeCount":1282,"currentReferenceCount":614,"digest":"75f8e21ea237b8b519f7328004a1a6fce24e750a03faa581be4fdd5304ea0d52","generation":300,"initialNodeCount":1282,"initialReferenceCount":614,"iterations":100,"memoryPublishNs":{"max":15500,"p50":1666,"p95":2625},"publicationPersistenceNs":{"max":81661250,"p50":18546583,"p95":41839541},"recoveryNs":4467036958,"redbFileBytes":2375680,"replayedOperations":200,"totalNs":5735463500}
```

The three runs advanced generation 0 → 100 → 200 → 300 and retained 1,282 nodes and 614 references. Publication-persistence p50 was 9.51–18.55 ms; p95 was 29.80–41.84 ms; max was 44.74–81.66 ms. The separate in-memory generation-swap p50 was 1.666–1.667 µs, p95 was 2.291–2.625 µs, and max was 4.209–15.500 µs. These are observations from three unoptimized development-build runs, not production claims.

## Redb spike gate

| Required property | Evidence | Result |
|---|---|---|
| Atomic graph delta + operation + event + ticket + fence publication | `storage_atomic::publication_is_atomic_and_durable_across_reopen`; rejected-publication table-count tests | PASS |
| Process termination at every publication boundary | `crash_recovery::process_crashes_recover_only_durably_committed_generations` | PASS |
| Snapshot plus later-operation replay | `recovery::restart_recovers_latest_snapshot_and_replays_later_deltas` plus corruption/missing-delta rejection tests | PASS |
| Concurrent immutable readers during publication | `concurrent_readers::eight_readers_never_observe_a_torn_generation` | PASS |
| Stale fencing token and pre-restart epoch rejection | six `fencing` tests, including token supersession and restart invalidation | PASS |
| Persistence latency separated from memory publication | three 100-publication JSON records above; nearest-rank distribution unit test | PASS |

## Crash-boundary outcomes

The child-process failure-injection test killed publication at all four boundaries, reopened the database independently, replayed durable state, and compared the recovered digest with the expected complete generation.

| Failpoint | Durable recovery outcome | Result |
|---|---|---|
| `beforeRedbTransaction` | complete old generation | PASS |
| `insideRedbTransaction` | complete old generation; open write transaction rolled back | PASS |
| `afterRedbCommitBeforeMemoryPublish` | complete new generation recovered from redb | PASS |
| `afterMemoryPublish` | complete new generation | PASS |

No boundary produced partial graph, operation, event, ticket, or fencing state.

## Approved deterministic acceptance matrix

This table preserves all twelve items from the approved design. Only the bounded redb properties belong to this spike.

| # | Approved acceptance item | Test/evidence | Result |
|---:|---|---|---|
| 1 | Two disjoint renames remain independently runnable and both commit | Coordination scheduler and typed rename analyzer | not part of redb spike — gated by approved follow-on plan |
| 2 | Two same-symbol renames are ordered; the second receives fresh state and `IntentNeedsDecision` | Coordination scheduler, event protocol, typed rename analyzer | not part of redb spike — gated by approved follow-on plan |
| 3 | Rename and reference-touching operation are inferred as overlapping | Typed intent scope inference | not part of redb spike — gated by approved follow-on plan |
| 4 | `add_parameter` discovers a callsite added while waiting and requeues before mutation | Scheduler, TypeScript bridge, dynamic-scope analyzer | not part of redb spike — gated by approved follow-on plan |
| 5 | Older wide rename cannot be starved by newer small edits | FIFO aging and all-or-ticket scheduler | not part of redb spike — gated by approved follow-on plan |
| 6 | Stale fencing tokens and old service epochs cannot publish | `tests/fencing.rs` | PASS |
| 7 | Queued tickets and unacknowledged events survive restart | Durable scheduler lifecycle and event cursors | not part of redb spike — gated by approved follow-on plan |
| 8 | Failure injection yields a complete old or new generation, never partial state | `tests/crash_recovery.rs`; `tests/storage_atomic.rs` | PASS |
| 9 | Snapshot-plus-operation replay produces equivalent graph/index state and digest | `tests/recovery.rs`; `tests/examples_medium_fixture.rs` | PASS |
| 10 | Two changes valid only together commit as one change set | Composite scheduler + validation bridge | not part of redb spike — gated by approved follow-on plan |
| 11 | Duplicate event delivery is harmless through event IDs and acknowledged cursors | Durable event subscription/cursor protocol | not part of redb spike — gated by approved follow-on plan |
| 12 | No client or Node worker can mutate canonical storage outside the kernel | Multi-client service authority and worker bridge | not part of redb spike — gated by approved follow-on plan |

## Decision

**PASS.** Redb remains the selected durability engine for the Phase-6 research direction. The result unblocks writing and executing a separate coordination-scheduler plan. It does not check any later roadmap item, authorize live model spend, or replace the supported SQLite product path.
