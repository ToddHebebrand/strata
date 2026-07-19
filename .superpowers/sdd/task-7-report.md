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
