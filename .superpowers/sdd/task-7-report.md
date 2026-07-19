# Task 7 report — crash injection reaching the advance publication, full atomic-state oracle

## Status: COMPLETE — all 10 crash-suite tests green, Rust feature matrix green.

## What shipped

- Rust: `serve` gains `--test-publish-failpoint <camelCase boundary>` (gated
  `#[cfg(feature = "redb-spike-api")]`), mirroring the existing
  `--test-failpoint` block. Threaded through `ServiceConfig.publish_failpoint`
  (cfg-gated field) into `ServiceSession`, and consumed in the advance path so
  publication routes through `execute_claimed_with_failpoint(claim, tick, fp)`
  when armed, else the byte-identical `execute_claimed(claim, tick)`.
- TS: `packages/live-compare/tests/gate1Crash.test.ts` — 9 crash cases (5 journal
  stages at the advance + 4 publication boundaries) plus one negative test, with
  the full graph + atomic-state + idempotent-replay oracle.
- TS: added an additive optional `clientId` to `runKernelArmT03` (ownership: the
  advance/replay must run from the change-set's creating actor).

## Threading mechanism

`main.rs::serve` builds the allowed-arg list as a `Vec` and `push`es
`--test-failpoint` under `coordination-test-api` and `--test-publish-failpoint`
under `redb-spike-api`. Because `redb-spike-api = ["coordination-test-api"]`, the
crash binary (built `--features "coordination-test-api redb-spike-api"`) accepts
BOTH flags; a `coordination-test-api`-only build accepts only the journal flag;
a default build rejects both (`reject_unknown` fails closed → "unknown option").

The publish failpoint is parsed via `PublishFailpoint::from_boundary_name` and
stored on `ServiceConfig` / `ServiceSession` behind `#[cfg(feature = "redb-spike-api")]`.
In `advance()`, publication is the sole durable-graph mutation; when the stored
failpoint is `!= None` it calls `execute_claimed_with_failpoint`, otherwise
`execute_claimed`. When the feature is absent the field/branch do not exist and
the call is unconditionally `execute_claimed` — **zero behavior change when unset**.
Verified: default build rejects the flag (negative test + sealing test), and the
help text keeps the test-authority surface sealed under every feature build.

## Per-boundary OLD/NEW determination (asserted per case, not just XOR)

Graph "OLD" = gen 0 (== prep-only reference); "NEW" = gen 1 with the rename
(== completed reference). The offline `export-snapshot` reopen reads only the
durable graph tables (no journal reconciliation), so it observes exactly what the
crash committed.

Journal stages (`--test-failpoint`, trip on the advance request — the only
mutation issued to the failpointed daemon):

| stage           | trips at (session.rs)                                                 | side |
|-----------------|-----------------------------------------------------------------------|------|
| after_pending   | after `append_pending`, BEFORE `execute_pending` runs the publication | OLD  |
| after_effect    | after `execute_pending` (advance published durably)                   | NEW  |
| after_prepared  | after the effect-result journal write                                 | NEW  |
| after_follow_up | after `apply_follow_up` (a no-op for a clean publish)                  | NEW  |
| after_completed | after the completed journal write                                     | NEW  |

Publication boundaries (`--test-publish-failpoint`) — matches
`PublishFailpoint::expects_committed_state()`:

| boundary                            | aborts (storage.rs / publication.rs)          | side |
|-------------------------------------|-----------------------------------------------|------|
| beforeRedbTransaction               | before `begin_write()`                         | OLD  |
| insideRedbTransaction               | inside the write txn, before `commit()`        | OLD  |
| afterRedbCommitBeforeMemoryPublish  | after `write.commit()`, before memory publish  | NEW  |
| afterMemoryPublish                  | after the in-memory publish                    | NEW  |

Why the projection oracle still holds for the OLD publish cases even though the
crash happened after `claim_ready` (an Executing change set with an active claim):
recovery (`begin_service_epoch_and_recover_coordination_inner`) transitions BOTH
a `Ready` change set (prep-only) AND an `Executing` change set (claimed-but-
uncommitted crash) to `Queued`, dropping the offer/claim. So the prep-only
reference and every OLD crash converge to the same recovered coordination state.

Idempotent replay: after the offline oracle, a clean restart runs
`resolve_pending_before_bind`, which re-executes the pending advance. For OLD it
publishes (no failpoint) → the replay returns the cached committed response and
the final graph equals the completed reference byte-for-byte. For NEW the
publication's idempotency key is already durable → re-execution hits
`AlreadyPublished` and returns the SAME `operationId` the store already holds
(asserted against `projection.operations[0].operationId`). No double-commit.

## normalizeProjection — stripped vs mapped (all in one place, `gate1Crash.test.ts`)

Stripped (legitimately vary with the number of open/recovery cycles; the OLD
boundaries drive one extra recovery, the publish boundaries an extra
claim/reconsider, relative to the prep-only reference):

- `serviceEpoch` — monotonic per-open counter.
- `schedulerRevisions` (inMemory/durable) — bumped every recovery/reconsider.
- `recoveryMetadata` — its sequence/revision counters churn with those cycles.
- `coordinationCounts.events` / `eventIds` / `eventCursors` — each recovery emits
  a service-epoch transition event, so the event COUNT tracks recovery cycles.

Mapped to ordinal placeholders (random per run; deterministic here because N=1
and history is generation-ordered), mirroring `normalize_crash_state` in
`tests/full_key_free_acceptance.rs` (exact-string revalue + rekey + embedded-JSON
recursion): change-set id, `submissionIdempotencyKey`, intent ids, ticket id,
operation id(s), graph-event id(s), ready-offer id + claim token, active-claim /
offer / attempt ids, `publicationAttempts` keys, and the per-change-set
idempotency commit key.

Everything else compares byte-for-byte after mapping: graph, graphDigest,
graphCounts, operations (full canonical history + actor + reasoning + affected +
renames + intents), deltas, generationDigests, graphEvents, changeSets (incl.
state and ticks), intents, idempotencyGenerations, tickets, graphTickets,
publicationAttempts, fenceStates, live/durable resource clocks, and the stable
coordinationCounts. Empirically, once a single fixed actor is used for both the
references and the crash preps, the ONLY residual differences were `actor`
(fixed by construction) and `submissionIdempotencyKey` (mapped) — confirming the
strip list is minimal and the comparison is strong.

## Wall time

Full 10-test crash suite: ~42–45 s (each case runs ~4 daemon lifecycles; publish
boundaries ~5–6 s because they build+validate a real tsc candidate before the
abort). The redb-spike-api crash binary is built once to `target/gate1-crash`
(~11 s, cached thereafter). gate1 filter (parity + crash together): ~50 s. This
is far under the ~15-minute budget, so the suite runs **unconditionally inside
the `gate1` vitest filter** — no `STRATA_GATE1_CRASH` env gate. `kernel:gate1:test`
already runs `pnpm --filter live-compare test gate1`, which the `gate1Crash`
filename matches; no package.json change was needed.

## Verification run

- `cargo test -p strata-kernel` / `--features coordination-test-api` /
  `--features redb-spike-api`: all green (fixed one sealing regression — the
  test-authority flags must stay OUT of `--help` under every build).
- `vitest run gate1`: 11/11 green (10 crash + 1 parity), rerun against the final
  working tree.
- Pre-existing, unrelated: `verify.test.ts` / `tasks.test.ts` (13 task-
  registration-digest failures) fail identically on clean main with my changes
  stashed — NOT introduced by this task.

## Concerns

- The crash binary builds to a separate target dir (`target/gate1-crash`), so the
  first `gate1` run in a fresh checkout pays a one-time ~11 s compile. The
  `kernel:gate1:test` script's own `cargo build --features redb-spike-api` (to
  `target/debug`) is now redundant for the crash arm (which self-builds) but is
  harmless; left untouched to minimize surface.
- Full `pnpm -r test` / `pnpm kernel:full-key-free:test` green is Task 9's gate;
  the pre-existing verify/tasks digest failures must be resolved there.

## Fix: coordination-event stream coverage

**Finding (Important, Task 7 review):** `normalizeProjection` stripped
`coordinationCounts.events` / `eventIds` / `eventCursors` wholesale AND the
atomic-state projection didn't expose coordination-event records at all, so
duplication or loss of a coordination event across a crash boundary would
escape the oracle. Graph-level events (`graphEvents`) were fully covered;
this gap was specific to the coordination event stream.

**Approach shipped: (a).** Coordination-event records are now compared at
the record level (order-sensitive, ID-mapped), with only the specific
recovery-emitted events stripped — not the whole stream.

### Rust: expose the records

`Kernel::test_atomic_state_projection` (`crates/strata-kernel/src/kernel.rs`)
only exposed `coordinationCounts` (raw table-size scalars) — no coordination
EventRecord-equivalent existed, unlike `graphEvents` (via `test_graph_event`,
already backed by `store.event(sequence)`). Added, mirroring that pattern
exactly:

- `Kernel::test_coordination_event(sequence)` (`coordination-test-api`-gated),
  a thin wrapper over the existing `CoordinationDurable::event(sequence)`
  accessor (already used internally, just never exposed through the test
  projection).
- In `test_atomic_state_projection`, `coordination_events` is collected via
  `(1..=recovery_metadata.current_event_sequence).filter_map(...)` (sequences
  are contiguous 1..=N per `append_event`, same pattern as `graph_events`'
  `1..=generation`) and added to the JSON as `"coordinationEvents"`.
- `row_8`'s `CrashAtomicState` (`tests/full_key_free_acceptance.rs`) embeds
  the shared projection verbatim and already fetches its own
  `rowEightCoordinationEvents` via `events_after` for claim-scoped
  normalization, so the new field is additive there — its own replacements
  map already covers the same event IDs. Ran the row-8 acceptance test after
  the change; still green (see Verification below).

### TS: compare records, strip only recovery-shaped events

`gate1Crash.test.ts` `normalizeProjection` / `buildReplacements`
(`packages/live-compare/tests/gate1Crash.test.ts`):

- `coordinationEvents` items get ID-mapped (`event.eventId` →
  `<coordination-event:N>`), exactly like `graphEvents`, `operations`, etc.
  Ordinals are assigned AFTER filtering (below), so they line up between the
  reference and crash captures.
- **Stripped kinds (central list, `STRIPPED_COORDINATION_EVENT_KINDS`):
  `leaseExpired`** — the kind `begin_service_epoch_and_recover_coordination_inner`
  (`crates/strata-kernel/src/coordination/durable.rs`) emits once per
  recoverable Ready/Executing change set it resets to Queued, carrying
  `{oldServiceEpoch, newServiceEpoch}`. `filterCoordinationEvents` asserts
  that payload shape on every event it drops, so a genuine (non-recovery)
  `leaseExpired` — the same kind is also used for real claim/offer TTL
  expiry, just never triggered by this suite's flow — would fail the test
  loudly instead of silently vanishing.
- **First empirical surprise, found by actually running the strengthened
  oracle (not anticipated from reading the Rust source alone):** stripping
  `leaseExpired` was not sufficient. Every real (node-bridge-backed) daemon
  open synchronously replans right after recovery
  (`Kernel::open_with_node_bridge` calls
  `plan_and_apply_readiness(0, TransitionCause::Restart, None)`), and for a
  change set recovery just requeued with nothing left blocking it, that
  replan immediately re-derives Ready and appends a companion `intentReady`
  event (empty payload, same `changeSetId`) directly after the `leaseExpired`
  event. 4 of the 10 crash cases failed on exactly this extra record before
  the companion rule was added. Since `append_event` (the generic path used
  for `intentReady`, `intentQueued`, etc.) always writes payload `"{}"`, a
  genuine and a recovery-companion `intentReady` are byte-identical in
  content — they can only be told apart positionally. `filterCoordinationEvents`
  now also drops the event immediately following a stripped `leaseExpired`
  ONLY when it exactly matches `{kind: "intentReady", changeSetId: <same>,
  payloadJson: "{}"}`; anything else is left in place (and would fail the
  compare loudly rather than being swallowed).
- **Second empirical surprise:** even after removing both noise records, the
  surviving genuine events still didn't compare equal — their `sequence`
  field (a store-wide durable counter) had shifted by however many recovery
  events preceded them, so e.g. the real `intentCommitted` read `sequence: 5`
  in a crash capture vs. `sequence: 3` in the reference, despite being the
  identical logical event. `sequence` is mechanical position, not business
  content (same class as the already-stripped
  `recoveryMetadata.currentEventSequence`), and the filtered array's
  preserved append order already carries the ordering information, so
  `filterCoordinationEvents` drops the `sequence` field from every surviving
  record.
- `coordinationCounts.events` / `eventIds` / `eventCursors` remain stripped
  (raw durable table-size scalars — they still mechanically track the
  recovery-cycle count even though the event content itself is now covered
  at the record level), with the comment updated to say why explicitly
  instead of leaving it as a bare list.

### Verification

```
PATH=/opt/homebrew/bin:$PATH cargo build -p strata-kernel --features redb-spike-api
# Finished, no warnings.

PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --features redb-spike-api \
  --test full_key_free_acceptance row_8_real_claimed_node_publication_crashes_complete_old_or_new \
  -- --exact --ignored
# test row_8_real_claimed_node_publication_crashes_complete_old_or_new ... ok
# test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 12 filtered out

PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel --features redb-spike-api
# test result: ok. 1 passed; 0 failed; 12 ignored  (full_key_free_acceptance)
# test result: ok. 5 passed                         (graph_generation)
# test result: ok. 15 passed                        (local_service)
# test result: ok. 5 passed                         (local_service_hardening)
# test result: ok. 9 passed                         (local_service_recovery)
# test result: ok. 2 passed                         (local_service_sealing)
# test result: ok. 4 passed                         (model_roundtrip)
# test result: ok. 2 passed, 9 ignored              (node_bridge, requires bridge build)
# test result: ok. 1 passed                         (node_bridge_failures)
# test result: ok. 8 passed                         (recovery)
# test result: ok. 4 passed                         (storage_atomic)
# all green, no regressions from the kernel.rs change

PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test gate1
# Test Files  2 passed (2)
#      Tests  11 passed (11)
#  (10 crash cases incl. the 4 that initially failed on the companion
#   intentReady before filterCoordinationEvents was fixed, + 1 parity test)
```

One earlier `cargo test -p strata-kernel --features redb-spike-api` run hit
6 failures in `local_service_recovery` ("unknown option --test-failpoint");
reproduced identically on a `git stash`ed clean checkout when run under the
same 2-minute wall-clock cap, and disappeared entirely once the command was
given headroom to finish (a pre-existing multi-test-binary build/spawn race
under a tight timeout, unrelated to this change — confirmed by rerunning
`local_service_recovery` alone, which was consistently green both before and
after the fix).

### Files touched

- `crates/strata-kernel/src/kernel.rs` — `test_coordination_event` accessor +
  `coordinationEvents` in `test_atomic_state_projection`.
- `packages/live-compare/tests/gate1Crash.test.ts` — record-level coordination
  event comparison, `STRIPPED_COORDINATION_EVENT_KINDS`,
  `filterCoordinationEvents` (kind + companion + sequence handling), updated
  doc comments.
