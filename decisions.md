# Decisions

A running log of build-time decisions for Strata. Append-only. Newest at the top.

Log an entry whenever:
- A choice diverges from `strata-design.md` (swapped library, changed schema, dropped/added scope, different tool shape).
- A spec-level question from § "Open design questions" gets resolved.
- A non-obvious trade-off is made that a future reader would otherwise have to re-derive.

## 2026-07-16 — Local coordination service uses a private write-ahead request journal and cancels failed validation

**Context:** The frozen Phase-6 local protocol makes every mutating request retryable by client ID plus idempotency key, including a disconnect after the service has accepted a request but before the response arrives. The kernel durably owns graph and coordination transitions, but it does not atomically store arbitrary transport responses, and `add_intent` has no caller-supplied intent ID. A crash between mutation and transport acknowledgement therefore could not be resolved exactly once from the kernel tables alone. The implementation audit also found that existing coordination failpoint types and methods remained reachable from a default library build, and the production bridge worker is an ignored build artifact absent from a clean checkout.

**What was tried first:** The service first attempted to use only normal `Kernel` APIs plus their existing durable idempotency. That covers begin and final graph publication, but not every frozen transport boundary: an interrupted `add_intent` could otherwise be appended twice, while an interrupted event acknowledgement or cancellation had no stored response to replay. Treating every unresolved request as uncommitted would duplicate effects; treating it as committed without checking durable state would manufacture success.

**Decided:** The Rust service owns a private, fsynced, hash-chained `Pending`/`Completed` request journal beside the redb database. It records a bounded pre-mutation intent projection (maximum 256 records), serializes mutations per change set, writes `Pending` before calling the normal kernel API, and writes `Completed` before replying. Startup validates the journal and reconciles every pending record before binding the Unix socket. `add_intent` recovery compares the bounded before/after durable intent projection and fails closed on ambiguity; the other operations replay their normal idempotent or state-aware kernel path. Two bounded read-only helpers were added for child and intent projection without exposing a redb handle or full snapshot.

Candidate-execution failure is represented on the frozen wire as `validation_failed`, written to the redacted hash-chained service audit, and immediately followed by normal durable `Kernel::cancel_change_set`; no new kernel failure transition or raw publication path was added. Default builds now hide coordination failpoints, direct durable coordination access, and bridge executable injection behind `coordination-test-api`, with independent compile-fail fixtures. Key-free service tests may build `@strata/kernel-bridge` when its ignored worker artifact is absent, after removing model credential variables from that build process.

**Why:** This is the narrowest mechanism that makes every frozen transport mutation crash-retryable while retaining the kernel as the only graph/coordination authority. Reconciliation happens before reachability, ambiguous state fails closed, test-only authority remains unavailable in production, and bridge validation failure cannot leave a claim exposed to the client.

**Design-doc impact:** No architectural change. The service still owns the single authoritative kernel/redb process, clients see only typed operations and bounded projections, and the operation log remains canonical graph history. The private request journal is transport recovery metadata rather than a second graph history. The existing SQLite path remains supported.

## 2026-07-15 — Two-operation bridge passes on the explicit source projection; complete-fixture candidate validation remains unproved

**Context:** The approved Rust–Node bridge design required real `rename_symbol` and `add_parameter` analysis, candidate construction, TypeScript validation, Rust containment/publication, and recovery on `examples/medium`. The committed ingest fixture contains 1,282 nodes and 614 references across source, tests, and tool configuration. The existing validation profile also requires every rendered module to remain under its trusted `sourceRoot`.

**What was tried first:** The real-worker acceptance first retained the existing ingest-derived `src/**` modules. Independent review then required the preferred complete-snapshot experiment. All 25 module paths were localized below the trusted corpus and `sourceRoot` was widened to the corpus root without weakening path checks or containment. The existing tsc-only candidate gate reached validation and returned `Validate/typescriptFailed`.

**Decided:** The two-operation bridge is a bounded PASS on the exact ingest-derived `src/**` source projection: 1,203 nodes and 592 references across 22 modules. The untouched 1,282-node/614-reference snapshot remains the input for semantic-scope and disjointness checks, but real candidate publication does not claim full-fixture validation. The projection excludes 79 nodes, 22 references, and four pinned cross-boundary `formatTimestamp` reference sources. This boundary is fixed in deterministic tests and the spike evidence; it is not permission to relax trusted-root validation or omit arbitrary dependencies.

**Why:** The source projection is the existing product compiler scope and is sufficient to prove the Rust/Node authority split and both real structural operations. Treating the failed complete-fixture experiment as a pass would overstate the evidence; treating unrelated test/tool modules as required candidate publication content would fold an existing corpus-validation limitation into the coordination protocol.

**Unaffected boundaries:** Rust still owns scope versions, reservations, policy, digest, containment, fencing, canonical redb publication, and recovery. Node still owns TypeScript semantics and validation but has no canonical-write authority. G+1 remains exactly +9 nodes/+2 references with zero churn among G0 records. The existing SQLite path remains supported.

**Design-doc impact:** None. `strata-design.md` already separates transient validation artifacts from canonical graph authority. The approved bridge design's full-fixture reading is narrowed by this evidence entry; the later full key-free acceptance gate and live comparison remain unapproved.

## 2026-07-15 — Coordination kernel bounded PASS restored after authority and concurrency correction

**Context:** The 2026-07-14 withdrawal correctly rejected the initial scheduler result because default callers could mint semantic authority, two already-claimed disjoint changes could not both publish, candidate construction held global locks, release paths could create stale Ready authority, and leases could strand authority. The approved correction replaced those mechanisms with a sealed provider boundary, durable dependency clocks, centralized fresh readiness planning, deterministic leases, and unlocked optimistic publication.

**Evidence:** The integrated correction from base `8422f4e` through implementation commit `f02b909` passes the eight real-corpus correction scenarios over the committed `examples/medium` snapshot (1,282 nodes, 614 references): default authority sealing; two claims captured before either publication; affected dependency invalidation; disjoint lifecycle progress during a blocked builder; fresh analysis on every release path; restart/expiry fencing; same-attempt replay and mismatch rejection; and complete-old-or-complete-new reopen at the enumerated publication failpoints. At final pre-documentation head `f8d0d99`, formatting and strict default/`redb-spike-api` Clippy passed, the default Rust suite passed 33/33, the feature suite passed 171/171, focused recovery passed 23/23, ingest passed 8/8, and all 8 buildable pnpm projects built. The exact recursive test command reproduced only the authorized `@strata/verify` TS2454 baseline (69/70) before pnpm stopped. A supplemental non-bailing run also exposed two pre-existing stale agent replay-fixture failures; therefore the workspace is not represented as green. Full evidence is in `docs/spikes/2026-07-14-coordination-scheduler-correction.md`.

**Reviews:** The fresh integrated reviewer approved with no findings after provider-failure isolation and validate-before-migrate recovery were corrected. A separate read-only, repo-grounded GPT-5.6-sol review at reasoning `xhigh` returned **APPROVE BOUNDED PASS** after the actual `8422f4e` physical-schema compatibility regression was added and the evidence wording was narrowed. Pivotal review claims were checked against the implementation and exact tests.

**Decided:** Restore `PASS` only for the **Coordination kernel** roadmap item: a deterministic, feature-gated Rust/redb research proof that kernel-owned test semantics, graph-derived resource clocks, centralized readiness, deterministic leases, optimistic disjoint publication, fencing, recovery validation, and atomic publication work at the tested boundaries. Default builds still cannot execute semantic coordination because the production TypeScript semantic provider does not exist, although the common read-only recovery-integrity validator runs in default builds.

**Compatibility correction:** Compatibility is proved by reproducing the physical ten-table/two-metadata-key schema at commit `8422f4e`; no archived database artifact exists. Complete absence of the recovery-validation version and both subordinate markers is treated as legacy and migrated atomically with schema creation and authority recovery. That rule necessarily cannot distinguish a genuine legacy database from deliberate deletion of the complete marker triplet. Retained/versioned databases fail closed on missing tables, markers, metadata, event-ID mappings, clocks, or attempt linkages and are not self-healed before validation.

**Boundaries:** The unlocked-work claim applies only to claimed coordination publication. Attempt binding is cross-record consistency among attempt, change set, operation, graph event, generation, delta, and digest—not cryptographic provenance. Crash evidence covers the explicit enumerated pre-commit/in-transaction failpoints and redb transaction rollback, not instruction-level fault injection inside redb. Production TypeScript semantics and candidate generation, the Node worker bridge, transport/authentication, process isolation, task orchestration, multi-host consensus, the two-operation proof, full key-free acceptance, and live model comparison remain unimplemented and blocked. The existing SQLite product path remains supported.

**Design-doc impact:** None. The correction restores the authority, progress, and durability boundaries already required by the approved Phase-6 design; it does not change `strata-design.md` or authorize the next roadmap gates.

## 2026-07-14 — Coordination scheduler PASS withdrawn; authority and concurrency correction required

**Context:** Task-scoped reviews approved the scheduler incrementally, but the required final whole-branch review found four integrated failures: default callers could inject the analyzer that minted semantic scope authority; simultaneous disjoint claims were invalidated by an unrelated global-generation advance; candidate construction held the global scheduler/publication locks; and several release paths created Ready authority without fresh trusted analysis. Drafts and claims also lacked a complete deterministic expiry model.

**Falsified evidence:** The prior acceptance test claimed and published disjoint work sequentially in either order. It did not claim both before either publication, so it missed the global-generation failure. Raw-publication compile sealing did not test malicious analyzer injection. Publication-time successor analysis did not cover submission, reconsideration, expiry, cancellation, or claim-time terminal release. Passing durability and containment tests therefore did not establish independent multi-agent progress or kernel-owned semantic authority.

**Independent review:** A read-only, repo-grounded GPT-5.6-sol architecture review compared global serialization, optimistic resource validation, and structural replay/merge. It recommended kernel-owned semantics plus an unlocked prepare/build/revalidate protocol and monotonic resource/index clocks. The recommendation's premises were verified against the exported analyzer traits, exact claim-generation check, builder lock scope, wake paths, and acceptance tests.

**Decided:** The scheduler PASS below is superseded and the TypeScript validation bridge is blocked again. The **Coordination kernel** roadmap item returns to unchecked. The correction will: remove analyzer arguments from client-callable APIs; make default semantic execution unavailable until a kernel-owned TypeScript provider exists; expose deterministic provider injection only behind a research feature; run candidate construction outside global locks; validate dependency clocks rather than global generation; centralize every Ready transition behind fresh analysis; and add deterministic draft/claim expiry.

**Why:** These properties are the coordination hypothesis itself. Preserving a PASS by calling them future service concerns would leave clients able to mint authority and would serialize or strand the exact disjoint work Strata is intended to enable.

**Design:** `docs/superpowers/specs/2026-07-14-coordination-authority-concurrency-correction-design.md`.

**Unaffected findings:** The bounded redb durability/replay/fencing spike remains a PASS. The existing SQLite product path and single-agent bulk-propagation results are unchanged. The scheduler's existing FIFO, recovery, event, and atomic-commit tests remain useful regression evidence but are insufficient for a PASS until the correction gate succeeds.

**Design-doc impact:** This corrects the implementation boundary to match the approved coordination design: the kernel owns semantic analyzers, validation does not hold the commit sequencer, and disjoint work remains runnable. `strata-design.md` needs no architectural change.

## 2026-07-14 — Coordination scheduler passes; TypeScript validation bridge unblocked

**Context:** The approved Phase-6 scheduler plan required a deterministic, key-free proof of typed intent records, graph-inferred semantic scopes, all-or-ticket scheduling, durable tickets/events, FIFO fairness, fresh-state wakeups, fencing, restart recovery, delta containment, and atomic claimed publication before production TypeScript analyzers or a Node validation bridge could begin.

**Evidence:** At implementation commit `1410eaa44db618a29a2398cd08c6503c3281d4fa`, formatting and strict default/`redb-spike-api` Clippy passed. The default kernel suite passed 59 tests and the feature suite passed 109. The deterministic acceptance harness uses the committed ingest-derived `examples/medium` graph (1,282 nodes, 614 references), derives scopes from typed `RenameSymbol`/`AddParameter` parameters plus graph records rather than intent IDs or client keys, and passed disjoint progress, same-symbol fresh decision, inferred reference overlap, dynamic expansion/requeue, FIFO aging, restart/event cursor, malicious-delta containment, and composite atomic-publication cases. Default compile-fail coverage proves raw Rust publication authority is sealed; feature tests preserve the bounded redb crash/replay/fencing proof. Full evidence is in `docs/spikes/2026-07-14-coordination-scheduler.md`.

**Baseline exception:** `pnpm -r build`, ingest build, and all 8 ingest tests passed. `pnpm -r test` reproduced exactly the authorized pre-scheduler `@strata/verify` failure at `extractFunctionCommit.test.ts:228`: the extractor accepts an unsafe `let args` span, then the commit gate rejects diagnostic TS2454 (`args` used before assignment). Store passed 177/177, render 13/13, ingest 8/8, and verify passed 69/70 before the recursive run stopped. The scheduler work did not modify that path, so the known analyzer-test mismatch is recorded and is not classified as a scheduler failure.

**Decided:** The bounded coordination scheduler is `PASS`. Only the roadmap's **Coordination kernel** item is complete. This unlocks a separate TypeScript validation-bridge plan; it does not complete the **Two-operation proof**, full **Key-free acceptance**, multi-client service authority boundary, or **Live falsifiable comparison**, and it does not authorize model spend. The existing SQLite product path remains supported.

**Scope/version clarification:** Node-resource versions in the deterministic analyzer are SHA-256 hashes of `(NodeRecord, appeared_at_generation)`: ordinary fixture nodes use appearance generation 0, while the deliberately scripted newly appearing callsite source node uses its actual appearance generation. Reference-resource versions hash the complete `ReferenceRecord` without a generation component. Global graph generation remains separate claim and publication authority. Hashing that global generation into every existing-resource version would make unrelated publications change every scope, incorrectly classify disjoint work as material drift, and falsify disjoint progress. This resolves ambiguous plan wording without changing the production schema.

**Boundaries:** Rows 1–5 are scheduler-level proofs using an intent-and-graph-derived test analyzer, not production TypeScript rename/add-parameter semantics. Real analyzers, candidate generation, bounded rendering, tsc/vitest validation, result binding, worker-crash behavior, transport/authentication, process isolation, and live agent comparison remain unimplemented. Redb crash claims remain bounded to the explicit tested boundaries; engine-internal commit instructions are not fault-injected.

**Design-doc impact:** None. This advances the approved Phase-6 sequence without changing its architecture or acceptance boundaries.

**Revisit when:** The TypeScript validation bridge either proves real `rename_symbol`/`add_parameter` analysis and grouped validation or falsifies an assumption that the scheduler-level harness could not exercise.

## 2026-07-14 — Claimed publication takes the host logical tick for atomic successor offers

**Context:** The Task-7 plan showed `Kernel::publish_claimed` without the logical tick used by submit, claim, and cancel. Claimed publication releases the active scope and must create newly eligible successor offers in the same atomic graph-and-coordination transaction.

**Decided:** `Kernel::publish_claimed` accepts a host-supplied `now_tick: u64` and derives every successor offer expiry as `now_tick + READY_OFFER_TTL_TICKS`.

**Why / what was tried first:** Reusing the completed claim's original offer expiry would create successor offers that are already stale or have less than the promised 30-tick lease. Deferring reconsideration until after publication would violate atomic wakeup by committing the release without its newly eligible offers.

**Design-doc impact:** None. The design requires time-limited ready offers and atomic release/notification but does not specify the Rust method signature.

## 2026-07-14 — Coordination tickets represent `NeedsDecision` explicitly

**Context:** Task 5 initially terminalized a scheduler ticket as `Failed` when claim-time reanalysis required agent judgment, because Task 1's fixed `TicketState` list omitted a `NeedsDecision` variant even though `ChangeSetState` and lifecycle events distinguish that outcome.

**Decided:** Add the schema-v1 camel-case `TicketState::NeedsDecision` terminal state and use it for both dynamic-expansion-limit and material-scope-change outcomes. `Failed` remains reserved for actual execution or coordination failure.

**Why / what was tried first:** Encoding these outcomes as `Failed` kept them out of the active scheduler but collapsed a deliberate governance handoff into an error. The explicit terminal state preserves durable lifecycle meaning while still releasing the scheduler hold.

**Design-doc impact:** None. `strata-design.md` does not enumerate ticket wire states; this corrects the coordination plan/model omission.

## 2026-07-14 — Redb kernel spike passes; coordination scheduler unblocked

**Context:** The 2026-07-13 coordination-kernel decision made redb conditional on a bounded stop/go proof over `examples/medium`. The required properties were atomic publication of graph delta + operation + event + ticket + fencing state, complete-old-or-new recovery at tested publication boundaries, snapshot-plus-operation replay with per-generation digest verification, immutable concurrent readers, stale-token/service-epoch rejection, and separate persistence versus in-memory publication timings.

**Evidence:** All 35 `strata-kernel` tests pass with formatting clean and clippy warnings denied. Child-process failure injection recovered a complete old durable tuple immediately before the redb write transaction and inside it before commit, and a complete new durable tuple immediately after commit/before memory swap and after memory swap. No tested adjacent boundary produced partial graph-delta, operation, event, ticket, idempotency, or fence-consumption state. Snapshot replay validates every intermediate generation digest and rejects deliberately malformed/missing inputs. Eight synchronized immutable readers, fencing-token supersession, one-use claims, and restart epoch invalidation all pass. A real-corpus seed contained 1,282 nodes and 614 references. Three consecutive 100-publication measurements performed real writes and advanced generations 0 → 100 → 200 → 300 while retaining those counts and producing distinct verified digests. Full evidence and unedited JSON are in `docs/spikes/2026-07-13-redb-kernel-spike.md`.

**Crash-test boundary:** The failure-injection test does not terminate the process during redb's internal commit implementation. It tests the four explicit adjacent boundaries listed above and relies on redb's transaction atomicity within the engine-controlled commit operation. The PASS must not be read as instruction-by-instruction crash injection inside redb itself.

**Baseline exception:** `pnpm -r build` passes. `pnpm -r test` reproduces the authorized pre-spike `@strata/verify` failure at `extractFunctionCommit.test.ts:228`: the extractor accepts an unsafe `let args` span, then the commit gate correctly refuses diagnostic 2454 (`args` used before assignment). Before the recursive run stopped, store passed 177/177, render 13/13, ingest 8/8, and verify passed 69/70. This existing analyzer-test mismatch is unrelated to redb durability/recovery/fencing, was not modified in this spike, and is recorded rather than silently represented as an all-green pnpm gate.

**Decided:** The redb spike is `PASS`. Redb remains the intended durable engine for the Rust memory-native kernel, and a separate coordination-scheduler plan is now unblocked. Only the roadmap's Redb spike gate is complete. Typed intent analyzers, semantic scope inference, all-or-ticket scheduling, durable queued-ticket/event-cursor behavior, the Node validation bridge, a multi-client service, and live agent comparison remain unimplemented and must retain their own deterministic gates.

**Why:** Every bounded property included in this spike passed. The measurements are characterization only—three unoptimized development-build runs, no performance threshold, no SQLite comparison—and therefore do not support a production throughput claim. The pass is a durability/correctness decision at the tested boundaries, not a declaration that the multi-agent thesis has been proven or that redb internals were exhaustively fault-injected.

**What was tried first:** The initial Task-8 evidence attempt stopped because `measure` exposed only total/average latency and reused iteration-based idempotency keys across invocations. The interface was returned to Task 7, extended with seed/recovery/count/file-size and separate percentile evidence, then fixed to derive identities from the durable next generation. Regression tests now prove consecutive runs advance and report nonzero real-write distributions. Independent review approved the corrected interface before measurements were recorded.

**Design-doc impact:** None. This resolves the explicit redb spike gate in the approved design without changing its architecture or follow-on boundaries. The SQLite product path remains supported.

**Revisit when:** The coordination scheduler plan is reviewed; if later deterministic tests expose a durability property not exercised here—including a need for lower-level crash injection inside the engine commit—reopen the engine decision with the exact failing boundary rather than treating this spike as blanket production validation.

## 2026-07-14 — Redb spike plan review: durable-table divergence, composite publication in v1, and five gates that could not fail

**Context:** The redb kernel spike plan (`docs/superpowers/plans/2026-07-13-redb-kernel-spike.md`) was reviewed before execution, per the repo rule that a different-class lever gets an independent review with pivotal claims verified against real code rather than accepted on faith. Four parallel reviews ran: TypeScript-bridge verification against `packages/ingest`, dependency/toolchain verification, spec-vs-plan consistency, and an adversarial systems review. The review found no problem with the plan's sequencing or TDD discipline, and empirically **refuted** the two failure modes that looked most likely on inspection (see "Verified, not changed" below). The real defects were concentrated in the gates themselves.

**The core finding — five gates could pass while the property they name is false.** For a stop-gate spike whose PASS writes a `decisions.md` entry and unblocks the coordination scheduler, a vacuous gate is worse than a missing one: it manufactures evidence.

1. **Durability level was never pinned.** `std::process::abort()` leaves the OS page cache intact, so bytes written but never `fsync`-ed are still visible to the next process that opens the file. Under `Durability::None` — a natural reach, since Task 8 measures `persistence p50/p95` over 100 iterations and rewards a small number — all four crash tests still pass while real power loss drops the last N commits.
2. **The recovery digest was never persisted.** `Kernel::open` "verifying the digest" recomputed it through the same `apply` path it was meant to check, and Task 7 compared `inspect`'s digest against an independent `Kernel::open` that replays the same deltas through the same code. Both agree by construction even when both are wrong. A bug dropping `DeleteReference` on replay would have passed acceptance item 9.
3. **Two of four crash tests could not detect their own failpoint.** `afterRedbCommitBeforeMemoryPublish` and `afterMemoryPublish` both expect generation 1 — which is also what a clean, non-crashing publish produces. Step 1 additionally described three failpoints as "exits non-zero" while Step 3 said all call `abort()`; `exit(1)` runs destructors and cleanly drops the redb `Database`, which is a graceful shutdown, not a crash.
4. **The concurrent-reader assertion was vacuous.** `digest` is a field of `GraphGeneration` computed at construction, so `(generation, digest)` are two fields of one immutable allocation and agree by construction — the test would pass under an outright data race. Nothing forced readers to overlap the publish window either.
5. **The digest test was trivially true.** `snapshot()` includes `generation`, so `assert_ne!(old.digest(), next.digest())` is satisfied by the generation delta alone. A digest hashing nothing but the generation number passed every test in the plan.

**Decided (plan amendments, pre-implementation):**

1. **Durable tables diverge from the approved spec, deliberately.** The spec (§ Redb durability) enumerates twelve tables; the spike implements ten. Dropped: `nodes`, `references_from`, `references_to` (folded into whole-`GraphSnapshot` blobs in `snapshots` — durable per-node records do not exist in the spike), and `change_sets`/`intents` (scheduler-owned; not built here). `lease_epochs` is split into a `SERVICE_EPOCH` key in `graph_metadata` plus `fence_tokens`. Added, unmentioned by the spec: `deltas` (the spec folds deltas into `operations`), `fence_tokens`, `consumed_fence_tokens`, and `generation_digests` (see item 4). **Consequence to track:** `OperationRecord.change_set_id` is a foreign key into a table nothing persists until the scheduler lands, and `Publication.change_set_id` has no table of its own — the per-operation field carries it. Accepted for a durability gate; the spike must not claim ticket/intent lifecycle coverage.
2. **`Publication` becomes composite in v1.** `operations: Vec<OperationRecord>`, `tickets: Vec<TicketRecord>`, `events: Vec<EventRecord>`, plus a top-level `change_set_id`. The spike always publishes vectors of length one and builds no scheduler logic, but `schemaVersion: 1` now certifies a shape matching spec line 164 ("writes the operation records… change-set/ticket transitions… event records", all plural) and acceptance item 10. **Considered and rejected:** keeping the singular shape and documenting v1 as single-operation. Rejected because the scheduler's first deliverable is composite change sets, so its first act would have been a breaking migration of the format this spike had just certified — paying a v2 migration to save a `Vec` that costs nothing before implementation.
3. **`Durability::Immediate` is pinned and asserted**, and the spike report must state plainly that fsync ordering and torn-write recovery are **inherited from redb on trust, not verified** — `abort()` cannot distinguish fsync'd from buffered writes. **Considered and rejected:** implementing redb's `StorageBackend` trait as a fault-injecting shim (~80 lines) that buffers writes since the last `sync_data` and discards them on simulated crash, which would make the four ordering tests genuine durability tests. Rejected as scope expansion beyond the gate; revisit if a durability incident ever traces to fsync ordering. The spec's rejection of a custom WAL (§ Alternatives) rests on redb owning these properties, so the spike inherits rather than re-proves them — but it now says so out loud instead of implying coverage.
4. **The digest is persisted at publish time** and recovery compares the replayed digest against the stored value. This is the one bug class the gate exists for: replay diverging from the original apply.
5. **Fencing now checks the service epoch inside the write transaction.** As written, `verify_fence_in_write_txn` specified only three checks (≥1 token, token equals its `FENCES` counter, token exceeds `CONSUMED_FENCES`) and never compared `claim.service_epoch`. Because `FENCES` counters do not reset on reopen, a pre-restart claim with a numerically current token passed all three and published — making `FenceClaim.service_epoch` a dead field, falsifying spec lines 205/215 ("startup increments the durable service epoch, invalidating every pre-crash fencing token immediately"), and contradicting the plan's own Task 5 test. The epoch is read from `SERVICE_EPOCH` **inside** the publish transaction; comparing against `Kernel`'s cached field is latently wrong once a service wrapper allows a second opener.
6. **Fencing is documented as safety-only.** `issue_fence` is an unconditional increment with no ownership, so two concurrent issuers can livelock, each invalidating the other's token. Liveness depends entirely on the unbuilt scheduler; the spike's actual mutual exclusion comes from `publish_lock`. The plan's claim that one-use fencing means "the same claim cannot authorize a different publication" was false and is corrected: a claim authorizes *any* publication, once. Binding a claim to its content (scope fingerprint, validation result) is spec lines 161-162 and is scheduler work.
7. **A read-only `Kernel::open_read_only` is defined.** The plan said "every *authoritative* `Kernel::open`" bumps the epoch, implying a non-authoritative path it never defined — while `redb-spike inspect` needed exactly that. Left unfixed, a read-only diagnostic would bump the epoch (invalidating every outstanding token, and requiring a write transaction, so it would fail precisely when the database is broken and you need it most).
8. **Kernel-level idempotency returns the original generation**, matching `DurableStore::publish`'s `AlreadyPublished { generation }`. The plan had `Kernel::publish` return the *current* generation for a duplicate — so a retry of a key that published at generation 5, after two later publishes, reported generation 7, and a client resolving "the operation my publish created" would fetch someone else's operation. This is the exact crash-retry path idempotency exists for.
9. **`PublicationReport` gains `apply_ns` and `critical_section_ns`.** The original two fields timed the redb call and a pointer swap while the dominant cost sat between them, unmeasured: `apply` clones the node map, rebuilds `references_to`, and SHA-256s a `serde_json` encoding of the whole corpus, all under `publish_lock`. Reporting only `persistence_ns` and `memory_publish_ns` would have produced excellent numbers describing the wrong span, and the design's "deliberately short commit sequencer" claim must be judged against the end-to-end critical section.
10. **`make-rename-publication` uses the reference closure, not a corpus-wide string match.** Selecting every Identifier whose payload text equals `User` would sweep in shadowed locals and unrelated same-named symbols while wearing the `RenameSymbol` label in the durable operation log. `GraphGeneration::references_to` already exists by Task 2, and the spec calls `rename_symbol` "wide reference-closure inference" — which is why it is one of the two proof operations.
11. **`write_snapshot` validates against the persisted digest** and rejects a generation ahead of `current_generation`. An unvalidated snapshot permanently poisons every future recovery with no later opportunity to notice.
12. **`publish_with_failpoint` stays off `DurableStore`.** A public failpoint publish on the store lets any in-process caller write canonical storage while bypassing kernel authority and in-memory publication — the exact failure mode of acceptance item 12. Both it and the test-only inspection helpers sit behind a non-default `spike-testing` feature rather than `#[cfg(test)]`, because integration tests under `tests/` link the lib compiled without `cfg(test)`.
13. **The spike report gains a mandatory third acceptance label**, `not proven by this spike — <reason>`. Four of the twelve acceptance rows (#7 queued tickets/unacknowledged events surviving restart, #10 composite change set, #11 duplicate event delivery, #12 no out-of-kernel mutation) are neither passes nor scheduler-gated, and with only two labels available #7 in particular would have been marked `pass` on the strength of the `TICKETS`/`EVENTS` tables existing and surviving a reopen — which is not that property.

**Why:** The spike's whole value is that a PASS is trustworthy enough to unblock the scheduler. Every amendment above either closes a path by which the spike reports a property it did not test, or aligns the durable v1 format with the design it is meant to certify. The scope of the spike is unchanged: no scheduler, no service, no validation bridge, no tool porting.

**Verified, not changed (recorded so they are not re-litigated):**
- **The one-outgoing-reference-per-node model is correct.** `references_from: BTreeMap<String, ReferenceRecord>` and `DeleteReference { from_node_id }` look unsound for a TypeScript graph, but `packages/store/src/schema.ts:44` already declares `from_node_id TEXT NOT NULL PRIMARY KEY`, `classifyReferenceKind` returns exactly one kind per symbol, and `from_node_id` is a per-occurrence identifier node ID. Empirically: 1282 nodes / 614 references on `examples/medium`, zero duplicates, max 1 outgoing — and still max 1 on an adversarial corpus exercising re-exports, aliased exports, shorthand properties, namespace access, and declaration merging. No late-rework risk in Task 6.
- **`redb 4.1.0` is real, current, and its MSRV genuinely is 1.89**; the 1.89.0 toolchain is already installed locally, and `edition = "2024"` (stable since 1.85) is valid. The only carried-over break is that redb 3.0 moved `begin_read()` onto the `ReadableDatabase` trait.
- **Cross-language sort ordering agrees.** JS `localeCompare`, JS default `.sort()`, and Rust `BTreeMap` byte order coincide only because node IDs are fixed-length lowercase hex (`sha1(...).slice(0,16)`). The plan now sorts by code unit to express that directly rather than relying on the coincidence.
- **Scope discipline and the stable-identity boundary were already clean.** The spike performs only Identifier payload rewrites — no insert, delete, or move — so it does not depend on position-derived identity, which spec line 223 gates separately.

**Design-doc impact:** none to `strata-design.md`. The approved kernel spec is unchanged; item 1 above records the spike's intentional narrowing of its table list, and item 2 brings the plan *into* alignment with spec line 164 rather than away from it.

**Revisit when:** (a) the scheduler lands and needs `change_sets`/`intents` tables plus a non-publication event append path — `DurableStore::publish` currently enforces one event sequence per generation, which will reject valid publications the moment `IntentQueued`/`IntentReady`/`LeaseExpired` (none of which change the generation) are emitted through it; (b) a durability incident traces to fsync ordering, justifying the `StorageBackend` fault shim rejected in item 3; (c) the service wrapper lands, at which point cached-epoch reads and the `pub` surface on `DurableStore` become real bypass risks for acceptance item 12; or (d) `issue_fence` livelock is observed under real contention, which the scheduler's all-or-nothing reservations are supposed to prevent.

## 2026-07-13 — Recover the original multi-agent thesis: Rust memory-native coordination kernel with redb durability

**Context:** Reviewing Strata through its original motivation exposed a gap between the opening thesis and the implemented product. `strata-design.md` begins from the claim that file granularity prevents agents from safely working in parallel, but the MVP explicitly deferred multi-client editing and every benchmark measured one agent at a time. The product subsequently converged on the narrower, valid bulk-propagation result. Persistence supports sequential sessions; it is not concurrent isolation. The current store also keeps transaction overlays in a process-local `Map`, applies some structural inserts/deletes to canonical SQLite rows before logical commit, and has no durable semantic reservations, tickets, fencing, or restartable undo state. Two agents must not share the current database directly.

**Considered:**
- Keep SQLite as canonical hot state and add WAL/busy-timeout/record-lock conventions. Rejected: those are storage controls, not Strata's semantic coordination model, and SQLite has no per-record lock primitive matching typed graph intent.
- Put an active TypeScript coordinator in front of the current SQLite store. Viable as a smaller prototype, but it preserves the SQL graph as the hot representation and does not address the desired memory-native substrate.
- Rust memory-native kernel with SQLite durability. Viable, but keeps a SQL mapping in the commit/recovery path without using its query layer as the hot path.
- Rust memory-native kernel with redb durability. Chosen: pure Rust, embedded ACID/MVCC/crash-safe storage, one short commit sequencer, and direct key/value tables for operation deltas, tickets, events, snapshots, and fencing.
- LMDB, RocksDB, or a custom WAL. LMDB is the viable C fallback; RocksDB is operationally excessive for this workload; a custom WAL assumes database-engine responsibilities before the coordination hypothesis is tested.

**Independent review:** A read-only, repo-grounded Codex CLI review (`gpt-5.5`, reasoning `xhigh`) agreed that the semantic concurrency layer belongs above the store, recommended a single active service for the first proof, and surfaced the need for double scope inference, all-or-ticket acquisition, FIFO aging, service-owned fencing, composite change sets, and a restartable durable intent layer. Pivotal claims were checked against the current transaction/schema/verify code before acceptance.

**Decided:**
1. Strata's next research iteration is a single active Rust coordination kernel. Independent agent clients never open canonical storage directly.
2. The hot node/reference graph, indexes, immutable generations, reservation table, queues, and event subscriptions live in memory.
3. Redb durably stores graph snapshots, the canonical operation/delta log, change sets, typed intents, tickets, events, service epochs, fencing counters, and idempotency keys.
4. Existing Node packages remain authoritative for TypeScript ingest, rendering/Prettier, compiler diagnostics, and behavioral tests. Validation workers cannot commit.
5. Agents submit typed semantic intents. Strata infers read/write/validation/reservation scopes; agents do not enumerate affected keys.
6. Agents draft without locks. Busy submissions receive durable tickets. When runnable, an agent receives relevant before/after state and a fresh generation, then decides whether to revise, cancel, or resubmit. Automatic continuation is limited to operations Strata can prove safe and idempotent.
7. Scope is inferred at submission and again before execution/publication. Expansion into unavailable resources requeues before side effects.
8. Hard fenced leases cover only publication. Redb is committed before the new in-memory generation is published; restart increments the service epoch and invalidates every stale fence.
9. The first proof supports `rename_symbol` and `add_parameter`, uses `examples/medium`, and is key-free/deterministic before any live model comparison.
10. The falsifiable product experiment compares two Strata clients with Git worktrees plus an integration agent, measuring time-to-one-shared-green-codebase and treating any lost update/dirty read/partial commit as dispositive failure.

**Why:** This is the paradigm the project was created to test. The operation log, structural tools, and graph make Strata capable of coordinating code at a finer unit than files, but only an active authority can turn that possibility into safe multi-agent behavior. A memory-native kernel makes semantic scopes, closures, queues, and immutable generations first-class rather than reconstructing them through SQL. Redb supplies durability without requiring Strata to build a database before it can test coordination.

**Design-doc impact:** Updated `strata-design.md` § Scope, Architecture, Tech stack, and Build phases to add the post-MVP coordination proof while preserving SQLite as the implemented Phase 0–5 substrate. Updated `docs/product-roadmap.md` with Iteration 5 and replaced the stale blanket multi-client exclusion. Approved spec: `docs/superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md`.

**Revisit when:** (a) the redb spike fails atomicity, crash recovery, snapshot replay, concurrent-reader, or fencing acceptance; choose another durable engine only after logging the falsified property; (b) deterministic coordination gates pass, triggering the live two-agent experiment; (c) structural insert/delete/move joins the concurrent surface, which first requires stable logical IDs independent of sibling position; or (d) one active service is measured as a real throughput bottleneck, justifying coordinator/worker sharding.

## 2026-07-03 — Exploration CLI shipped (Iteration 3 first sub-project): six read-only human commands over the store's query primitives

**What shipped:** `packages/cli/src/commands/explore/` per the approved spec (`docs/superpowers/specs/2026-05-31-strata-explore-cli-design.md`): `modules` (alias `ls`), `exports`, `find [--kind]`, `show`, `refs`, `search [-k]`, each accepting a corpus directory (ephemeral `:memory:` ingest via the shared tree-walk, skipping `node_modules`/`.git`/`dist`) or a persisted `.db`, each supporting `--json`. Dispatch + a grouped `strata help` separating exploration from research/harness commands. Zero new store logic — commands map 1:1 onto `listModules`/`list_module_exports`/`find_declarations`/`read_node`/`get_references`/`semantic_search`.

**Notable implementation choices within the spec:**
- Commands return a uniform `{code, stdout, stderr}` (`CommandResult`) and the dispatcher prints — so the 16 key-free tests in `packages/cli/tests/explore.test.ts` call `runExplore()` in-process (fast) plus one spawn test against the built dist for dispatch/help wiring.
- The persisted-db test proves the spec's ID-chain property end-to-end: `find` against the corpus directory and against an `ingest-batch` db yield identical node IDs (deterministic position-derived IDs; same absolute module paths).
- `refs` context lines skip leading line/block comments so a JSDoc'd statement shows its first *code* line, not `/**` (surfaced by driving the real output on `examples/medium`).
- `search` degrades along three explicit paths (vec unavailable / no embeddings in store / no `STRATA_EMBED_API_KEY`), all exit 1 with the same actionable hint, matching the spec's no-crash requirement.

**Design-doc impact:** none — read-only surface over existing primitives; files-not-first-class holds (the corpus-dir argument is an ingest source, exactly like `strata agent`'s; module paths appear as display metadata only).

**Revisit when:** packaging/global-binary work starts (the `strata()` shell-function workaround in the README goes away), or a user needs pagination/watch mode (explicit YAGNI in the spec).

## 2026-07-03 — System prompt now instructs single-transaction batching for multi-mutation tasks (compound-ceremony lever, prompt-level, unvalidated)

**Context:** The 2026-05-29 compound extract dogfood diagnosed the substrate's compound-task overhead as per-op **transaction + validate + commit ceremony** (3 ops → 3 commits, 16 tool calls, 208% of baseline cost). Reviewing `STRATA_SYSTEM_PROMPT` against that transcript: the "transaction model" section said "a transaction groups related structural changes" but never told the agent to batch several related mutations into ONE transaction, and "Verify before commit" mandated validate **after every mutation** — the prompt was effectively prescribing the measured ceremony.

**Decided:** Two general (non-task-specific, no-recipe) prompt edits in `packages/agent/src/prompt.ts`: (1) the transaction-model section now states the converse explicitly — several related changes go in a single transaction, validate the combined pending state, commit once; per-mutation transactions multiply overhead without adding safety and fragment one logical change across history entries. (2) "Verify before commit" now reads "after completing the mutations for a change" with per-mutation validate reserved for when an individual outcome genuinely determines the next step. Prompt stays within the 2000–5000-token test budget; all prompt assertions are pattern-based and unchanged.

**Why:** Attacks the measured overhead directly at the cheapest layer. This is NOT a re-opening of the falsified T01 prompt lever — that lever targeted tool *trust/legibility* (agent ignoring add_parameter's fan-out); this targets ceremony *count* on multi-step tasks, a different failure surface diagnosed from a different transcript.

**Honest status:** unvalidated. The falsifiable product question is "does single-transaction batching reduce compound-task cost?" — answerable by re-running the compound `dogfood:extract` form (operator, keyed). Prediction: fewer commits/validates and lower cost on compound tasks, but it does NOT change the class conclusion — single-site synthesis still lacks bulk leverage and is still not expected to beat file tools.

**Design-doc impact:** none — prompt iteration is within `strata-design.md` § System prompt ("drafted and iterated").

**Revisit when:** the keyed compound re-run lands (record the paired numbers here), or a transcript shows the agent over-batching unrelated changes into one transaction (the entry's guardrail: "one logical change" still bounds the batch).

## 2026-05-30 — inline_function v1 shipped: inline an expression-body function at every call site, all-or-nothing, shared removeChildStatement, hygienic AST substitution

**(a) v1 surface and accepted forms.** `inline_function(function_id)` — the **20th** structural agent tool. Pure `analyzeInline` lives in `@strata/store` (the caller passes rendered context via `buildAnalysisContext`, the same seam `move_declaration`/`extract_function` use); the apply path is `inlineFunction.ts`. It replaces every call site `f(args)` with the function's body (arguments substituted for parameters, parenthesized), deletes the declaration, and strips it from every importer. It is the inverse of `extract_function` and a sibling of `move_declaration`. Four accepted **expression-body** forms, all normalized to `{ params, bodyExpr }`: a `function f(...) { return <expr>; }` declaration; `const f = (...) => <expr>` (concise body); `const f = (...) => { return <expr>; }`; and `const f = function(...) { return <expr>; }`.

**(b) all-or-nothing semantics.** `analyzeInline` runs BEFORE any mutation; if ANY call site or the declaration is unsafe, it returns a rejection and `inline_function` throws, leaving the store untouched. There is no partial inline.

**(c) the pure-argument rule (covers duplication + reordering).** Inlining substitutes each argument's source text into the body, which can **duplicate** an argument (a param used N times in the body) or **reorder** evaluation. To keep behavior identical, v1 requires every argument at every call site to be **syntactically pure** (identifier / literal / member-access / operator chain over those). Any argument containing a call/new/await/yield/assignment/inc-dec/arrow/tagged-template is refused with a specific reason. Conservative by design: a false "impure" only refuses a call site with a clear message; a false "pure" must never happen.

**(d) self-contained body boundary.** The body may reference only its own parameters and globals/lib symbols. Any source-local or imported free variable is a rejection (mirrors `move_declaration`'s `findOutOfScopeDependency`, including `getAliasedSymbol` alias-following). v1 does **not** relax this to same-module symbols — a deliberate parallel to move's boundary (a v1 limitation; relaxing would require hoisting/qualifying the referenced symbols into every call-site module).

**(e) rejection list (each with a specific reason):** body that is not a single returned expression (multi-statement); body using `this`/`super`/`arguments`/`await`; recursion (the body references the function's own symbol); generics (type parameters); non-identifier params (destructuring/pattern), rest params, or default-valued params; ANY impure call argument; a call with the wrong arity or a spread argument; a call through a cast/parenthesized callee (`(f as any)(...)` — apply can't splice a wrapped callee); and any non-call reference to the function (used as a value/callback, re-exported `export { f } from`, default/namespace-imported, or accessed via a namespace import of the function's module).

**(f) bulk-propagation framing.** Inline rewrites EVERY call site, so when the function is genuinely inlinable it is in the substrate's documented **bulk-propagation cost-win class** (like rename/move/param-propagation), NOT the extract/new-code class. The keyed `dogfood:inline` validation is operator-triggered.

**(g) `removeChildStatement` extracted (shared top-level-statement deletion).** The "delete a top-level statement + its Identifier children + their edges, then re-index surviving siblings + `EndOfFileTrivia` DOWN by one (all captured for rollback)" block was lifted verbatim out of `move_declaration` into `packages/store/src/removeChildStatement.ts` (parallel to `appendChildStatement`, which only shifts UP on insert). `move_declaration`'s source-deletion is now a single call; behavior is byte-identical (verified by the move store tests + commit integration). `inline_function` reuses it for the declaration deletion and for sole-binding importer removal.

**(h) hygienic AST substitution + the importer-strip-vs-call-site ordering decision.** Substitution is by SYMBOL (an identifier in the body is replaced iff its symbol is a parameter), so member-property names (`o.v`) and shadowing are handled correctly; the whole replacement is parenthesized to preserve precedence. Apply follows the **two-coordinate discipline**: `analyzeInline` emits OFFSET-FREE substitution intents (replacement text + statement index) in rendered coordinates; `inline_function` re-parses each call-site statement's stored PAYLOAD to locate the `CallExpression` span. Because statement ids are position-derived, removals re-index later siblings (new ids) and would orphan a queued payload edit. The resolution: execute ALL structural removals FIRST (the declaration, and every sole-binding importer, via `removeChildStatement`), recording each removed index per module, THEN queue the call-site payload edits at each call site's CURRENT (post-removal) index. This keeps the "an importer that imports AND calls the function" case coherent (the import at index 0 is removed, the call statement settles to its lowered index, and the splice lands on the right node id) — verified by the commit integration's re-ingest-equivalence test. Mixed importers are payload edits (binding removal) that don't re-index.

**(i) v1 limitations surfaced during the build.** (1) Same-module-only free vars are NOT allowed (self-contained = params + globals only). (2) Multiple calls to the function in ONE statement are handled: one substitution intent per call, matched left-to-right against the payload's `CallExpression` spans in source order. (3) The `examples/medium` corpus has **no** cleanly inlinable multi-call function: `formatTimestamp` (the natural candidate) is a single self-contained expression body imported by 2 modules, but `src/ui/timeline.ts` passes it as a `.map` callback (a non-call value use), which v1 refuses — so the real-corpus probe and the `dogfood:inline` default are a **capability-boundary demo**, exactly as the `move_declaration` dogfood default originally was. The substrate's inline *capability* is proven by the `@strata/verify` commit integration tests on synthetic corpora.

**Design-doc impact:** adds `inline_function` to the implemented tool set (`strata-design.md` § Tool set lists it as planned). No invariant change: in-module call-site statement ids stay stable (payload edits); the deleted declaration's id is gone (the function ceases to exist — not ID churn of a surviving node, so no stable-ID exception needed).

## 2026-05-29 — move_declaration paired dogfood (N=1): substrate ~48% cheaper — bulk-propagation cost edge extends to cross-module moves

**What ran.** `dogfood:move` (`packages/bench/src/dogfoodMove.ts`) — one keyed paired comparison on `examples/medium`, same natural-language prompt for both arms: move `formatTimestamp` from `src/lib/format.ts` into `src/lib/dateRange.ts` and repoint every importer. Baseline = file-tools Claude Code on a temp tree; substrate = Strata agent with `move_declaration`. Model `claude-sonnet-4-6`, default bounds (maxTurns=25, wallMs=240000), baseline-first. Artifacts: `packages/bench/results/dogfood-move-2026-05-29T17-14-42-229Z.{json,md}`.

**Result (both arms quality-pass — tsc-clean AND move genuinely performed: moved-to-target, removed-from-source, importers repointed → comparison conclusive):**

| Metric | baseline (file tools) | substrate (move_declaration) | sub/base |
|---|---:|---:|---:|
| Cost USD | $0.1840 | **$0.0952** | **51.7%** |
| Tool calls | 18 | **10** | 55.6% |
| Turns | 19 | **11** | 57.9% |
| Wall ms | 82,815 | **34,012** | 41.1% |

**Read: substrate CHEAPER (~48%), with about half the tool calls/turns and ~2.4× faster wall.** This is a confirming data point that `move_declaration` lands in the substrate's documented **bulk-propagation cost-win class** (rename/param-propagation-style leverage over many refs), not the extract/new-code class — even at modest fan-out (2 importers repointed), the structural move beat file tools on cost. Contrast the same-day `extract_function` dogfood below, where the substrate was *more* expensive: the distinguishing factor is whether the task forces bulk reference repointing (move/rename) vs. single-site code synthesis (extract).

**Caveats (do not overstate).** N=1, single paired trial — NOT a bench round; do not generalize to "move wins by X%". Fan-out is only 2 importers (`examples/medium` has no higher-fan-out non-barrel movable symbol; see the v1 entry's limitation (iv)). The quality gate is symmetric tsc + structural-move-performed; vitest is informational and the corpus's pre-existing T05 `dateRange.test.ts` failure is move-irrelevant (the baseline arm's full-suite vitest=false does not reflect the move). The asymmetry (substrate tsc-only gate vs. baseline tsc+vitest) is immaterial here since no test depends on where `formatTimestamp` lives.

**Design-doc impact:** none. Validates the prediction logged in the v1 entry's item (g).

## 2026-05-29 — move_declaration v1 shipped: cross-module move + named-import rewrite, intentional ID churn, shared appendChildStatement, source-sibling re-index, overlay edge-restore

**(a) v1 surface and boundaries.** `move_declaration(declaration_id, target_module_id)` — the 19th structural agent tool. Pure `analyzeMove` lives in `@strata/store` (the caller passes rendered context via `buildAnalysisContext`, the same seam `extract_function` uses); the apply path is `moveDeclaration.ts`. It moves a top-level declaration from its source module to a target module and repoints every importer.

- **Self-contained boundary.** A declaration is movable only if **every** symbol it references resolves to (i) a global/builtin, (ii) the declaration's own internals, or (iii) a symbol already present in the TARGET module. Any source-local or imported dependency is a rejection (`findOutOfScopeDependency`, which follows import aliases via `getAliasedSymbol`). v1 does not drag dependencies along or rewrite the moved declaration's own imports.
- **Importer handling — named imports only.** A sole `import { X }` from the source gets a style-preserving specifier path-rewrite (the importer's existing extension style is preserved). A mixed `import { X, Y }` has `X` split out into a new `import { X } from <target>` while `Y` stays. A back-import into the source module is added if the source still uses the symbol after the move.
- **Rejection list (each with a specific reason):** non-exported declaration; target name collision; non-self-contained (source-local or imported deps); namespace importer (`import * as`); default import of the symbol; re-export (`export { X } from`); and DYNAMIC import (`import("...")`) of the source module — the last detected via a recursive AST walk for a `CallExpression` with `ImportKeyword` and a string-literal specifier resolving to the source module.

**(b) ID churn is intentional (logged per the stable-IDs invariant).** A cross-module move is a delete-from-source + recreate-in-target, so the moved declaration and its identifiers receive new **target-derived** node IDs, and reference edges re-point during the commit-time materialization pass. This is deliberate ID churn. The CLAUDE.md invariant is "stable node IDs across mutations… do not introduce ID churn without logging a decision" — a cross-module move is by definition a structural relocation, not an in-place mutation, so the IDs *must* change with the module path; this entry is the required log. Within a module, IDs remain stable as before.

**(c) `appendChildStatement` extracted.** The end-of-file-shift insert (append a top-level statement, shifting the `EndOfFileTrivia` child index UP by one) was factored out of `create_function`/`add_import` into a shared helper now also used by `move_declaration` for both the target insert and the source back-import.

**(d) Source-sibling re-index — coordinate fix surfaced by the integration test.** Removing a top-level declaration from a module requires re-indexing every surviving sibling AND the `EndOfFileTrivia` node DOWN by one, because a node's `childIndex` is part of its ID. Without it, two failures appeared: re-ingest equivalence broke (the stored EOF node carried a stale id), and commit hit FK violations (stale-indexed survivor rows vs. freshly-resolved edges). `move_declaration` deletes all stale-indexed rows (tracked for rollback) and re-inserts the survivors at corrected ids as tracked inserted nodes, so commit re-emits their identifiers and edges. This is the **first top-level-statement deletion** in the codebase — `create_function`/`add_import` only ever shifted indices UP (insertion); nothing had shifted DOWN (deletion) before.

**(e) Overlay edge-restore + first-seen-wins rollback guard.** `move_declaration` is the first operation to delete reference edges at **apply** time (outside the commit finalize transaction), which exposed that the tx overlay tracked only nodes for rollback restore, not edges. Added `deletedEdgesToRestore` to the overlay plus restore-on-rollback, so a rolled-back move resurrects nodes AND edges. Also added a **first-seen-wins guard** to `trackDeletedNodeForRestore`: an id that was inserted earlier in the same tx and then re-deleted (e.g. a re-indexed `EndOfFileTrivia` later shifted again by the back-import's append) is ephemeral and must NOT be queued for restore — rollback's phase-1 already deletes every inserted id. The guard is backed by the plain-INSERT PK invariant (re-inserting a pre-tx id requires deleting it first, so the genuine pre-tx row is already tracked) and also fixes a latent phantom-node bug in the hypothetical two-appends-to-one-module-in-one-tx case.

**(f) v1 limitations (logged, acceptable).**
- (i) The back-import always emits a `.ts` extension — correct for `examples/medium` (which uses `.ts` relative imports) but would diverge in style from an extensionless corpus. Importer *rewrites* preserve the importer's own extension style; only the back-import is fixed-style.
- (ii) Importer discovery matches relative specifiers by extension-stripping; a directory-index specifier (`"./a"` resolving to `./a/index.ts`) would not match, so that importer would be silently missed — but the commit-time `tsc` gate catches the resulting dangling import (fails loud at commit, not silent corruption).
- (iii) Dynamic imports with a computed/template specifier (`import(someVar)`) are not statically analyzable and not detected; only string-literal dynamic specifiers are.
- (iv) The substrate refuses to move a symbol that is namespace-imported or re-exported through a barrel. In `examples/medium`, `User` hits both, so `dogfood:move` defaults to `formatTimestamp` (`lib/format.ts` → `lib/dateRange.ts`, 2 named importers) instead — a smaller but clean bulk-propagation target. The corpus has no higher-fan-out non-barrel movable symbol.

**(g) `dogfood:move` harness.** Paired keyed harness paralleling `dogfood:extract`, with a symmetric quality floor (tsc-clean + move-performed; vitest informational). Operator-triggered and budgeted; NOT run as part of this build. Per the substrate's documented cost edge (bulk rename/param propagation), `move_declaration` is predicted to extend that edge for bulk importer-repointing; the keyed run validates whether it does.

**Design-doc impact:** none on `strata-design.md`. Adds `move_declaration` to the tool surface as specified in § "Tool set."

## 2026-05-29 — extract_function paired dogfood (N=1, simple + compound): baseline wins both; substrate's cost edge is bulk-propagation-specific, not extract-class

**What ran.** `dogfood:extract` (new harness, `packages/bench/src/dogfoodExtract.ts`) — one keyed paired comparison on `examples/medium`, same natural-language prompt for both arms: extract the `parseArgs` token-parsing loop in `src/flags.ts` into a helper. Baseline = file-tools Claude Code on a temp tree; substrate = Strata agent with `extract_function`. Model `claude-sonnet-4-6`, default bounds. Artifacts: `packages/bench/results/dogfood-extract-2026-05-29T04-00-33-315Z.{json,md}` (+ `-corrected.md`).

**Result (both arms produced a correct, tsc-clean extraction):**

| Metric | baseline (file tools) | substrate (extract_function) | sub/base |
|---|---:|---:|---:|
| Cost USD | **$0.0969** | $0.1174 | 121% |
| Tool calls | **4** | 7 | 175% |
| Turns | **5** | 8 | 160% |
| Wall ms | **30,837** | 63,365 | 206% |

**Honest finding: on a single-site extraction, the file-tools baseline wins** — cheaper, fewer tools/turns, faster, and arguably a cleaner result (the baseline chose a return-object design `parseTokens(tokens): { positional, options }`; the substrate used by-reference mutation — both correct and tsc-clean). This is N=1, not a bench round, and is **directionally consistent with the architecture**: `extract_function` is a one-shot, single-site edit, which is exactly where file tools are cheap (the agent just edits text).

**Compound follow-up (same session, 2026-05-29) — the hypothesis was WRONG.** Hypothesis: a compound task (extract → rename the helper → add a parameter to it) would let the substrate's graph-traceability win, since each follow-on is a clean graph op. Ran the SAME paired harness with a compound prompt (artifacts `dogfood-extract-2026-05-29T04-26-30-720Z.{json,md}`). Both arms completed the full compound correctly (final `scanTokens(... verbose: boolean = false)`, tsc-clean). Result — the substrate did **worse**, not better:

| Metric | baseline | substrate (compound) | sub/base |
|---|---:|---:|---:|
| Cost USD | **$0.1004** | $0.2089 | **208%** |
| Tool calls | **3** | 16 | 533% |
| Turns | **4** | 17 | 425% |
| Wall ms | **33,923** | 93,045 | 274% |

**Root cause (the decision-grade insight).** The substrate's measured cost advantage requires **bulk graph-traceable propagation over many existing references** (the T03 rename-across-a-corpus win). A *freshly extracted* helper has exactly **one** caller, so NO follow-on op on it is bulk — rename and add_parameter each touch a single call site, which the file-tools agent folds into the same ~3 text edits as the extract. Meanwhile the substrate pays per-op **transaction + validate(tsc) + commit ceremony** for each of the three ops, plus `find_declarations` to re-locate the node between steps — so the compound *multiplied* the substrate's ceremony (16 tools / 3 commits) without adding any bulk leverage. Stacking graph ops on a low-fan-out symbol makes the substrate strictly worse.

**Refined value proposition (use this in product copy).** `extract_function`'s value is NOT cost — it is (a) correctness/safety (auto-inferred params/returns, hazard rejection, semantic preservation by construction) and (b) making new code a graph citizen so it can *participate* in a future bulk op. The substrate's *cost* win is specific to **bulk propagation over many existing call sites** (rename / add_parameter on widely-referenced symbols, T01/T03-class). Do not pitch extract-class or new-code tools as token wins. The roadmap "visibly wins" gate for extract is **not met and is not expected to be met on extract-shaped tasks**; the win lives in the rename/parameter-propagation class, already demonstrated by T03.

**Harness bug found and fixed mid-analysis (no re-spend).** The first run wasted $0 (failed at corpus-copy before any model call — relative `examples/medium` resolved under the pnpm-filter cwd `packages/bench/`; fixed by passing an absolute corpus path). The completed run then mis-reported "inconclusive" because the baseline's full-suite vitest failed — but that failure is `examples/medium`'s **pre-existing** T05 half-open-interval fixture (`dateRange.test.ts`), unrelated to the extraction, and the substrate arm runs a tsc-only gate so it never ran vitest. Requiring full-suite vitest on the baseline was unfair and asymmetric. Fix: the harness quality floor is now **symmetric tsc-clean + structural-extraction** for both arms; `vitestPassed` is informational with a note about pre-existing corpus failures. Verdict recomputed from the captured costs (no new keyed run): both arms quality-pass → comparison conclusive → substrate not cheaper.

**Why logged:** records the only keyed spend this iteration and its honest (negative-for-the-tool) result, plus the harness correction, so the "extract_function wins" question isn't silently assumed and the next validation (compound task) is captured.

## 2026-05-28 — extract_function v1 shipped: two-coordinate design, lib-backed analysis program, shorthand-property fix, op-log provenance

**What shipped:** `extract_function` (packages/store/src/extractFunction.ts + extractAnalysis.ts; agent tool in packages/agent/src/tools.ts). Pulls a contiguous statement index range from a top-level `FunctionDeclaration` body into a new top-level function and replaces the span with a call. Full auto-infer: parameters (parent-scope free variables), return value(s) (span-declared bindings used after the span — single binding → `return x`, multiple → returned object destructured at the call site), and async-ness (span contains `await` → new function is `async`, call site uses `await`). Implemented as plan `docs/superpowers/plans/2026-05-28-extract-function.md` (Tasks 1–10), branch `extract-function`.

**(a) v1 surface and rejections.** Accepts: sync value-in/value-out + `await`. Refuses, with a specific reason, any span that contains:
- a `return` statement (would return from the new function, not the original);
- a `break`/`continue` that escapes the span (loop/switch depth tracked; confined breaks accepted);
- a `yield` expression (generator semantics can't be extracted cleanly);
- `this`, `super`, or `arguments` (binding changes in a top-level function);
- dependence on the enclosing function's type parameters (type parameter declared inside parent, referenced in span);
- reassignment of a parent-scope binding (targets bindings declared inside the parent function but outside the span — a param or a pre-span local — which would become a by-value parameter, silently losing the write). Module-level or outer-function-level writes are NOT rejected here because scope is shared at the new top-level site. The commit-time `validate` (tsc) is the inference backstop for any inference error or edge case the static checks miss.

**(b) Two-coordinate design.** Semantic analysis runs over a `ts.Program`/`TypeChecker` built from **rendered** module text (`buildAnalysisContext` seam in `@strata/verify`). The mechanical payload splice uses the **stored payload** text (formatting may differ from rendered; `add_parameter` edits payloads directly for the same reason). The statement index range is identical in both coordinate systems because Prettier never adds, removes, or reorders statements — so `sf.statements[parentStatementIndex].body.statements[rangeIndex]` maps cleanly to `payloadSf.statements[0].body.statements[rangeIndex]`. Parent is located in the rendered program at `sf.statements[parent.childIndex]` (`EndOfFileTrivia` is not a `ts.Statement`; index is exact). The new function is inserted via `create_function` (class-1 materialization at commit); the parent splice queues a `queueTextSpanEdit` (class-2 re-derivation at commit).

**(c) Lib-backed analysis program.** `analyzeExtraction` in `extractAnalysis.ts` uses its own lib-backed in-memory program (`buildLibBackedProgram`) rather than the shared minimal `createInMemoryProgram` in `resolveReferences.ts`. Reason: inferring return types needs the stdlib (e.g. `checker.typeToString` on an `await Promise<T>` expression unwraps to `T` only with `Promise` defined). The shared `createInMemoryProgram` is deliberately lib-free: the cross-module reference resolver (`resolveReferences.ts`) explicitly skips non-rendered declarations and would be confused by lib types. The shared builder was intentionally left unchanged to avoid regressing cross-module reference resolution. `analyzeExtraction` thus builds its own program, pays the lib-load cost per call, and is independent of the resolver path.

**(d) Shorthand-property symbol resolution.** Discovered during real-corpus testing: for `{ x }` shorthand property assignments (e.g. `const pair = { a, b }`), `checker.getSymbolAtLocation(id)` on `a` or `b` inside the object literal returns the **property** symbol (declared inside the object literal, i.e. inside the span), not the variable symbol from the enclosing scope. Without a fix, `inferParams` would exclude `a` and `b` from the parameter list (their symbol is declared inside the span, not before it), and `isReferencedAfterSpan` would also fail to see them as "used after." Fix: both `inferParams` and `isReferencedAfterSpan` call `checker.getShorthandAssignmentValueSymbol(id.parent)` when the identifier is a shorthand property name, resolving the actual binding. Covered by the `shorthand property assignment` integration test in `packages/verify/tests/extractFunctionCommit.test.ts`.

**Op-log provenance.** `extract_function` reuses `create_function` internally to insert the new function. This means the operation log records a `CreateFunction` op followed by an `ExtractFunction` op for a single extract. This is intentional — the `CreateFunction` is real provenance (the node was created), and the `ExtractFunction` captures the extract-specific parameters (parent ID, index range, param/return counts). A future replay or audit system will need to handle both entries as a unit; that's deferred to when op-log replay is a first-class use case (not v1).

**Known v1 gaps (validate-backstopped, not pre-commit rejections).** Surfaced by the final whole-implementation review; documented here so they are durable, not surprises:
- **Destructuring-binding declarations used after the span.** `collectSpanDeclarations` only collects identifier binding names, so a span that declares via destructuring (`const { x, y } = a;`) and uses `x`/`y` after the span under-returns (returns `void`). The spliced parent then references undefined names and the commit fails with a TS2304 ("Cannot find name 'x'") rather than a friendly "destructuring binding used after the span is not supported in v1" reason. No corruption (the `validate` gate refuses the commit); only the error quality suffers. Cheap future improvement: detect a destructuring decl whose names are used after the span and reject with a specific reason.
- **Name collision with an imported (vs declared) symbol.** The pre-commit collision scan compares only against sibling top-level *declaration* names, not imported names. Extracting into a function whose chosen name shadows an `import { name }` is caught at commit by `validate` (commit returns `{ ok: false }`), not by the friendly pre-commit collision message. Again validate-backstopped; only error quality.

Both are accepted v1 limits: the integrity guarantee (no silent wrong-but-compiling output) holds because the commit `validate` gate is the backstop; only the *diagnostic* is less friendly than a static rejection.

**Integration tests:** 8 tests in `packages/verify/tests/extractFunctionCommit.test.ts` covering findability after commit, call-site → new-function reference edge, re-ingest equivalence (node IDs + edges), rollback on tsc failure, shorthand-property params, real-corpus tolerant probe, and pre-commit rejection. All pass; full-suite 261 tests pass; T03 all 11 criteria true.

**Design-doc impact:** none on `strata-design.md`. Adds to the tool surface as specified in § "Tool set."

## 2026-05-28 — validate() now resolves in-memory relative imports (resolveModuleNames override); fixes a pre-existing cross-module type-check gap

**Context:** Surfaced while building graph-materialization (plan Task 11). A new test commits a
`create_function` into module `a.ts` that imports from `./b` where `b.ts` exists only in the
in-memory rendered set (not on disk). `commit()` → `validate()` returned `{ok:false}` with a
TS2307 ("cannot find module './b'").

**Root cause:** `validate()` builds an in-process `ts.createProgram` with a host whose
`fileExists`/`readFile`/`getSourceFile` are overridden to serve the in-memory `renderedFiles`.
But TypeScript's module *resolution* path does not go through those overrides the way file
reads do — it uses its own resolver (effectively `ts.sys.fileExists`), so a relative import to
an in-memory-only module fails to resolve even though the module's text is available. This was a
pre-existing latent bug: it never bit before because bench corpora live on disk, so relative
imports resolved against the real filesystem.

**Fix:** added a `resolveModuleNames` override on the `validate()` compiler host. For relative
specifiers (start with `.`) it resolves against `renderedFiles` by `path.join(containingDir,
spec)` + extension probing (`.ts/.tsx/.js/.mjs`), returning the in-memory module. For bare/
package specifiers it falls back to `ts.resolveModuleName(...)` (disk/node_modules). The fallback
is a pure function over the host, no recursion. The override is strictly *more* correct: it can
only resolve modules that genuinely exist in the store; a truly missing module still yields
TS2307. (`packages/verify/src/validate.ts`.)

**Known residual limitation:** in-memory-only **barrel `index.ts`** imports (`from "./subdir"`
resolving to `./subdir/index.ts`) are only partially probed; if the barrel is in-memory-only it
may still not resolve. Not hit by any current corpus (real barrels are on disk). Revisit if an
all-in-memory barrel case appears.

**Why logged:** unplanned divergence discovered during implementation; it changes module
resolution for every `commit()`/`validate()` call, so it deserves a record per CLAUDE.md. All
49 verify tests + the full monorepo suite pass with the override.

## 2026-05-28 — graph-materialization implementation: add_parameter is NOT deferred after all — it flows through class-2 and is verified consistent

**Context:** The graph-materialization spec (entry below) deliberately DEFERRED `add_parameter`
materialization to keep the prerequisite's blast radius small, planning to scope class-2
re-derivation to extract's parent statement only. During implementation (plan
`docs/superpowers/plans/2026-05-28-graph-materialization.md`, Task 9 — commit-path wiring) this
deferral turned out to be both unnecessary and counterproductive, and was reversed.

**What changed:** `add_parameter` now flows through class-2 re-derivation like any other
text-span mutation. The class-2 trigger is "the statement has a queued `textSpanMutation`," and
`add_parameter` queues text-span edits on the signature statement + each callsite statement — so
those statements are re-derived at commit, making `add_parameter`'s graph consistent (its new
parameter identifier and each callsite's new argument identifier become real nodes; edges
recompute).

**Why the deferral was reversed:**
1. **No clean way to defer it.** class-2 fires on any `queueTextSpanEdit`. The only current
   producers of text-span edits are `add_parameter` (and `change_return_type`/`replace_body`);
   `extract_function` does not exist yet. So "defer add_parameter" would have meant scoping
   class-2 to fire on *nothing that currently exists* — leaving the entire class-2 path dead and
   untested until extract is built. Embracing add_parameter gives class-2 a real, shipping,
   tested consumer NOW.
2. **It closes a real staleness gap.** `add_parameter` had the same invisibility gap as
   `create_function`/`add_import` (it inserted identifiers via text edits without materializing
   graph nodes). Routing it through class-2 fixes that for free.
3. **It's verified correct.** A new test (`packages/verify/tests/materializeCommit.test.ts`,
   "add_parameter graph is consistent after commit (class-2 path)") proves: after
   `add_parameter` + `commit()`, the function is still findable, its declaration node id is
   stable, `get_references` returns the re-derived callsite edge, no `node_references` row
   dangles, and the signature payload is updated. All 296 tests across the monorepo pass.

**Implementation wrinkle this surfaced (and its fix):** when a statement is both renamed (an
`identifierMutation`) and re-derived (a `textSpanMutation`) — or more generally when class-2
deletes+re-emits a statement's identifier rows — the overlay's `identifierMutations` still
referenced the OLD (now-deleted) identifier IDs, which `commitWithoutValidate` would then
mis-apply. Fixed with `collectReDerivedIdentifierIds()` (snapshots the pre-deletion identifier
IDs) + `stripStaleMutations()` (drops those entries from the overlay before
`commitWithoutValidate`), since the rename is already baked into the statement's final payload
that class-2 re-derives from. See `packages/verify/src/validate.ts`.

**Atomicity:** the post-validation materialization sequence
(`materializeStatementPayloads` → class-1 → class-2 → `refreshReferenceEdges` →
`commitWithoutValidate`) is wrapped in a single `db.transaction()` in both `commit()` and
`commitWithBehavioralGate()`, so a throw mid-materialization rolls back payloads, node/edge
changes, and the op-log together (no partial state). better-sqlite3 nests via SAVEPOINTs.

**Design-doc impact:** none on `strata-design.md`. The graph-materialization spec
(`docs/superpowers/specs/2026-05-28-graph-materialization-design.md`) is updated: the
"add_parameter deferred" notes are corrected to "add_parameter included + verified." The
[[strata-scope-drift]] guard is satisfied — this is a substrate-correctness win on a shipping
tool, not methodology navel-gazing.

**Tried first:** scoping class-2 to exclude add_parameter (per the original spec). Rejected: no
clean discriminator between add_parameter's and extract's text-span edits, and it would leave
class-2 untested until extract exists. Operator confirmed "embrace + verify + log" on 2026-05-28.

## 2026-05-28 — graph-materialization design: R1 + scoped per-statement re-derivation (bounded stable-ID-invariant divergence) + EOF off-by-one fix

**Context:** `extract_function` (spec `docs/superpowers/specs/2026-05-27-extract-function-design.md`)
is blocked on a prerequisite: a commit-time pass that re-derives Identifier children + reference
edges for modules a transaction changed. The shipped `create_function`/`add_import` insert only
the top-level statement node — no Identifier children, no edges — so created/imported names are
invisible to `find_declarations`/`get_references` (verified: `createFunction.ts:91-99`,
`addImport.ts:80-88`). The prerequisite spec proposed three resolutions (R1 additive-only, R2
scoped re-derive + remap, R3 re-key IDs off content) and tentatively leaned R1. Per `CLAUDE.md`,
the spec went to Codex (gpt-5.5, xhigh, read-only) before an implementation plan; every pivotal
Codex claim was then verified against the code before acceptance.

**What was decided:** Adopt **R1 + a bounded R2 scoped to a single statement**, not pure R1.
- **R1 (additive)** for newly-inserted top-level nodes (helpers, imports): emit their Identifier
  children with fresh, re-ingest-consistent IDs.
- **Scoped re-derivation (class-2)** for edited-in-place statements whose internal identifier
  set/order changed (extract's parent-body splice; `add_parameter`'s signature + each callsite):
  re-derive *that statement's* identifiers from final rendered text — delete old Identifier rows
  + their edges, re-emit, recompute edges via the resolver.
- **No change (class-3)** for set/order-preserving edits (`rename_symbol`): keep the existing
  payload-edit model; no re-derivation, no program build.

**Why pure R1 was insufficient (the decision-grade Codex finding, verified):** extract's call
site (`helper(a, b)`) is inserted *inside* the parent body, which is an edited-in-place statement
(a `queueTextSpanEdit`, `transactions.ts:83`), not a new top-level node. Pure R1 explicitly does
not re-derive an edited statement's internal identifiers, so it would make the helper findable
but never create the call-site→helper edge. That is not merely an observability gap: `rename_symbol`
propagates through reference edges (`rename.ts:61` renames the declaration identifier **plus**
every `getReferencesByTo` source), and `add_parameter` discovers callsites from references
(`addParameter.ts:155`, `callsites.ts:59`) — so a missing call-site edge silently breaks a later
rename/add_parameter of the extracted helper. Confirmed against the code.

**Why this touches the invariant, and the bound:** `CLAUDE.md` invariant — "a mutated expression
is the same node with new state, not a new node; do not introduce ID churn without logging a
decision." Identifier node IDs are position-derived: `nodeId(modulePath, [statementIndex,
identifierDFSIndex], "Identifier")` (`ids.ts:9`, `identifiers.ts:20,28`), and must match what a
clean re-ingest computes (the resolver re-derives them by re-parsing, `batch.ts:185,193,218`).
Once a statement's internal identifier set changes, "keep survivor IDs" and "match re-ingest" are
incompatible — there is **no clean position-stable ID for a mid-statement inserted identifier**
(re-running DFS shifts survivors; reusing freed indices corrupts history; fresh non-DFS IDs
diverge from the resolver). So class-2 re-derivation deliberately churns the changed statement's
body-internal identifier IDs. **The bound that makes this acceptable:** IDs are scoped by
`statementIndex`, and structural edits change only a statement's *internal* identifiers — extract
removes *body* statements (inside one top-level FunctionDeclaration), `create_function`/`add_import`
append at the end, so **top-level statementIndex values stay stable and no other statement's
identifier IDs are perturbed.** Churn is contained to the one statement that structurally changed.

**v1 cost accepted (logged here):** reference edges are *always* made consistent (the resolver
recomputes them — `get_references`/`rename`/`add_parameter` depend on it). But op-log
`operations.affected_node_ids_json` entries that named a now-churned body-internal identifier
become point-in-time pointers; these are **not** retroactively remapped in v1 (consistent with
extract's existing "span offsets are point-in-time" stance; op-log replay is not a v1 use case).
The operation sequence + reasoning remain canonical history. A per-statement old→new remap is
deferred until a replay/audit use case exists.

**Pre-existing bug surfaced (verified, must fix first):** ingest stores an `EndOfFileTrivia`
module child at `childIndex = statements.length` (`ingest/index.ts:42-49`), and
`create_function`/`add_import` use `listChildren(moduleId).length` as the new statement index
(`createFunction.ts:75`, `addImport.ts:64`). For a module with `N` real statements + 1 EOF node,
they place the appended statement at `[N+1]`, but a clean re-ingest of the rendered text places it
at `[N]` (EOF moves to `[N+1]`). The batch resolver derives `[N]`. So additive materialization
would emit identifiers whose parent ID never matches the stored node. **Fix:** append at the EOF
node's index (`N`), bump EOF to `N+1`. Render output is unchanged (function still at file end);
only the derived ID moves. This is independently a latent correctness bug in the shipped tools.

**Other verified Codex corrections folded into the spec:**
- Resolver core + `emitIdentifiers` move into `@strata/store` (no ingest cycle: ingest→store
  only, store already imports `typescript`). It must take **final rendered text as a parameter**
  — store must not import `@strata/render` (`render/package.json` depends on store; store↔render
  cycle otherwise).
- Edge refresh is **surgical, not wholesale**: delete + recompute edges only for identifiers
  actually materialized/deleted (`from_node_id`/`to_node_id` keying, `schema.ts:43-49`), with
  delete-before-insert (`from_node_id` is PK, `insertReferences` is plain INSERT, `references.ts:11`).
- Materialization runs **inside the commit's DB transaction**, after payload materialization,
  only when validation passed — because `rollback` only deletes `overlay.insertedNodeIds`
  (`transactions.ts:107`) and `commit()` returns before materializing on diagnostics
  (`validate.ts:101`). Dirty/removal plan must be **snapshotted before** `materializeStatementPayloads`
  clears `overlay.textSpanMutations` (`validate.ts:285`).
- No-op gate is "no inserted nodes AND no identifier-set-changing structural edit," not "dirty set
  empty" — pure rename (`rename.ts:67`) must skip the program build.
- Resolver uses `validate()`'s tsconfig-derived compiler options (`validate.ts:392`), not
  `batch.ts`'s hardcoded ones (`batch.ts:133`).

**Tried first / rejected:** pure R1 (insufficient — call-site edge); R2-global re-derive +
remap-everything (biggest blast radius, churns IDs beyond the changed statement); R3 re-key IDs
off content (touches ingest + every ID consumer, out of scope for a prerequisite); and a
"split — ship R1-additive now, defer the call-site edge" option (rejected by operator in favor of
fully unblocking extract in one prerequisite).

**Design-doc impact:** none to `strata-design.md`'s architectural contract. This is the
incremental-mutation counterpart of batch ingest's graph derivation; the node-graph + operation-log
model is unchanged. The stable-ID invariant gets a logged, bounded exception for body-internal
identifiers of structurally-changed statements.

**Pointer:** `docs/superpowers/specs/2026-05-28-graph-materialization-design.md` (revised
2026-05-28 with the "Codex review outcome" + "Decision" sections). Codex transcript was at
`/tmp/codex-graphmat-response.log` (tmp, not committed).

## 2026-05-27 — validate() scopes tsc to all ingested modules (including tests + tool configs), not src-only

**Context:** L2.5 dogfood prep Task 5: no-op transaction commit gate against the valibot/library corpus (1,087 ingested modules). `commit(db, tx)` returned `ok: false` with 531 diagnostics.

**Finding:** `validate()` in `packages/verify/src/validate.ts` builds `rootNames: [...renderedFiles.keys()]`, where `renderedFiles` is populated from `listModules(db)` — all ingested modules. For valibot, this includes 272 `*.test.ts` files, 245 `*.test-d.ts` files, and 4 root-level files (`playground.ts`, `tsdown.config.ts`, `vitest.config.ts`, `mod.ts`) that valibot's own tsconfig never type-checks (`include: ["src"]`). The in-process `ts.createProgram` resolves imports for all 1,087 files and cannot find `vitest` (a dev dependency not exposed to this tsc call), `tsdown`, or `./dist/index.mjs`. All 531 diagnostics originate from outside `src/`; zero from `src/` files.

By contrast, `commitWithBehavioralGate()` (the agent path) uses `runCorpusAcceptance()` → `tscNoEmitSrc()` which asserts src-only scope. The basic `commit()` path has no such filter.

**Root cause:** `commit()` was designed for controlled bench corpora with src-only tsconfigs. It has no filtering layer to exclude non-src modules before building the tsc program. This wasn't visible in bench testing because the bench corpora (`examples/medium` etc.) contain only src files.

**Not fixed inline:** This is config plumbing, not a structural-tool semantic gap, and the L2.5 dogfooding can proceed using `commitWithBehavioralGate()` (which the agent already uses) rather than bare `commit()`. Fixing `validate()` to filter out test/config files is straightforward (e.g. filter `renderedFiles` to paths under `src/` before passing to `ts.createProgram`, or accept an explicit `srcRoot` parameter), but it's a change to `packages/verify` that deserves its own task with a test.

**Design-doc impact:** None to the architectural contract. The commit-gate semantic ("tsc must pass before commit") is correct; the scope of what gets passed to tsc needs tightening for real-world corpora.

**Revisit when:** `validate()` is used against any real-world corpus (non-bench). Fix: add a `srcRoot` parameter to `validate()` (and propagate through `commit()`) so it can filter `renderedFiles` to `path.relative(srcRoot, absPath)` patterns, mirroring what `commitWithBehavioralGate` does. Alternatively, exclude files matching `*.test.ts`, `*.test-d.ts`, and any module whose payload is outside the corpus's tsconfig `include` scope.

## 2026-05-27 — Fix-C: JSDoc corpus guard added to examples/medium; T03 substrate-win claim corrected

**What changed:** Added a real JSDoc block above `export interface User` in `examples/medium/src/types/user.ts`:

```typescript
/**
 * Represents a user of the system.
 * @internal
 */
export interface User { … }
```

Prior to this change, `User` had no JSDoc above it. That meant every prior T03 run — including all bench rounds that produced the "T03 is a substrate win" headline — ran on a corpus where `find_declarations` and its five sibling functions (`find_references`, `find_callers`, `find_incoming_refs`, `find_outgoing_refs`, `query_nodes`) never exercised the JSDoc-offset bug fixed in commits `a2e19b3`/`f752671`/`90961fc`/`d4f3fcf`.

**The bug (Fix-A/B, summarized):** `find_declarations` selected the lowest-offset tree-sitter `Identifier` node inside an `InterfaceDeclaration` (or any declaration kind). When a JSDoc block appears above the declaration, tree-sitter emits `Identifier` nodes for each JSDoc tag word (e.g. `internal` from `@internal`) at lower source offsets than the actual declaration name. The lowest-offset picker returned a JSDoc tag word instead of the interface name — wrong identifier, wrong rename target.

**The fix shape:** A `pickDeclName` parser-offset helper was introduced that locates the declared name by walking children of the declaration node and finding the first `Identifier` that is at or after the declaration's own start offset, not just globally minimal. Six sibling call sites in `packages/store/src/store.ts` were updated to use this helper. The store test suite reached 95 tests green.

**Codex review:** An independent xhigh Codex review was conducted in-session on 2026-05-27. Brief at `/tmp/codex-brief-find-declarations.md`. The review recommended adding the JSDoc guard to the bench corpus before closing Fix-C, specifically noting that the prior T03 success was silently conditioned on the corpus being JSDoc-free above the renamed declaration.

**T03 substrate-claim correction:** The "T03 is a substrate win" claim (multi-trial bench results recorded in earlier decisions.md entries and in `docs/product-roadmap.md`) remains directionally correct, but it had an unspoken caveat: the corpus happened to be JSDoc-free above `User`. The claim should now be read as: "T03 is a substrate win, and now verified against a JSDoc-annotated corpus." With the Fix-A/B patch applied, T03 passes on the JSDoc-guarded corpus with all 11 criteria true (`commitReturnedOk`, `validateAfterCommitClean`, `importRenamed`, `typeAnnotationRenamed`, `genericPromiseRenamed`, `namespaceImportRenamed`, `auditLiteralUntouched`, `auditLiteralOnlyRemainingUser`, `indexReExportRenamed`, `jsdocReferencesRenamed`, `operationRowAppended`).

**Why no prior test caught this:** The 95 store tests added in Fix-A/B were synthetic; none used `examples/medium` directly. The T03 acceptance test in `packages/cli/tests/t03.test.ts` ingests the real corpus but the corpus was JSDoc-free, so the broken path was never executed.

**Tried first:** Considered adding JSDoc to a second declaration (not `User`) to stress a non-rename path. Rejected — the scope of Fix-C is the corpus guard for the established T03 benchmark target, not broad corpus enrichment. Drive-by JSDoc additions to other declarations are deferred.

**What was decided:**
1. `examples/medium/src/types/user.ts` now carries a real `/** ... @internal */` block above `User`. This is the only corpus change in Fix-C; no other declarations in `examples/medium` were JSDoc-annotated.
2. T03 passes on the new corpus state; all 68 tests across `packages/cli` (7) and `packages/bench` (62) remain green; no fixture updates were needed.
3. **Forward-looking:** future bench corpora should include JSDoc-prefixed declaration targets by default. A corpus without JSDoc above any target can silently mask the JSDoc-offset class of bugs. The guard is now established; any corpus regression that removes the JSDoc block will be immediately visible in T03.

**Design-doc impact:** none on `strata-design.md`. Bench-corpus shape is an implementation detail, not a design contract.

**Pointer to change:** `examples/medium/src/types/user.ts`, commits for this entry.

**Correction (2026-05-27, post-entry):** Cross-cutting review found three factual errors in the descriptive paragraphs above. Append-only fix per the file's convention:

- The helper is named `resolveDeclarationNameIdentifier`, not `pickDeclName`. It lives in `packages/store/src/declarationName.ts`, not `store.ts`.
- The "five sibling functions" parenthetical (`find_references`, `find_callers`, `find_incoming_refs`, `find_outgoing_refs`, `query_nodes`) is incorrect — none of those exist. The actual six call sites migrated in Fix-B are: `get_references` and `find_declarations` in `queries.ts`, `list_module_exports` and `find_declarations_in_module` in `discovery.ts`, `rename_symbol` in `rename.ts`, `buildDeclarationEmbeddingText` in `embed.ts`, and `resolveCallsites` in `callsites.ts` (5 files, 6 functions, one of which — `find_declarations` — was migrated in Fix-A).
- The "Six sibling call sites in `packages/store/src/store.ts`" sentence is wrong on both count and file: there's no `store.ts`; the call sites live in the five files named above.
- The bug mechanism description ("tree-sitter `Identifier` node") is also off — Strata uses TypeScript's compiler API (`@strata/ingest`'s `emitIdentifiers` via `getChildren`), not tree-sitter. The mechanism is correct in shape (lowest-offset Identifier picked, JSDoc tag identifiers persisted as children with lower offsets), just the parser name was wrong.

The Codex review brief was at `/tmp/codex-brief-find-declarations.md` (tmp path, not committed; key recommendation summarized in the original entry above).

---

## 2026-05-27 — L3.4 paired dogfood (N=1, two rename-class tasks on examples/medium): the substrate compounds — all four acceptance criteria PASS

**Context:** First operator run of the L3 "operation-log as memory" dogfood after building L1+L2+L3. Two rename-class tasks on the same persistent SQLite DB:
- Arm A (cold DB): rename `User` → `Account` (the T03 prompt).
- Arm B (same DB, after A): rename `Clock` → `TimeSource` (similar shape, different module).

Both keyed: `ANTHROPIC_API_KEY` for the agent, `STRATA_EMBED_API_KEY` (OpenAI text-embedding-3-small) for L3 commit-pattern embedding. Same model (`claude-sonnet-4-6`), same bounds, same corpus.

**Numbers (N=1 paired):**

| Metric | Arm A (cold) | Arm B (post-A) | B / A |
|---|---:|---:|---:|
| Cost USD | $0.0757 | $0.0411 | **54.3%** |
| Cache read input | 62,796 | 59,051 | 94.0% |
| Cache creation input | 9,856 | 2,658 | 27.0% |
| Tool calls | 8 | 6 | 75.0% |
| Turns | 9 | 7 | 77.8% |
| Wall ms | 26,263 | 19,033 | 72.5% |
| Total tokens (non-cached) | 1,262 | 814 | 64.5% |

**Telemetry verified the L3 path activated end-to-end:**
- `commit_pattern_embed` fired with `ok=true` in Arm A → the pattern (prompt + ops + modules + declarations) was JSON-stringified, embedded via OpenAI, and persisted to `commit_pattern_embeddings` (vec0) + `commit_pattern_meta`.
- `past_tasks_injected` fired with `count=1` in Arm B → `retrieveSimilarPastTasks` matched A's pattern against B's prompt and injected a "Past tasks like this one" section between L1's codebase shape and the user prompt.

Both arms succeeded with one operation committed each.

**Finding:** The substrate compounds. Arm B was cheaper than Arm A on every metric the harness tracks, and the L3 telemetry confirms the design's intended path executed. The plan L3.4 acceptance ("B's cost < A's cost") clearly holds.

**Two confounds in the N=1 reading (honest scope, not enough to retract the finding):**
1. **Task-size confound.** `Clock` has fewer references in `examples/medium` than `User`, so Arm B is structurally a smaller task. Some fraction of the 46% cost drop is "B is easier," not L3.
2. **Cache-warmth confound.** Arm B ran ~10 seconds after Arm A — within Anthropic's 5-minute prompt-cache TTL, so B benefits from cached system-prompt tokens that a cold B-run wouldn't have. Note the cache-creation drop (9,856 → 2,658) is too large to be cache warmth alone, but some of the cache-read symmetry (62,796 → 59,051) is.

To isolate L3's contribution from both confounds, a third arm would help: rename `Clock` → `TimeSource` on a fresh DB (no L3 memory) and compare its cost to Arm B's. Not run today — N=2 paired data points are enough for a first PASS, and per CLAUDE.md "do not chase N=2 noise into product claims" the conservative read is "L3 mechanism works and the cost direction is right." A control arm is filed as a follow-up when a specific falsifiable question demands it.

**Decided:**
1. L3 stays in. The mechanism is verified, the cost direction is right, and the design's "compounding" claim is supported at N=1 with explicit confound caveats.
2. The L3.4 harness reports four independent acceptance lines (both commits ok, L3 wrote, L3 retrieved, cost compounded). All four passing simultaneously is the strict signal; a future regression that breaks one but not the others is now diagnosable.
3. The harness's "honest read" note already documents both confounds in every emitted markdown, so future readings won't accidentally over-claim.

**Tried first:** considered running the same task twice (rename User → Account, reset corpus state between runs). Rejected because L3 retrieves on exact prompt match — that tests retrieval-by-prompt but not "similar shape generalization." The parallel-but-different design (User-rename then Clock-rename) is closer to the design doc's claim.

**Honest scope:**
- N=1, one paired trial.
- One corpus (`examples/medium`).
- One model (`claude-sonnet-4-6`) on one calendar day's pricing.
- The two confounds above. Most likely interpretation: L3 contributes a real but not-entirely-isolable fraction of the 46% drop; the rest is task-size + cache warmth.

**Design-doc impact:** none. The design's compounding claim is supported.

**Revisit when:** (a) the L2.5 dogfood lands on a corpus where semantic_search is active — the three layers stack and we can see whether L2+L3 compounds further; (b) someone outside the project tries it and the compounding question becomes a real product question rather than a research one.

### Same-day control arm (2026-05-27, same model + bounds + corpus)

Ran `Clock → TimeSource` on a fresh DB with `STRATA_EMBED_API_KEY` unset (L3 disabled — no commit-pattern writes, no retrieval). L1 still on. Result: `success`, lastCommitOk=true, 1 op.

| Run | DB state | L3 | Cost USD | Tool calls | Turns | Wall ms |
|---|---|---|---:|---:|---:|---:|
| Arm A (cold) | fresh | n/a (User rename) | $0.0757 | 8 | 9 | 26,263 |
| Arm B (post-A) | populated | retrieved 1 pattern | $0.0411 | 6 | 7 | 19,033 |
| Control (B-cold) | fresh | disabled | **$0.0423** | 7 | 8 | 17,975 |

**Decomposition of the A → B 46% cost drop:**

| Component | Cost saved | Share |
|---|---:|---:|
| Task-size (Clock < User), measured as Control vs A | $0.0334 | 96% |
| L3 retrieval, measured as B vs Control | $0.0012 | 4% |

**Revised honest reading at N=1:**
- The L3 mechanism activates end-to-end (telemetry confirmed in Arm B). That is a real positive signal.
- Once task-size is controlled for, the isolated L3 effect on this corpus is ~3% cost savings, 1 fewer tool call, 1 fewer turn vs L1-alone. Small. Not nothing, but small.
- The "B is 54% of A" headline in the harness markdown was overwhelmingly task-size, not L3. The harness's "honest read" note already flagged both confounds, but the headline number is misleading without this decomposition.
- L3's compounding value almost certainly scales with corpus size (where L1 can't dump everything), pattern count (more retrievable history), and task novelty (where past patterns reveal non-obvious target modules). None of those are stressed in this dogfood — examples/medium is 22 modules, one past pattern, two highly-parallel rename tasks. So the modest isolated L3 effect here is consistent with the design *and* with the design having a much weaker N=1 signal on small corpora than the unconfounded number suggested.

**Updated decision:** L3 stays in (mechanism works, direction is correct), but the dogfood-result interpretation in the harness's emitted markdown should NOT be quoted as "L3 saves 46% on the second task" — that's wrong. The correct N=1 quote is "L3 mechanism works end-to-end; isolated L3 contribution at N=1 on this small corpus is ~3% cost." The harness's existing "honest read" note prevents the wrong quote in any future markdown we emit, but anyone reading the existing 2026-05-27 dogfood markdown should also read this decisions.md entry.

**Revisit when:** L2.5 dogfood lands on a corpus where L1 alone is too expensive to inject fully — that's where L3's "where did past tasks touch" should genuinely save discovery overhead, not just slightly nudge it. If L3 still only saves ~3% there, the design's "substrate compounds" claim is weaker than the design doc suggests and worth re-scoping.

---

## 2026-05-27 — T05 substrate-vs-file-baseline (N=1): substrate+L1 at ~51% baseline cost; "5× tokens" claim in roadmap is stale

**Context:** Followup to the same-day L1.4 dogfood (entry below). Question: is Strata+L1 still more expensive than a plain file-tools Claude Code baseline on T05 — the task the 2026-05-26 roadmap pinned as "substrate ~5× tokens, graph navigation is dead weight"?

**Method:** Ran `strata baseline examples/medium "<T05 prompt>"` once. Same model (`claude-sonnet-4-6`), same prompt, same corpus, same day, file-tools agent on a temp clone. Result: `success` + `tscClean` + `vitestPassed`. Compared against the two arms of the same-day L1.4 dogfood.

**Three-way comparison (all three N=1, all three succeeded):**

| Metric | baseline (file tools) | Strata index-off | Strata index-on |
|---|---:|---:|---:|
| Cost USD | $0.0795 | $0.0652 | **$0.0409** |
| Total tokens (non-cached) | 783 | 1,123 | 1,012 |
| Output tokens | 776 | 1,114 | 1,004 |
| Cache read input | 52,057 | 49,315 | 50,072 |
| Cache creation input | 13,774 | 8,855 | 2,622 |
| Tool calls | 5 | 7 | 6 |
| Turns | 6 | 8 | 7 |
| Wall ms | 35,930 | 24,916 | 20,871 |

**Finding:**
- **Strata+L1 is ~51% the cost of the file-tools baseline** on T05 ($0.0409 vs $0.0795), ~42% faster on wall time.
- Strata uses ~29% MORE non-cached tokens than baseline (1,012 vs 783) but creates 81% LESS cache (2,622 vs 13,774). Cache-creation pricing (~3.75× cache-read) dominates the total. The structural tools return compact payloads; file tools dump whole file bodies into context which then has to be cache-created.
- Baseline uses the fewest tool calls (5). T05 is genuinely local ("open one file, fix one line"), so file tools have a structural advantage on tool count. Strata loses on tool count but wins on cost-per-tool-call.
- Even Strata index-off ($0.0652) is ~18% cheaper than baseline. So the substrate beats baseline on T05 even before the L1 layer.

**Decided:**
1. **Roadmap update:** the "T05 substrate costs ~5× tokens, dead weight" framing in `docs/product-roadmap.md` § "Stable signal" is stale and now marked as such. The 5× number was 2026-05-16, pre-iteration-3 tools (`read_test_file`, `list_module_exports`, `find_declarations_in_module`). Token ratio is now 1.29×, not 5×, and cost ratio is 0.51×. The line is reframed as "stale signal under review" rather than overwritten — N=1 is not enough to claim "substrate beats baseline on T05 generally."
2. **No claim escalation in README.** The README's headline result stays the T03 multi-trial finding. This T05 result is N=1 paired and is not strong enough evidence to put in the README.
3. **Not running more T05 trials right now.** N=2 would still be noise per CLAUDE.md. If a real product question (e.g. "does this hold across models?", "does Anthropic's cache pricing change the calculus?") creates a falsifiable hypothesis, then a 3-trial paired round is justified. Until then, N=1 is N=1.

**Tried first:** I had assumed the prior roadmap claim was still accurate. The L1.4 dogfood's cost number ($0.0409 for L1-on) made me question that, but the L1.4 dogfood doesn't include a baseline arm. Adding one was a single CLI invocation away.

**Honest scope:**
- One task (T05). T03/T08/T01 not re-measured today; their roadmap claims may also be stale.
- One corpus (`examples/medium`, ~22 modules). Different corpora can shift the cache/non-cache split.
- One model + one calendar day's cache pricing.
- Strata index-off ran first in the L1.4 pair; baseline ran later. Cache warmth between arms isn't directly comparable across the three runs since they were separate processes — but the prompt-cache TTL is 5 minutes, and the three runs were within that window, so similar warmth is a defensible read.

**Design-doc impact:** none on `strata-design.md`. Roadmap claim about T05 reframed in-place.

**Revisit when:** (a) another tool surface change lands that should affect T05 cost shape; (b) Anthropic's cache pricing ratio changes materially; (c) an explicit hypothesis about T05 substrate behavior demands a multi-trial paired round.

---

## 2026-05-27 — L1.4 paired dogfood (N=1, T05 on examples/medium): L1 wins on every metric except the one I picked as acceptance

**Context:** First operator run of the L1.4 paired dogfood after building the L1/L2/L3 codebase index (specs `docs/specs/2026-05-26-three-layer-codebase-index-*.md`). Harness: `pnpm --filter @strata/bench dogfood:l1 -- examples/medium`. Both arms used `claude-sonnet-4-6`, the T05 prompt, the T05 behavioral fixture as commit gate. Index-off ran first to give index-on the conservative read on cache warmth.

**Raw numbers (single paired trial, both arms `success` + `lastCommitOk=true` + 1 op committed):**

| Metric | index-off | index-on | on / off |
|---|---:|---:|---:|
| Total tokens (input+output, non-cached) | 1,123 | 1,012 | **90.1%** |
| Output tokens | 1,114 | 1,004 | 90.1% |
| Cache read input | 49,315 | 50,072 | 101.5% |
| Cache creation input | 8,855 | 2,622 | **29.6%** |
| Tool calls | 7 | 6 | 85.7% |
| Turns | 8 | 7 | 87.5% |
| Wall ms | 24,916 | 20,871 | 83.8% |
| Cost USD | $0.0652 | $0.0409 | **62.8%** |

Module index size: 1,971 chars / 28 lines. Both arms succeeded with identical operation counts.

**Finding:** the design's central claim ("L1 collapses speculative discovery") is supported on every metric — tool calls, turns, wall time, cache creation, and total cost all dropped. The only metric where the index-on win is small (10%) is "total tokens" (input+output, non-cached), and that's because essentially all input was cached (9 and 8 non-cached input tokens respectively across the two arms). Output is model-reasoning weight and doesn't shrink as dramatically as raw input fetches. So "total tokens" is the wrong acceptance metric on this kind of task — it's dominated by the component the index can't move.

**Decided:**
1. Harness now reports a richer table (already does) and uses **cost USD ≤ 80% of off** as the primary acceptance threshold (which would have PASSED at 62.8%) instead of total tokens (which FAILED at 90.1%). Cost USD correctly blends input + output + cache-creation + cache-read pricing in the proportions Anthropic actually charges; total tokens is a noisy proxy that ignores the cache axis entirely.
2. The L1.4 plan acceptance bullet (`Index-on cost ≤ 80% of index-off cost on this single comparison`) is preserved verbatim — "cost" was already the right word in the plan; my harness implementation chose the wrong column to threshold on.
3. **Not** retrying for a different number. N=1 with a one-op success on both sides is the read. Per CLAUDE.md "do not chase N=2 noise into product claims."

**Tried first:** ran the harness with total-tokens-as-acceptance. It FAILed (90.1% vs 80% threshold) even though every other metric showed a clean win. Reading the columns revealed the cache-vs-non-cached split that made "total tokens" the wrong threshold.

**Honest scope of this finding:**
- One task (T05, single-test fix on examples/medium). The L1 win shape on a rename-heavy task (T03) or a multi-module discovery task could look quite different.
- One corpus (examples/medium, ~22 modules). On corpora where the L1 index becomes itself expensive (>100 modules), the calculus changes — that's L2's domain (semantic_search), not L1's.
- One model (claude-sonnet-4-6) on one calendar day. Cache pricing changed in the past and may change again; an acceptance threshold pinned to USD is more pricing-stable than one pinned to tokens.
- Index-off ran first; index-on benefited from prompt-cache warmth on the shared system prompt. The 70% drop in cache creation tokens is partly the L1 win and partly index-on being run second. The 16% wall-time drop survives this caveat (both arms were below the cache TTL).

**Design-doc impact:** none. The design's "L1 reduces discovery overhead" claim is supported. The plan's "≤80% cost" acceptance is unchanged.

**Revisit when:** (a) L2.5 dogfood on a corpus where L1 alone is too expensive — that's where cost USD will be more diagnostic; (b) prompt-cache pricing changes; (c) a multi-rename task (T03-style) on examples/medium gets a paired dogfood, which should show a larger relative L1 win since rename involves more declaration-fishing than test-fixing.
- An attempt fails and shapes the next attempt (record the failure too — silent retries lose information).

If the decision is durable, also update `strata-design.md` and reference the diff or commit from the entry.

## Entry format

```
## YYYY-MM-DD — <short title>

**Context:** what triggered this decision (phase, package, problem encountered).

**Considered:** the alternatives weighed (briefly).

**Decided:** what we're doing now.

**Why:** the reasoning, especially anything not obvious from the alternatives.

**Design-doc impact:** "none" / "updated § X" / "supersedes § X paragraph N".

**Revisit when:** the condition that should make us reopen this (e.g., "if Phase 4 benchmarks show ingest is the bottleneck").
```

---

<!-- New entries go below this line, newest first. -->

## 2026-05-26 — Pivot from "characterize the substrate" to "iteratively develop the product"

**Context:** Across the day's bench rounds, I (Claude) flip-flopped on substrate claims because I kept reading product-level conclusions off N=2 trials and a few measurement bugs I had introduced. The operator named the pattern directly ("it wasn't working, it was working, it wasn't working — flip-flopping — I don't get what we're doing here") and asked the project to be reoriented toward iterative product development. The bench has answered its central question: T03 wins, T01/T05/T08 are mixed-or-lose, and re-running it at low N produces noisy claims, not new insight.

**Considered:**
- (a) Keep iterating on bench measurement until T01/T05/T08 also separate. Falsified by ~$20 of keyed exploration today + the prior May-17 TERMINAL: the integrity-preserving structural levers that could close T01 don't exist, and T05/T08 are local-content tasks where graph navigation is dead weight by design.
- (b) Quietly drop the bench and start shipping. Loses the discipline of "tools win on tasks" and risks shipping unmeasured claims.
- (c) Reorient explicitly: bench is now context (one task wins, the limits are documented), product development is the goal, and any new bench task must be justified by the tool it scores.

**Decided:** (c). Updated CLAUDE.md with a "Current orientation: product, not measurement" section and added `docs/product-roadmap.md` with concrete iterations (usable CLI surface → broaden the tool set with tasks → persistence/incremental ingest → write-up and OSS release). Hard rule encoded in CLAUDE.md: no new bench rounds without a falsifiable product question; default move when stuck is to ship a smaller piece of the surface, not measure again.

**Why:** The MVP success criterion in `strata-design.md` § "What success looks like" is "Strata exists and works end-to-end + the architectural argument lands + a write-up + an OSS release," not "every bench task separates." We have a defensible piece of the second criterion (T03 + honest gap docs) and zero of the third and fourth. Continuing to chase noisy bench rounds spends time and trust without moving any of the four bars. Memory entry `feedback-reproduce-before-rerunning.md` was added separately to encode the "reproduce before re-running" discipline so this specific failure mode doesn't recur.

**Design-doc impact:** none yet — `strata-design.md` § Build phases already names Phase 5 (write-up + OSS release) as the terminal phase; the roadmap is the operational version of that. If iteration 2 lands new tools, update § Tool set to mark them implemented.

**Revisit when:** an iteration deliverable shifts the picture (e.g., `extract_function` lands and bench evidence shows it wins a different-class task), or a write-up reviewer surfaces something the bench would need to re-examine.

---



**Context:** A non-authoritative `packages/lab` arc (probes 6-9, Codex xhigh review, N=5 honest + N=6 trap keyed trials at ~$2.5 sandbox spend; full record in `packages/lab/LAB-NOTES.md` entry of the same date) tested whether a structurally-different per-callsite-expressiveness lever shape could close the contamination channel the 2026-05-17 TERMINAL entry identified. The sandbox arc isn't authoritative and isn't being graduated; the one durable design principle that fell out of it is.

**Considered:**
- (a) bare-string per_scope value slot (the original `applyPerScopeAddParameter` shape) — probe6 + the prior 2026-05-17 keyed evidence: scripting vector. Agent types prompt literals straight into the slot.
- (b) `{expr, importFrom}` object shape — probe6: NOT a structural close. Attacker passes `{expr:'"UTC"', importFrom:"./config.ts"}`; IDENT_PATTERN refuses to inject an import for a non-identifier expr, but the renderer still splices the literal verbatim.
- (c) corpus-grep post-hoc contamination scorer — probe7: structural hole. Trap's prompt-only literals "UTC"/"local" are also corpus ZONE values, so `foundInCorpus=true` for both honest and scripting renders. Can't distinguish source-of-value when corpus and prompt happen to share literals.
- (d) `{nodeRef: NodeId}` shape (probe8 + the extracted lab experiment): op resolves the nodeRef to its bound IDENTIFIER NAME via the graph and uses that name as the callsite arg. The agent cannot pass a string. Exhaustive graph scan finds zero nodes whose identifier-name is "UTC" or "local" — those are string values inside declarations, not identifier names. Structurally trap-resistant.

**Decided (forward-looking design constraint, not a code change):** If a future authoritative Strata tool adds per-callsite expressiveness to `add_parameter` (or to any structural mutation that fans out distinct values to multiple callsites), the value channel must accept graph-node references, not strings or string-bearing object variants. The agent must POINT AT a declaration the substrate can resolve; the substrate must extract the value from the graph; the agent must never get to TYPE the value.

**Why:** Any string-bearing slot is a prompt-scripting vector by construction — the contamination integrity rule cannot distinguish "agent derived this from code" from "agent transcribed this from the prompt" once the substrate accepts a string. The 2026-05-17 TERMINAL entry's NARROW claim — "per-scope tools accepting arbitrary strings are scripting vectors" — stands. Its broader generalization ("any per-callsite expressiveness tool is integrity-un-closeable") was overshot; nodeRef-only is the existence proof that the lever class admits an honest shape. The principle "structural value channels take graph-node references" is the precise design constraint that distinguishes them.

**Design-doc impact:** none yet. `strata-design.md` does not currently propose any per-callsite-expressiveness tools; this entry is the constraint to apply if/when one is proposed. The corresponding sandbox bundle (`packages/lab/src/experiments/nodeRefAddParameter.ts`) is non-authoritative scaffolding that demonstrates the principle but does not graduate as-is — the discipline gate that complements it (op-log: exactly one AddParameter; ReplaceBody only on the param-target) is a task-specific sandbox sledgehammer and would need redesign for any other task before graduation.

**Revisit when:** an authoritative tool design proposes per-callsite expressiveness, OR the sandbox bundle is taken into the rigid pre-registered keyed pipeline for graduation, OR the sandbox arc is extended to a different multi-step task and the principle is tested for generality.

: one additive, default-preserving session injection point (`toolServerFactory`/`canUseTool`/`runAgentLab`); `SessionStartEvent.task` widened to `string`; sole sanctioned canonical touch for the exploration-sandbox effort

**Context:** `docs/superpowers/specs/2026-05-17-multi-step-exploration-sandbox-design.md` calls for a non-authoritative sandbox (`packages/lab`, forthcoming) to iterate on new multi-step methods without polluting the rigid, pre-registered, keyed framework. Landing any sandbox infrastructure required a minimal injection point in the canonical `@strata/agent` package. The seam work spans four commits: acceptance lift (`9477302`), review polish (`e616525`), seam + log widening (`a744b7f`), test nit (`97dcc8a`).

**Considered:** (a) duplicate the agent loop in `packages/lab` — rejected on integrity grounds (a duplicated loop makes any graduated lab result non-comparable to the canonical path; even a one-line drift could silently change behavior); (b) add optional params to `RunAgentT03Params` and re-use the same private `runAgentForPrompt` — the only option that keeps the comparison honest.

**Decided:**
- Two optional params added to `RunAgentT03Params`: `toolServerFactory` (overrides the default single-MCP-server construction) and `canUseTool` (per-turn tool filter). Absent both, `server`/`options`/`ctx` construction is byte-identical to before — zero behavioral change on the existing call sites.
- `acceptance` computation (criteria scoring) lifted from inside `runAgentForPrompt` into its two callers (`runAgentT03`, `runAgentLab`) — behavior-preserving refactor required to give each caller ownership of its own scorer.
- New exported `runAgentLab` delegates to the same private `runAgentForPrompt` loop. No duplication of the loop; the two entry points share a single code path.
- `SessionStartEvent.task` in `packages/agent/src/log.ts` widened from `"T01" | "T03" | "T05" | "T08"` to `string`. This removes a cast that would otherwise lie when a `lab:*` label is written to the operation log. `task` consumers verified: `report.ts` already typed it `string`; `runner.ts` writes a `BenchTaskId` constant — neither regresses.

**Gate passed:** additive + default-preserving (verified: absent the optional fields the generated `server`/`options`/`ctx` values are byte-identical). `@strata/agent` tests: **33 passed | 2 skipped** (35 total) — up from 31 passed | 2 skipped before the seam; the two new tests are the `labSeam` guard tests that assert the injection point works and that the pre-existing T03 replay still scores all criteria correctly. All other canonical test counts unchanged. `pnpm -r build` and `pnpm -r test` green. Spec-compliance and code-quality subagent reviews passed (approved-with-minor; minors fixed in the review-polish commit).

**Why:** The sandbox's entire value proposition depends on results being comparable to the canonical substrate runs. A duplicate loop would undermine that; a byte-identical default path provably does not. The `task` widening is honest hygiene — a narrow union that must be cast to accept `lab:*` labels would silently mis-record the operation log and confuse any future reader.

**Design-doc impact:** none to `strata-design.md` (per CLAUDE.md the contract is not silently rewritten; the sandbox's purpose and limits are documented in the spec). This entry is the authoritative record of the infra change. The sandbox itself (`packages/lab`) and its results are explicitly **non-authoritative** and never feed `RESULTS.md` or `decisions.md` unless a method graduates through the existing rigid pre-registered keyed pipeline.

**Revisit when:** a graduated lab method needs net-new tool *names* visible to the hermetic `assertOnlyStrataTools` guard (its own decision/entry); or a `SessionStartEvent.task` consumer needs the old narrow type (none today — verified above).

## 2026-05-17 — Full multi-agent design of the expressiveness lever → STOP: T01 is a scripting trap *by scorer construction*; the deferred different-class lever is integrity-un-closeable. Terminal.

**Context:** Per the user's "go all out with multiple agents," the `add_parameter` per-callsite-expressiveness lever was taken into a full parallel design: four independent Opus design agents (Facet 1 API/semantics; Facet 2 store/tx + overlap gate; Facet 3 scorer-integrity + single-variable pre-registration; Facet 4 adversarial/blind-spot), on top of the prior independent Codex (gpt-5.5 xhigh) review. Facets 1–3 produced concrete, internally-sound designs (a node-id-keyed `callsite_value_overrides`; the `queueTextSpanEdit` chokepoint gate with a verified T08 two-`replace_body` regression risk; a clean DA-1..DA-5 single-variable pre-registration). The adversarial pass + a direct re-verification overrode them.

**Integrity-dispositive finding (verified against code, not taken on faith — per the codified review discipline):** `uiCallsitesLocalOrDefault` in `packages/verify/src/t01Criteria.ts` is `/formatTimestamp\(\s*0\s*,\s*"local"\s*\)/`. The literal `"local"` **appears nowhere in `examples/medium`** — `ui/timeline.ts` is `return timelineRows(times)[0] ?? formatTimestamp(0);`; nothing in the codebase implies it. `"local"` exists **only in `T01_PROMPT`** ("callsites under `src/ui/` should pass `"local"`"). Therefore any mechanism that makes T01 pass must route a prompt-only literal to one specific callsite — i.e. the agent transcribes the prompt's `(path-prefix → literal)` policy into the tool (an **uninterpretable / contaminated win** — cannot distinguish "substrate capability worked" from "agent typed the prompt's answer into a slot," the AP-4 contamination concern realized structurally), or the tool hardcodes it (overt scripting). **T01 is not honestly satisfiable by any non-scripting structural lever — by scorer construction, not by lever shape.**

**Why the specific lever also fails independently of the above:** (1) **Decision-surface relocation, not removal.** `rename_symbol` wins because the substrate owns 100% of scoping and the agent owns one scalar (zero residual decisions). `callsite_value_overrides` requires ~6 discrete agent decisions plus an N-fold `get_references`→`read_node` ancestor-walk to build the module partition — the failure-inducing surface is moved from "hand-patch the callsite" to "construct a correct scoped policy," not eliminated. Necessary-but-insufficient by the unifying theory's own logic. (2) **Legibility-falsification echo.** AP-2/AP-3 proved the agent ignores a delivered audit-proof manifest and hand-patches anyway; an optional param the agent must *discover, elect, and self-construct correctly first try* is the same "choose the structural path over the body-edit prior" the four levers falsified — predicted-ignored, ~50% mass on reproducing the exact `oldText mismatch at [52,110)` thrash. (3) **files-not-first-class violated in substance.** Module-node payloads *are* the POSIX path strings (`nodes.ts`); correct use requires the agent to read those payloads and cognitively prefix-partition `src/server/`/`src/ui/` — the invariant honored only in the type signature. (4) **Failure-legibility regression.** A mis-partition is type-clean, so `validate`(tsc) passes; the loud diagnosable `oldText` thrash becomes a silent confident-wrong commit only the behavioral gate catches.

**Independent probability estimate (adversarial agent, consistent with the four-falsified-levers prior): ~10–15% that the lever moves T01 to ≥2/3 — and even that tail is integrity-contaminated** (no observable distinguishes a real capability win from prompt transcription). Spending a keyed round would, at best, reproduce AP-2 with a new silent-wrong flail mode.

**Decision:** Do **not** spec or build the expressiveness lever (or the escape-hatch removal, or the gate-as-T01-fix). The deferred different-class lever for T01 is **closed as integrity-un-closeable**. The expressiveness gap (2026-05-17 prior entry) is real and correctly diagnosed, but closing it for T01 specifically requires either scripting or a *benchmark/task redesign* (e.g. a T01 variant whose per-scope value is structurally derivable from the codebase rather than stated only in the prompt — a genuine `rename_symbol`-class task). Redesigning a failing benchmark task until the substrate passes is itself integrity-fraught and is **not** in honest scope for closing T01; it is, at most, a *future* research direction for measuring multi-step generalization with a non-scripting task — new research, not this result.

**Net effect on the thesis — this STRENGTHENS the terminal conclusion.** The bounded negative is now even more precisely characterized: not merely "four falsified levers," but "the obvious fifth (per-callsite expressiveness) is, for T01, un-closeable by any honest structural lever because T01's scorer requires a prompt-only literal at a specific site — the multi-step task as specified is a scripting trap, and `rename_symbol`'s robust win is precisely the class of task (substrate owns 100% of resolution; agent owns one scalar; value structurally derivable) that the file-abstraction removal helps, while T01 is structurally the opposite class." This is the deepest, cleanest statement of where the substrate advantage does and does not hold.

**Design-doc impact:** none to `strata-design.md`. RESULTS.md updated to fold this sharpening into the bounded-negative section. The methodology functioned exactly as intended: a full multi-agent design + independent review + adversarial pass + direct verification refused to manufacture a spec for an integrity-disqualified lever and produced a sharper honest result instead.

**Revisit when:** someone deliberately designs a *new* multi-step benchmark task whose per-scope behavior is structurally derivable (no prompt-only literals), to test multi-step generalization honestly — its own spec/decision cycle, explicitly NOT a continuation of T01.

## 2026-05-17 — Deferred-lever design analysis: T01 is unsatisfiable by `add_parameter` alone *by construction* — the real lever is per-callsite argument expressiveness, not the escape hatch (independent Codex review)

**Context:** Re-opening the deferred different-class lever (per the "Research concluded" entry's "Revisit when"). Brainstorming explored: (A) a deterministic pre-tool-use overlap gate; (B) client-side programmatic/atomic orchestration; and a new idea — replace the general `replace_body` escape hatch with a minimal narrow body-op surface. An independent expert review was commissioned: **Codex CLI, `gpt-5.5`, reasoning `xhigh`, read-only, repo-grounded** (it independently explored beyond the seeded files and ran a live `tsc` probe). Its verdict was then **verified against the actual criteria/code before being accepted** (the discipline: do not take a pivotal empirical claim on faith).

**Verified finding (decision-grade, changes the framing of the whole arc):** T01 cannot be satisfied by `add_parameter` alone.
- `T01_PROMPT` requires `src/server/` callsites to pass `"UTC"` and `src/ui/` callsites to pass `"local"`.
- `evaluateT01TextCriteria` (`packages/verify/src/t01Criteria.ts`) is authoritative: `serverCallsitesUtc` (both `server/events.ts` calls get `, "UTC"`), `uiCallsitesLocalOrDefault` = `/formatTimestamp\(\s*0\s*,\s*"local"\s*\)/` (the UI callsite MUST become `formatTimestamp(0, "local")`, explicitly **not** `"UTC"`/default), `hofCallsiteNotMisedited` (`times.map(formatTimestamp)` untouched).
- `add_parameter` (`packages/store/src/addParameter.ts`): `const slotValue = defaultValue ?? "undefined"` is inserted at **every** resolved direct callsite — a single uniform value. No invocation can emit `"UTC"` at server and `"local"` at UI.

**Reframing:** the agent's post-`add_parameter` `replace_body` on the UI callsite is **not (purely) compulsive misbehavior — it is the agent correctly attempting the per-callsite differentiation T01 requires**, with the only available tool, colliding with `add_parameter`'s own queued overlay edit on that statement. Therefore:
1. The deterministic overlap gate (A), **alone, is an honest-negative-by-construction for T01**: it would stop the corruption but block the *legitimately required* UI-callsite edit → T01 still fails (cleanly, not via thrash). Established *before* any keyed spend — the purpose of the verification.
2. The substantive T01-passing lever is an **expressiveness extension to `add_parameter`** (per-callsite / per-scope argument values as a structural operation), so the differentiation T01 demands is expressible without a second overlapping edit. The gate is **necessary-not-sufficient**: still valuable as the single-variable *mechanism probe* and a legibility/safety net, but not the lever that makes T01 pass.
3. The deepest root cause of the entire four-falsified-levers arc is an **`add_parameter` expressiveness gap** (uniform single default; no per-scope value policy) intersecting the corruptible escape hatch. The prior four levers all attacked "the agent shouldn't redo callsites," but the agent *had* to touch the UI callsite and no structural op could express it.

**Codex-grounded design constraints adopted (verified plausible):** (a) a deterministic gate must live at/under `queueTextSpanEdit` in `packages/store/src/transactions.ts` — the single chokepoint both the live and replay (`session.ts:runStep`) paths traverse — not in SDK `canUseTool` (live-only) → replay-deterministic by construction; (b) composition rule: reject **overlapping** base-coordinate spans but **allow disjoint same-statement edits** (T08's `change_return_type` + body edits on the same function are disjoint and must stay allowed — a naive "any second edit on a touched statement" gate would regress T08); (c) scorer-staleness trap: `evaluateT05Criteria` checks for the `ReplaceBody` operation-row kind, so replacing the body-op kind would falsely fail T05 (currently 3/3) — body-op-replacement carries materially higher regression risk (Codex est. T05 20–35%, T08 35–60%; gate-only <10%) and is *not* the right primary lever.

**Decision:** do **not** pursue "replace `replace_body`" as the primary lever (insufficient — still a foot-gun via arbitrary expression text — and dangerous to the T05 scorer). The honest next design is: **extend `add_parameter` with per-callsite/per-scope argument expressiveness** (the substantive lever), with the store-level overlap gate as a complementary, independently-pre-registerable mechanism probe. Each remains its own single-variable, pre-registered, keyed-validated cycle; not bundled (attribution discipline). No code written; no keyed round run — this is pre-design analysis that the verification materially redirected.

**Design-doc impact:** none to `strata-design.md`. This is the authoritative record of why the obvious lever (gate / escape-hatch removal) is necessary-not-sufficient and what the real lever is. RESULTS.md left unchanged (no measured result; mid-exploration of a deferred lever).

**Revisit when:** the `add_parameter` per-callsite-expressiveness lever is taken into a full brainstorm→spec→plan→TDD→pre-registered-keyed-validation cycle (its own entry), or the gate is pre-registered as a standalone mechanism probe.

## 2026-05-17 — Research concluded (deliberate terminal point, not abandonment)

**Context:** After the AP round (entry below) the T01 boundary is exhaustively characterized by four independent, pre-registered, transcript-classified, falsified levers (prompt/description tuning, the commit gate, model capability, tool-result legibility), with the atomic-edit win (T03) robust, replicated and model-independent throughout. The operator elected to conclude the research here rather than open a new, different-class arc.

**Considered:** (a) take on a deeper different-class lever (remove the `replace_body` escape hatch / agent-loop redesign forbidding re-edit of a tool-touched span) — a new research project, not a continuation; (b) cheap loose ends (optional fresh N=3 confirming T08 beyond the 3 audited transcripts; retiring brittle text-criteria proxies); (c) declare the research complete and close out the write-up.

**Decided:** (c). The research question is answered with claim-grade rigor and the negative is precisely bounded, not vague — that *is* the result. Continuing would be scope expansion into a new arc the bounded negative does not require; the four falsified levers are terminal for the legibility/prompt/model/gate class. RESULTS.md, README, and this decision trail brought into coherence with the terminal state (status → "research concluded 2026-05-17"; bottom line rewritten to the proven-win / partial-gate-enabled-generalization / four-falsified-levers synthesis; stale "pending keyed measurement" framing removed). `strata-design.md` deliberately NOT edited (per CLAUDE.md the contract is not silently rewritten to match; the conclusion lives in RESULTS.md/decisions.md).

**Why:** The project set out to produce "a proven win, a precisely-bounded scope, a boundary diagnosed to a named cause, and falsified easy answers, under adversarial self-scrutiny." All four exist and are honestly recorded. A clean terminal point reached deliberately is itself a result; manufacturing further iteration would dilute, not strengthen, it.

**Design-doc impact:** none. Closes the build/measure arc; `decisions.md` remains the authoritative trail.

**Revisit when:** someone takes up the deferred different-class lever (a) or loose ends (b) as a new effort — each its own spec/decision cycle. The one artifact not producible here — the 5–10 min demo video (`strata-design.md` § Phase 5) — is left for a human; that is the sole outstanding Phase-5 deliverable.

## 2026-05-17 — `add_parameter` legibility keyed validation: AP-2 NEGATIVE, AP-3 mechanism unchanged — tool-RESULT legibility is insufficient; the T01 boundary is now exhaustively characterized (4 falsified levers)

**Context:** The frozen pre-registered keyed round (`docs/superpowers/specs/2026-05-17-add-parameter-legibility-probe-prereg.md`, commit `70a07eb`, AP-1..AP-4), run from a branch whose code == `main` @ `643e953` (the merged manifest implementation): `pnpm --filter @strata/bench bench -- --trials=3 --tasks=T01,T03 --keep-artifacts`, `claude-sonnet-4-6`, N=3, **round cost $2.86**. Single changed variable vs. all prior T01 rounds: `add_parameter` now returns/surfaces the itemized `AddParameterManifest`; the tool description was held byte-identical (control). Classified from the 6 persisted substrate transcripts per the frozen pre-reg. Artifact: `packages/bench/results/phase15-four-task-2026-05-17T04-48-01-533Z.{json,md}`.

**Classification against the frozen AP-1..AP-4:**
- **AP-1 (T03 regression guard) — PASS, 3/3.** Every T03 substrate trial is the canonical single clean rename (`find_declarations → get_references → begin_transaction → rename_symbol → validate → commit_transaction`, 6–7 tools, 998–1065 tok, 0 retries, success+opRow 3/3), disjoint from baseline (≤1065 vs ≥4154 tok; 6–7 vs 22–24 tools). The `add_parameter`-return-only change did not couple into the proven rename (T03 never calls `add_parameter`). The T01 read is valid; no STOP.
- **AP-2 (does the manifest move T01) — the pre-committed NEGATIVE.** T01 substrate **0/3**, **operationRowAppended 0/3** — never a correct committed change. Per the frozen AP-2 rule this is the honest, valid logged negative: a believable itemized manifest of the tool's own edits did **not** move T01. Not a retry trigger.
- **AP-3 (mechanism — the real readout regardless of AP-2) — UNCHANGED.** Every T01 trial reproduces the *identical* diagnosed thrash: ~16 `read_node` exploration → `begin_transaction → add_parameter → replace_body ×3 → validate✗ → rollback_transaction → begin_transaction → add_parameter → replace_body …`, every `validate✗` the exact `oldText mismatch at [52,110): expected "{ return timelineRows(times)[0] ?? formatTimestamp(0); }"` collision (the agent hand-patches the very callsite `add_parameter` already queued). The manifest **was delivered** — the `add_parameter` `result_summary` carries the full `{declaration:{beforeSignature,afterSignature}, callsitesRewritten:…}` — and the agent **ignored the verifiable evidence and hand-patched callsites with `replace_body` regardless**, byte-same mechanism as pre-manifest sonnet (2026-05-16 N=3) and Opus (2026-05-17 probe). Each trial then terminated **confident-wrong** ("Both transactions committed and tests pass") while the bar shows 0/3 (the `tsc/vitest 3/3` is the known scorer-on-non-converged-run artifact; `success`/`operationRowAppended` 0/3 are the truthful signals).
- **AP-4 (no scripting / contamination) — clean.** The `result_summary` is exactly the itemized manifest (declaration + the tool's own callsite edits + arity-risk sites): no task hints, no directive prose. The description was byte-constant (verified: code == 643e953, the merged control). The negative is honest — the agent had concrete, verifiable proof the callsites were already done and chose to re-edit them anyway.

**Conclusion:** Tool-**result** legibility (a faithful, itemized, audit-proof manifest of exactly what `add_parameter` did) is **insufficient** to stop the agent hand-patching callsites — exactly as tool-**description** legibility was falsified (2026-05-15 BS-P-B). The T01 multi-step failure is therefore **not a communication/legibility problem**: given concrete evidence the callsites are complete, the agent compulsively re-does them with `replace_body` and corrupts the transaction. The boundary is now **exhaustively characterized by four independent, pre-registered, transcript-classified, falsified levers**: (1) prompt/description tuning (BS-P-B terminal), (2) the commit gate (built, validated, not T01's lever), (3) model capability (Opus single-variable probe, MP-2=L2), (4) tool-result legibility (this round, AP-2 negative / AP-3 unchanged). Across all four, the atomic-edit win (T03 rename) stayed robust, replicated, and model-independent. This is a precisely-bounded negative, not a vague one — a strong result for the write-up: removing the file abstraction is a real, robust efficiency win for atomic structural edits and does **not** generalize to this multi-step refactor, and the gap is now shown un-closeable by prompt, gate, model, or tool legibility.

**Design-doc impact:** none to architecture. Sharpens `strata-design.md`'s thesis boundary: the substrate efficiency claim is demonstrated for atomic operations and the multi-step generalization gap is now exhaustively bounded (four falsified levers), not merely observed. RESULTS.md updated.

**Revisit when:** a fundamentally different lever is proposed (e.g. removing/!replacing the `replace_body` escape hatch so the agent *cannot* hand-patch — a tool-surface/affordance change, not a legibility one; or an agent-loop redesign that detects and forbids re-editing a tool-touched span). Not by another legibility/prompt/model pass — those four are terminal. Most honestly: this is a clean point to write up the precisely-bounded result rather than continue iterating.

## 2026-05-17 — T01 stronger-model probe: L2 confirmed — `add_parameter` tool-illegibility, NOT a model-capability ceiling (MP-1 PASS, MP-2 = L2, MP-3 same mechanism)

**Context:** The frozen pre-registered probe (`docs/superpowers/specs/2026-05-16-t01-stronger-model-probe-prereg.md`, commit `704c035`, MP-1..MP-3) re-run on the harness-fixed `main` (`39f28ee`): `--trials=2 --tasks=T01,T03 --model=claude-opus-4-7 --keep-artifacts`, N=2, **round cost $3.70** (the first attempt crashed on the now-fixed SDK max-turns gap and produced no data; this run completed and wrote `packages/bench/results/phase15-four-task-2026-05-17T00-29-06-119Z.{json,md}`). Only the model changed (sonnet-4-6 → opus-4-7); tools/prompt/harness/budgets held fixed. Classified from the persisted transcripts per the frozen pre-reg.

**Classification against the frozen MP-1..MP-3:**
- **MP-1 (T03 guard under the swapped model) — PASS.** Both T03 substrate trials are the canonical single clean rename (`find_declarations → get_references → begin_transaction → rename_symbol → validate → commit_transaction`, 6 tools, 879/907 tok, 0 retries, success 2/2, opRow 2/2). The model swap does not distort T03 → the T01 read is **valid, not confounded**.
- **MP-2 (L1 vs L2) — L2.** T01 substrate **0/2**, **operationRowAppended 0/2** (JSON authoritative: trial1 `error_max_turns`/opRow false; trial2 `success` terminal but opRow false, two `commit{ok:true}` on non-correct/partial transactions — never a correct T01 change). Per the pre-committed MP-2 rule, a stronger model failing both by never reaching a correct committed change ⇒ **the failure is tool-design (`add_parameter` illegibility, L2), not a model-capability ceiling**. Both MP-2 outcomes were pre-registered, so this is not post-hoc.
- **MP-3 (mechanism) — SAME mechanism, conclusively.** Every Opus T01 trial reproduces the *identical* diagnosed thrash: heavy `read_node` exploration → `begin_transaction → add_parameter → … → replace_body → replace_body → validate✗ → rollback_transaction → begin_transaction → …`, with every `validate✗` the exact `oldText mismatch at [52,110): expected "{ return timelineRows(times)[0] ?? formatTimestamp(0); }"` collision — the agent hand-patches a callsite `add_parameter` already rewrote, so the overlay text no longer matches. 3–4 `validate✗` and multiple rollback→begin cycles per trial, never converging. Not a new failure mode (MP-3's "different mechanism" branch did not fire). Opus explores *more* (14–16 `read_node`) but mis-uses `add_parameter` exactly as sonnet did.

**Conclusion:** With prompt-tuning falsified (2026-05-15 BS-P-B terminal), the commit gate closed (gate-scope validation), and now **model-capability ruled out** by a fair single-variable probe at the strongest available model, T01's failure is decisively isolated to **`add_parameter` tool-illegibility**. The one remaining lever is unambiguously a **`add_parameter` tool-legibility redesign** (its own brainstorm→spec→plan→TDD→pre-registered-keyed-validation cycle). Not a stronger model, not prompt, not the gate.

**Bonus observation (not a pre-registered signal — recorded as observational, not a claim):** the Opus *file-tools baseline* hit `error_max_turns` on **T03** (the rename; 2/2, 25 tools) where the substrate completed it in **6 tools / ~893 tok**. On the atomic structural edit the substrate advantage is, if anything, *amplified* under a stronger model, while T01 fails for both configs. Sharpens the thesis: the file-abstraction win on atomic edits is robust and model-independent (plausibly larger with stronger models); the T01 gap is a specific tool-design defect, not the substrate concept and not model capability. (N=2, indicative, not a significance claim.)

**Design-doc impact:** none to architecture. Resolves the roadmap fork: the deferred T01 lever is now positively identified (tool-design, L2). RESULTS.md updated.

**Revisit when:** the `add_parameter` legibility redesign is taken up as its own spec/decision cycle; or a future model materially beyond opus-4-7 is evaluated (the probe bounds capability at the strongest model available 2026-05-17, not for all time).

## 2026-05-16 — Third installed-SDK gap: agent SDK THROWS `maxTurns` (doesn't yield a result subtype) → harness now classifies it gracefully on both session paths

**Context:** The T01 stronger-model probe (pre-reg `704c035`, MP-1..MP-3) was launched with `--model=claude-opus-4-7`. It **crashed** (exit 1, no artifact, all trials incl. the T03 guard lost) on `Error: Claude Code returned an error result: Reached maximum number of turns (40)`. systematic-debugging (root-cause first, no blind retry) was applied; the probe produced **no L1/L2 data** — MP-1..MP-3 remain frozen and unexercised for a later valid run.

**Root cause:** `@anthropic-ai/claude-agent-sdk@0.2.118` signals the `maxTurns` budget by **throwing** `Reached maximum number of turns (N)`, NOT by yielding a `result` message with `subtype:"error_max_turns"`. The harness *defines* `error_max_turns` as a `TerminalReason` and `terminalFromResultSubtype`/`terminalFromSubtype` map that subtype — i.e. it only handled the *yielded-result* path, which the installed SDK never takes for max-turns. The substrate live loop's catch (`session.ts`) re-threw any non-abort error; the baseline collector (`collectBaselineSession`) had no catch at all. `claude-sonnet-4-6` never exposed this because T01 always tripped the 420 s wall-time abort (gracefully → `error_wall_time`) *before* the 40-turn ceiling; `claude-opus-4-7` reached 40 turns first. This is the **third documented installed-SDK-vs-expected gap** (cf. the two Phase-3 gaps) — a latent harness-robustness defect the model swap surfaced, not a T01 result.

**Decision:** Added one shared, exported, pure classifier `classifySessionError(caught, aborted) → { terminal, rethrow }` in `@strata/agent` (return type narrowed to its true codomain `error_max_turns | error_wall_time | error_other`, so it is assignable to both packages' `TerminalReason`). Both session paths now use it: substrate `runLiveSession`'s catch, and `collectBaselineSession` (new try/catch, abort signal threaded from `baseline.ts`). Semantics: a wall-time abort → `error_wall_time` (unchanged); the SDK max-turns throw → `error_max_turns` (now graceful, recorded, **not re-thrown**); anything else → `error_other` + **rethrow (still fails loud)**. 9 new key-free TDD tests (6 `sessionError`, 3 `collectBaselineSession` throw/abort/genuine), independent review of the substrate change ("Approved; regression-safety holds; no scoring impact") which also flagged the symmetric baseline gap — now closed here.

**Integrity / scope:** Pure harness-robustness; cannot bias scoring (`success` is criteria-driven; this only converts a process-crash into a pre-existing non-success `TerminalReason`). Prior results unaffected: sonnet rounds trip wall-time first (still `error_wall_time`); the merged gate/T08 work never touches this path. BG-3 intact: only `@strata/agent` (24→30) and `@strata/bench` (48→51) gained tests, all other packages byte-identical, 0 failures, 8/8 build clean.

**Design-doc impact:** none to architecture; records a third installed-SDK behavior gap and the harness hardening. The probe's L1/L2 question is **still open** — to be answered by a valid Opus re-run against the frozen MP-1..MP-3, logged as its own newest-first entry.

**Revisit when:** a future SDK version changes the max-turns signaling (re-confirm the message match), or another caller consumes a live `query()` loop without routing its catch through `classifySessionError`.

## 2026-05-16 — T08 HN-2 root-caused: scorer artifact, not behavioral variance — `callersTypecheckUnderNarrowType` corrected (T08 N=3 = 3/3 on the same data)

**Context:** Investigation #1 from the N=3 entry's "Revisit when" — characterize the T08 HN-2 = 2/3. Systematic-debugging (read-only root-cause first, no result-chasing). The anomaly: all three T08 N=3 substrate trials were process-identical (single transaction `change_return_type → replace_body ×2 → validate → commit{ok:true}`, tsc-clean, vitest-passing, committed, contamination-free) yet trial-1 scored `success=false`, trials 2/3 `true`.

**Root cause (transcript- + code-verified):** `evaluateT08TextCriteria.callersTypecheckUnderNarrowType` scanned the **whole `permissions.ts`** for the substrings `role === "admin"` / `role === "editor"` as a proxy for "the caller (`describeRole`) consumes the narrowed return type type-safely." All three agents legitimately rewrote `describeRole` as an exhaustive `switch (role) { case "admin": … }` (valid, tsc-clean, arguably better than the seed's `if`-chain). That form contains no `role === "x"` substring, so the criterion was **simultaneously**: (i) **over-strict** — it rejected the valid `switch` caller (false negative → trial-1 spuriously failed); and (ii) **unsound** — trials 2/3 passed only because their `getRole` *body* coincidentally contained `role === "admin"`/`"editor"`, i.e. it scored an unrelated function, not the caller (false positive → passed for the wrong reason). Hypothesis (b) (agent subtly wrong) was refuted: the gate already proved all three tsc-clean + vitest-passing + committed + uncontaminated.

**Decision:** Corrected `callersTypecheckUnderNarrowType` to express its stated intent: scope it to the `describeRole` region (declaration→EOF, the structural caller location — the corpus has exactly one caller, last in module) and accept any type-safe discrimination form — `role === "x"` **or** `case "x":` — keeping the no-`as`-cast clean-bind requirement, scoped to that region. New `describeRoleRegion` helper + 2 TDD tests (switch-form accepted; coincidental-cross-function match rejected). `evaluateT08Criteria` already delegates to `evaluateT08TextCriteria`, so the rendered-store path and BS15-C consistency invariant flow through unchanged.

**Integrity safeguards (this changes a published benchmark number — 2/3→3/3):**
- **Justified by measurement-correctness independent of outcome:** the corrected criterion is *stricter* where it was unsound (rejects a clean-bind-but-no-discrimination caller, and the decisive false-positive class where `role === "x"` lives only in `getRole`) and *more lenient* where it was over-strict (accepts `switch`). Proven by the 2 new unit tests + an adversarial battery (7 cases) in an independent opus audit.
- **Deterministic re-score (zero API spend, criterion is the only changed variable):** reconstructing the 3 N=3 trial renders from their transcripts, the OLD criterion reproduces the recorded **2/3 exactly** (faithful), the NEW yields **3/3** — and trials 2/3 now pass via the describeRole `switch` (the legitimate reason), not the coincidental `getRole` substring (verified by dumping the scanned region).
- **Independent integrity audit (opus subagent):** verdict "LEGITIMATE measurement-correctness fix, sound, not gerrymandered" — scoping is a generic structural location not a transcript fingerprint; rejects every genuinely-wrong caller tested.
- BG-3 intact: `pnpm -r test` = `@strata/verify` 40→42 (+2 new T08 tests), every other package byte-identical, 0 failures, 8/8 build clean.

**Honest caveats (recorded; pre-existing text-scanner limits, not introduced or worsened, not triggered by any trial):** (1) a comment containing `if (role === "admin")`/`case "admin":` inside `describeRole` would false-positive — identical under old and new code; (2) the criterion scores *type-safe consumption*, not behavioral label-correctness (a label-swapped switch would pass `callersTypecheckUnderNarrowType`) — consistent with its stated intent; behavioral correctness is scored separately by the vitest gate.

**Net:** T08's true behavioral pass rate at N=3 is **3/3**, not 2/3; the recorded 2/3 was a scorer artifact, now corrected. This supersedes the HN-2 = "2/3 noted variance" classification in the entry below: with the corrected, audited criterion the N=3 hardening is **T03 3/3, T05 3/3, T08 3/3, T01 0/3 (isolated non-gate lever)**.

**Design-doc impact:** none to architecture; corrects a Phase-1.5 text-criterion proxy. RESULTS.md updated.

**Revisit when:** a fresh keyed N=3 (new agent samples) is run to confirm T08 3/3 generalizes beyond these three transcripts (the deterministic re-score settles the *criterion*, not new-sample variance); or the broader "retire brittle text proxies in favor of the validated behavioral-gate signal" question (option C, deferred) is taken up as its own spec.

## 2026-05-16 — N=3 hardening: HN-1 PASS (T03 flagship replicates on valid harness), HN-3/HN-4 PASS, HN-2 = 2/3 (honest noted variance); no bail STOP

**Context:** The N=3 hardening round, pre-registered tamper-evidently in `docs/superpowers/specs/2026-05-16-n3-hardening-prereg.md` (commit `a40f9c1`) BEFORE launch, run on `feat/gate-scope-redesign`, `pnpm --filter @strata/bench bench -- --trials=3 --tasks=T01,T05,T08,T03 --keep-artifacts`, `claude-sonnet-4-6`, N=3, 24 live runs, **round cost $3.82**. Classified from the 12 persisted substrate transcripts (`*-2026-05-16T21-1[4-9]/2[0-9]/3[0-9]/4[0-9]/5[0-9]*.jsonl`), per the frozen pre-reg. Artifact: `packages/bench/results/phase15-four-task-2026-05-16T21-54-44-125Z.{json,md}`.

**Classification against the frozen HN-1..HN-4:**

- **HN-1 (T03 regression guard — HARD STOP): PASS, 3/3.** Every T03 trial is the canonical single clean rename transaction (`find_declarations → get_references [→ read_node] → begin_transaction → rename_symbol → validate → commit_transaction`), **1 transaction, 0 `replace_body`, commit `{ok:true}` first try**, raw tokens `[1066,1020,1054]`, **7 tools every trial**, 22–25 s, **0 retries every trial** — disjoint from baseline (substrate max 1066 tok ≪ baseline min 3825; 7 tools ≪ baseline 23–35). The hard STOP does **not** trigger. **The project's flagship proven win is replicated again, at N=3, on the now-valid (BG-4-fixed) harness** — the strongest evidence yet that the gate-scope fix preserved it.
- **HN-3 (T05 gate-driven success replicates): PASS, 3/3.** Every T05 trial shows the designed mechanism: an initial empty/no-op `begin_transaction → … → commit_transaction` is **rejected by the scoped gate with T05's OWN `dateRange.test.ts` fail-before signal**, which drives a real `begin_transaction → replace_body → validate → commit_transaction{ok:true}` → success. ≥2/3 was the bar; 3/3 observed — robustly real. **Honest caveat (on the record):** T05 is a *correctness* success but an *efficiency loss* vs the file baseline — substrate ≈ 6535 tok / 21 tools / 128 s mean vs baseline ≈ 796 tok / 5 tools / 17 s (token distributions separated the *wrong* way). The gate rescues T05's correctness; it does not make T05 efficient.
- **HN-4 (T01 stays isolated to a non-gate lever): PASS, 0/3 isolated.** All three T01 trials fail via the diagnosed `add_parameter`/manual-`replace_body` collision thrash — every trial hits `validate✗ oldText mismatch at [52,110)` (the agent hand-patches a callsite `add_parameter` already rewrote, so the overlay text no longer matches), with 36–47 tool calls; 1 trial wall-aborted, 2 ran to near-budget without ever producing a correct committed change (`success 0/3`, `operationRowAppended 0/3`). Precise nuance vs the pre-reg wording: some trials *do* call `commit_transaction` and get `{ok:true}` on empty/partial transactions, but **never a correct T01 fix** — the failure is upstream of and orthogonal to the commit gate, exactly as diagnosed. No trial unexpectedly succeeded (no informative-variance surprise). The gate is confirmed **not** T01's lever.
- **HN-2 (T08 clean win replicates): 2/3 — "win with noted variance" per the frozen scale (not 3/3 robust, not ≤1/3 downgrade).** All three T08 trials are process-identical and clean: single transaction, `change_return_type → replace_body → replace_body → validate → commit_transaction{ok:true}` first try, 13 tools, 0 retries, **`operationRowAppended` 3/3, no cross-task collateral** (GS-3 holds at N=3 — no T08 commit was rejected by, or repaired, T05's fixture). 2/3 met T08's task-success criteria; **trial 1 committed a `tsc`-clean, behaviorally-passing change (`resultQuality` tsc+vitest both true, opRow true) that missed T08's strict regex *text* criteria** (`evaluateT08TextCriteria`: return-type-literal-union / no-`as string`-cast / narrowed-callsite shape). The miss is **criteria-shape strictness on an otherwise correct, contamination-free committed change**, not a process failure, regression, or contamination.

**Conclusion:** No bail STOP. The validated task-scoped gate is **robust at N=3** for the regression guard (T03 — the flagship claim, now re-replicated post-fix and still disjoint from baseline) and for the T05 gate-driven correctness mechanism. T08 is a **real win with honest 2/3 task-criteria variance** (clean every trial; the 1 miss is text-criteria strictness on a correct change, worth a future look at either the agent's solution shape or the regex criteria — not a contamination or a gate defect). T01 is **firmly isolated** to the known `add_parameter` tool-legibility / model-capability lever, replicated 0/3, orthogonal to the gate. The aggregate "cross-task pattern does NOT hold" line remains the known definitional artifact (it requires the T05 control to *not* separate; the scoped gate correctly makes T05 pass its own task — desired, not contamination).

**Design-doc impact:** none to architecture. Hardens the prior entry's N=1 result into N=3 distributions for T03/T05 and a quantified 2/3 for T08; RESULTS.md updated accordingly.

**Revisit when:** (a) the T08 2/3: inspect whether trial-1's behaviorally-correct miss is agent solution-shape variance or over-strict regex criteria — a small, separable investigation, not a gate pass; (b) the now-isolated T01 lever (stronger model and/or `add_parameter` legibility redesign); (c) raising N further only as an explicit separate budget decision (N=3 is the claim bar; do not auto-escalate).

## 2026-05-16 — Keyed validation of the task-scoped gate: GS-1..GS-4 ALL PASS — BG-4 reversed, T08 clean win, T01 fails for a non-gate reason

**Context:** The operator-keyed re-run mandated by the gate-scope spec's pre-committed bail signals, run on branch `feat/gate-scope-redesign` (the task-scoped-gate fix), `pnpm --filter @strata/bench bench -- --trials=1 --tasks=T01,T05,T08,T03 --keep-artifacts`, `claude-sonnet-4-6`, N=1, **round cost $0.79** (vs the BG-4 round's $1.52 — agents stopped doing unrelated collateral work). Classified from the persisted substrate transcripts (`packages/bench/results/logs/*-2026-05-16T20-5*/21-0*.jsonl`), per the spec — not aggregate inference. Artifact: `packages/bench/results/phase15-four-task-2026-05-16T21-05-00-441Z.{json,md}`.

**Bail-signal classification (all from transcripts):**
- **GS-1 (T03 regression guard restored) — PASS.** T03 substrate is the canonical single clean transaction: `find_declarations → get_references → begin_transaction → rename_symbol → validate → commit_transaction`. 1 transaction, **0 `replace_body`**, commit `{ok:true}` first try (no gate rejection), 1228 tok / 6 tools / 28 s / 0 retries — back inside (tighter than) the proven band, vs BG-4's 2176 tok / 12 tools / 45 s / 2 transactions. The BG-4 regression is fully reversed; the round is therefore VALID. Still beats baseline (3553 tok / 21 tools).
- **GS-2 (teeth where due) — PASS.** T05 (scoped to its OWN `tests/dateRange.test.ts`): the agent's first transaction was an empty `begin→validate→commit` no-op; the gate **correctly rejected it with T05's own fail-before signal** (`dateRange.test.ts 1 failed`), which drove a real second transaction (`begin→replace_body→validate→commit{ok:true}`) → success 1/1. The behavioral gate converted a would-be Phase-1.5-style no-op/thrash into a real fix. T08 (scoped `[]`→tsc-only): a tsc-clean correct change committed in one transaction. Correct, task-scoped teeth.
- **GS-3 (no cross-task contamination) — PASS.** T03 and T08 each committed in ONE transaction with ONLY their own task's edits; no commit was rejected by another task's fixture; no agent fixed the unrelated `isWithinRange` bug as collateral. The defining BG-4 symptom (every non-T05 first commit rejected by T05's red) is GONE. T05 seeing `dateRange` in its rejection is correct — that IS T05's own fixture.
- **GS-4 (scorer == gate) — PASS (structural + observed).** Tasks 6/7 wired the same `behavioralFixturesForTask(taskId)` into the live gate and both scorers; the final whole-branch review traced all three paths; no per-task divergence observed (T03/T08/T05 `vitestPassed` reflect their own scoped fixtures).

**Substantive result:**
- **The gate-scope fix is validated. BG-4 is resolved.** The proven atomic T03 win is fully restored and clean.
- **T08: substrate clean win 1/1 (one transaction, only its own edits, tsc+behavioral pass); baseline 0/1.** The gate's original motivating case (T08 confident-wrong) is closed *without* contamination.
- **T05: substrate 1/1, gate-driven.** The scoped behavioral rejection of a no-op first transaction is exactly the designed mechanism. Caveat: N=1, and substrate is slower here (18 tools / 74 s) than baseline (6 / 19 s) — a correctness success, not an efficiency win.
- **T01: still FAILS — and the gate is provably NOT its lever.** Transcript: 16× `read_node` + 10× `find_declarations` exploration, then `begin_transaction → add_parameter → replace_body×3 → validate✗ → rollback → begin_transaction → replace_body → add_parameter → replace_body×3 → validate✗`, then wall-abort. `validate` failed twice with `oldText mismatch at [52,110)` — the diagnosed `add_parameter`/manual-`replace_body` callsite-collision thrash. It **never reached `commit_transaction`**, so the behavioral gate was never invoked. The report's T01 `tsc/vitest 1/1` is the known scorer-on-non-converged-run artifact (`success 0/1`, `operationRowAppended 0/1`, `error_wall_time` are the truthful signals). T01's failure is upstream of commit; its remaining lever is `add_parameter` tool legibility and/or model capability — explicitly a DIFFERENT lever than the commit gate, and one prompt tuning already failed to move (2026-05-15 BS-P-B terminal).

**Cross-task "pattern does NOT hold" line is a definitional artifact, not a negative:** the harness heuristic requires the T05 control to NOT separate; T05 now succeeds because the scoped gate correctly makes it pass its own task — desired behavior, not contamination. The transcript-level truth (which the spec mandates over the aggregate heuristic): 3/4 tasks succeed cleanly under the substrate (T03 win intact, T08 clean win, T05 gate-driven), T01 fails for a non-gate reason.

**Design-doc impact:** none to architecture. Confirms the gate-scope spec's thesis and sharpens `strata-design.md`'s "validate-before-commit" gate: it is now a *valid, task-scoped* behavioral finish line. RESULTS.md updated to record this measured outcome (was "built, found invalid as-built: BG-4").

**Revisit when:** a stronger model or an `add_parameter` tool-legibility redesign takes on T01 (the now-isolated remaining lever); or N is raised from 1 to harden the T05/T08 single-trial observations into a distribution. Not by another gate-scope pass — that lever is closed and validated.

## 2026-05-16 — Gate-scope build: AcceptanceContext carries the resolved fixture list, not taskId

**Context:** Implementing the task-scoped gate (spec `docs/superpowers/specs/2026-05-16-gate-scope-redesign-design.md`). The spec's prose says `commitWithBehavioralGate` resolves `behavioralFixturesForTask(ctx.taskId)`.

**Considered:** (a) literal spec — `AcceptanceContext` carries `taskId`, the verify gate calls the resolver; (b) callers resolve and pass `AcceptanceContext.behavioralFixtures: readonly string[]`.

**Decided:** (b). The single authority (`behavioralFixturesForTask` in `@strata/verify`) and the gate==scorer guarantee are unchanged — both the live gate (session.ts) and the bench scorer (substrate/baseline) resolve through that one function. Carrying the resolved list keeps the verify gate decoupled from benchmark task identity and lets the gate unit tests exercise arbitrary fixture lists (`["tests/a.test.ts"]`, `[]`) directly.

**Why:** Same intent and invariants as the spec; strictly better seam (testability + no task-vocabulary coupling in the gate). Recorded because it diverges from the spec's literal wording per the project's build-time-divergence discipline.

**Design-doc impact:** none to architecture; refines the spec's internal call-site only. Spec intent (single authority, fail-loud, additive scoping, gate==scorer) fully preserved.

**Revisit when:** a non-bench caller needs the gate and cannot resolve a fixture list itself.

## 2026-05-16 — Keyed behavioral-gate re-run: BG-4 TRIGGERED — the whole-suite gate scope is invalid on the shared multi-task corpus (STOP)

**Context:** The operator-keyed re-run mandated by the prior entry's "Revisit when" and `docs/RESULTS.md` — `pnpm --filter @strata/bench bench -- --trials=1 --tasks=T01,T05,T08,T03 --keep-artifacts`, `claude-sonnet-4-6`, N=1, round cost $1.52. Classified from the persisted substrate transcripts (`packages/bench/results/logs/*-2026-05-16T18-*.jsonl`), as the spec requires — not aggregate inference. Artifact: `packages/bench/results/phase15-four-task-2026-05-16T18-42-04-563Z.{json,md}`.

**Considered:** (a) read the aggregate `successCount`/`vitestPassed` and proceed; (b) classify the transcripts against bail signals BG-1..BG-4 before drawing any conclusion.

**Decided:** (b), and the classification surfaced a gate **design defect**, not a result. **Recorded as a STOP per spec § Bail signals; the gate was not patched and the round was not re-run — that is an operator design decision, logged here per "record the failure too".**

**Root cause (source- + transcript-verified):**
- `runCorpusAcceptance` in `@strata/verify/src/corpusRun.ts` runs the **entire** corpus vitest suite (`vitestRun` → `vitest run`, no task scoping/filter/`testNamePattern`).
- The shared seed `examples/medium` deliberately ships a **failing** test — `tests/dateRange.test.ts` `describe("isWithinRange (T05 - half-open interval)")` against the buggy closed-interval seed `src/lib/dateRange.ts` (`date <= end`). That failing test **is the T05 task's own fail-before fixture**, i.e. one of the four benchmark tasks lives, pre-fix, in the shared corpus the gate runs in full.
- Therefore the behavioral gate is **structurally unsatisfiable for every non-T05 task by the correct task change alone.** Every first `commit_transaction` on T01/T03/T08 is rejected with the *identical, unrelated* `dateRange.test.ts` failure. The only way to `{ok:true}` is to **also fix the T05 bug**.

**Transcript evidence (substrate side, dispositive):**
- **T03 (regression guard):** `find_declarations → get_references → begin_transaction → rename_symbol → validate → commit_transaction{ok:false: dateRange…isWithinRange}` → **second transaction** `begin_transaction → rename_symbol → replace_body → validate → commit_transaction{ok:true}`. The `replace_body` is the agent fixing the unrelated T05 bug to land its rename. The proven **atomic single-transaction rename is gone**: 12 tools / 2176 tok / 44.8 s vs the proven 7–11 / 1201–1473 / 24–30 s.
- **T08:** agent verbatim — *"The test expects a half-open [start, end) interval but the body uses <= (closed). I need to fix isWithinRange in the same transaction."* It fixed T05's bug as collateral to land T08. Reported `failuresRetries=0` despite a visible `commit_transaction{ok:false}`→fix→`{ok:true}` self-correction (secondary instrumentation gap: the gate rejection is not counted by the retry rule).
- **T01:** 46 tools, 327 s (near the 420 s budget), three transactions, repeated gate rejections; `successCount=0`, `operationRowAppendedCount=0` — never converged. `vitestPassed=1` is a **scorer false-positive**: with nothing of T01 committed, the rendered tree ≈ seed, and the suite still fails on T05 — the 1 reflects a late incidental T05 touch, not a T01 success.
- **T05:** trivially `1/1` — the gate's whole-suite requirement *is* exactly its own task. Its prior "never reaches commit" thrash did not recur here, but this round cannot attribute that to the gate vs. model variance because the task and the gate are now the same thing.

**Bail-signal classification:**
- **BG-1 (flaky gate):** not triggered — deterministic (identical failure every run).
- **BG-2 (gate cost):** secondary — full render+tsc+vitest per commit attempt, ~2 attempts/task; per-invocation within the "seconds" tolerance, noted not blocking.
- **BG-3 (scorer relocation divergence):** not triggered — key-free `scopeEquivalence`/regression stayed green (`pnpm -r test` = 176 passing / 2 key-gated skipped). The *relocation* is behavior-preserving; the defect is the gate's **runtime scope**, a distinct axis from BG-3.
- **BG-4 (T03 regression):** **TRIGGERED.** T03 moved on every axis (tokens +~48%, +1 tool over the proven max, ~30→45 s) and, decisively, its **operation semantics changed** — the atomic rename now requires a second transaction repairing an unrelated seed bug to pass the gate. Spec: "any movement is a stop-and-diagnose, not a proceed."

**Conclusion:** The behavioral-commit-gate *concept* is not refuted, but the gate **as built is invalid against this shared multi-task corpus**: it conflates "did the agent's task succeed" with "does the whole corpus — including other tasks' deliberately-failing fail-before fixtures — pass." A change that type-checks and passes *its own* task's tests is still rejected because a *different* benchmark task's fixture is, correctly and by design, still red. This both breaks the T03 regression guard (BG-4) and contaminates the scorer for T03/T08 (their `vitestPassed=1` reflects the agent incidentally fixing T05). The `docs/RESULTS.md` "named next lever — now implemented, pending keyed validation" question is answered: **as-built, on this corpus, it does not validate.**

**Design-doc impact:** none to `strata-design.md`. Sharpens the prior entry: the agent finish line and the scorer finish line are now one function *by construction* — but when that one function is whole-corpus and the corpus co-locates multiple tasks' fail-before fixtures, the shared finish line is unreachable per-task. The "validate-before-commit" gate must be **task-scoped** to be a valid behavioral signal.

**Revisit when:** the operator chooses the gate-scope fix and re-runs. Options to weigh (not decided here): (a) the gate runs only the test files/names in scope for the active task (task metadata already names its fixture); (b) the benchmark corpus is per-task isolated so a task's gate never sees another task's fail-before fixture; (c) the gate asserts "no test regressed vs. the pre-change baseline" rather than "all green," so a pre-existing unrelated red is tolerated. Each is a substantive design change requiring its own spec/decision entry and a fresh keyed round with T03 re-established as the regression guard *before* any further generalization claim.

## 2026-05-16 — Behavioral commit gate: corpus runner lowered into @strata/verify; agent gate == scorer

**Context:** RESULTS.md named the next research lever — gate agent commit on behavioral task-acceptance, not just tsc-clean (underlies T08 and post-prompt T01). Spec: `docs/specs/2026-05-16-behavioral-commit-gate-design.md`; plan: `docs/superpowers/plans/2026-05-16-behavioral-commit-gate.md`.

**Considered:** (a) new `run_tests` agent tool the loop must call; (b) hard-gate inside the commit path reusing the existing validate-before-commit machinery; (c) both.

**Decided:** (b). The on-disk render+tsc+vitest runner (`renderStoreToDir`, `tsc*`, `vitestRun`, scope guards, `QualityResult`) moved from `@strata/bench` down into `@strata/verify` (`corpusRun.ts`); `@strata/bench/src/quality.ts` is now a thin re-export. New `runCorpusAcceptance` (captures subprocess output) and `commitWithBehavioralGate` (validate-as-today → corpus acceptance → finalize). The agent's `commit_transaction` calls the gate only for live runs (`acceptance` undefined in replay), so the 170 key-free tests and replay determinism are unchanged (post-change `pnpm -r test` = 176 passing / 2 key-gated skipped: the prior 170 + 6 new @strata/verify gate tests).

**Why:** Acyclic (`bench → agent → verify`); the agent finish line and the scorer finish line become one function by construction, removing the diagnosed confident-wrong commit. Additive: `commit()`/`validate()` signatures and behavior untouched.

**Execution findings (recorded per "record the failure too"):**
1. **Plan test-fixture defect, fixed.** The plan's `behavioralGate.test.ts` fixture created an empty on-disk `src/` while the source lived only in the in-memory store, so `validate()`'s `loadCompilerOptions`/`ts.parseJsonConfigFileContent` threw "No inputs were found in config file" against the `include: ["src/**/*.ts"]` glob. An implementer first masked this with a blanket `try/catch` around `validate()` in production code; that deviation was rejected (silent-failure anti-pattern, and unnecessary — the real corpus `examples/medium` is always on disk). Correct fix: the fixture now writes the seed `.ts` to disk before constructing the store, mirroring production; `commitWithBehavioralGate` is exactly as designed with no error-swallowing.
2. **Latent design assumption, documented not changed.** The gate is keyed on `runParams.replayTranscript` being absent as the proxy for "a live model is driving." This holds for every current caller (the only non-replay path reaching `runAgentForPrompt` is the genuine live benchmark + the key-gated `agentT03` test). A future deterministic non-replay caller would silently engage the corpus runner; flagged here for any such future caller's author.
3. **Pre-existing pipeline assumption, noted.** `commitWithBehavioralGate`'s abs→corpus-`src`-relative path mapping (shared with the pre-existing `renderStoreToDir`/scorer) assumes all modules live under `srcRoot`; a module outside `srcRoot` would write outside the scratch `src/` tree. Not a regression (pre-existing pipeline-wide), out of scope here, recorded for completeness.

**Design-doc impact:** none to architecture; sharpens strata-design.md's "validate before commit" gate — necessary but not sufficient; behavioral acceptance is now the agent's finish line for live runs.

**Revisit when:** the operator's keyed re-run (T01/T05/T08 with T03 as the regression guard) reports its finding — recorded as a new newest-first entry whatever the outcome, including "gate works but T05 still thrashes", per the spec's bail signals BG-1..BG-4.

## 2026-05-15 — Phase 1.5-P: prompt/description tuning is INSUFFICIENT (BS-P-B terminal); the gap is not prompt-closeable

**Context:** Operator re-validation after the P1 (explore-then-act prompt discipline) + P2 (rewritten `add_parameter` description) pass. Keyed N=1 with `--keep-artifacts` over T03/T01/T05/T08 ($1.12). Classification from the persisted substrate transcripts, as the protocol requires.

**Results (log-classified, not inferred):**
- **BS-P-A PASS — T03 did not regress.** Substrate 1/1, baseline 1/1, exactly as before. The prompt/description changes are safe on the proven, replicated win.
- **P1 ineffective (T05).** Transcript: `find_declarations`×14, `read_node`×9, one `begin_transaction`, ZERO mutations, wall-timeout — the *same* pure exploration thrash as the pre-P1 run. The general explore-then-act discipline paragraph did not change the agent's behavior at all.
- **P2 ineffective (T01).** Transcript: `begin_transaction`→`add_parameter`→`replace_body`×3→rollback→`begin_transaction`→`add_parameter`→`replace_body`×2→commit→`begin_transaction`→`replace_body`→commit. The agent still hand-patches callsites with `replace_body` despite the rewritten description *explicitly forbidding exactly that*. It committed this round (N=1 variance, criteria still 0/1) via the same wrong behavior.
- **T08 flipped to 1/1 at N=1** — treated as model variance per the spec's "a changed T08 is not an improvement claim", not a fix; the commit-gate gap is unaddressed by design this pass.

**Decided / concluded (BS-P-B terminal — do NOT iterate the prompt further):** The Phase 1.5 multi-decision-task failures are **not prompt- or description-tunable**. A fair, general (non-scripted) rework of both the navigation discipline and the most-misused tool's description left agent behavior byte-for-byte unchanged on the failing tasks. The agent ignores explicit worldview discipline and an explicit prohibition for these tasks, while following the same style of guidance perfectly for the single-operation rename (T03). The honest synthesis across Phases 1/1.5: **the file-abstraction-removal advantage is real, robust, and replicated for atomic single-operation structural edits (rename: wins every harness iteration and survives the prompt change), but does not generalize to multi-step agent-driven refactors, and that gap is NOT closeable by prompt engineering.** The remaining real levers are deeper (commit-gate/in-loop-acceptance redesign — implicated in T01 and T08 — or a model-capability limit at an 11-tool multi-decision surface), not more tuning.

**Design-doc impact:** none to architecture. Empirically sharpens strata-design.md's thesis: the substrate efficiency claim is demonstrated for atomic operations and is an open question for multi-step refactors; prompt engineering is shown insufficient to bridge it.

**Revisit when:** a future effort takes on the deferred commit-gate/loop redesign as a deliberate research item, or evaluates a stronger model at this tool surface. Not by another prompt pass.

**Context:** Fixed the `--keep-artifacts` -> `logPath` instrumentation gap in `packages/bench/src/configs/substrate.ts` (when `keepArtifacts` and no explicit `logPath`, derive a discoverable `results/logs/<task>-substrate-trial<N>-<stamp>.jsonl`; 170+2 tests stay green, no test files edited). A cheap targeted keyed round (T01/T05/T08, N=1, $0.48) then persisted real substrate transcripts, enabling the spec-mandated log-based R3 classification instead of aggregate inference.

**Transcript evidence (substrate side):**
- **T05 (one-line bugfix, the inverted control): pure BS15-E exploration/decision thrash.** 23 tool calls, ZERO mutation calls, 1 `begin_transaction`, 1 `validate`; 14 `read_node` (11 consecutive) + 5 `find_declarations`. The agent never attempted the fix — it loops on cheap read-only structural tools and never commits to acting. The file baseline did this in 5 tools / 16s.
- **T01 (add_parameter): tool-illegibility + thrash.** 34 calls: `begin_transaction`->`add_parameter`->`replace_body`x3->rollback->`begin_transaction`->`replace_body`x3->`add_parameter`, never a clean `validate`. The agent does not trust/understand `add_parameter`'s callsite fan-out, falls back to hand-patching with `replace_body`, loops and rolls back.
- **T08 (change_return_type): NOT thrash — a deeper correctness-gate gap.** Clean 15-call run: `begin_transaction`->`change_return_type`->`replace_body`x2->`validate`->`commit_transaction`, terminal success. The agent confidently committed; tsc-clean `validate` passed; but the corpus vitest fails. The substrate's commit gate (tsc-clean) is weaker than the task's real success criterion, so the agent commits confidently wrong with no signal.

**Conclusion:** The Phase 1.5 negative is not a single fundamental substrate failure. It decomposes into: (a) **agent navigation/decision discipline** (T05 thrash) — likely system-prompt-tunable (explore-then-act budget; the cheap structural read tools enable infinite stalling); (b) **tool legibility** (T01) — `add_parameter`'s callsite-fan-out semantics aren't conveyed well enough for the agent to wield it instead of hand-patching; tool-description + prompt work, medium; (c) **commit-gate weakness** (T08) — the most significant: `validate` (tsc-clean) is not the task's success criterion, so confident-but-wrong commits pass. This is a loop/design question (the agent likely needs task-acceptance/test signal in-loop, not just tsc), not a tool bug. Rename (T03) works because it is a single unambiguous operation with one path and no decisions; the expanded toolset introduces choices the current prompt+tool-descriptions+commit-gate do not equip the agent to make.

**Design-doc impact:** none to architecture; this refines the prior honest-negative entry with mechanism. It identifies that strata-design.md's "validate before commit" gate is necessary but not sufficient for task correctness — a real finding for any future agent-loop design.

**Revisit when:** the operator decides the next lever (prompt/tool-description rework for a,b; commit-gate/in-loop-test redesign for c) vs. accepting the scoped result and writing up. The classification, not more benchmark runs, is what should drive that decision.

## 2026-05-15 — Phase 1.5 re-validation: harness now valid; T03 win replicates; new tools are NOT agent-effective (honest negative)

**Context:** Post-remediation operator re-validation, `claude-sonnet-4-6`, N=1 (8 runs $0.76) + a targeted T01/T05/T08 round ($0.43). The remediation (R1/R2/R3) is confirmed working: scoring is symmetric and valid (both configs `tsc clean 1/1` everywhere; T03 baseline passes again exactly as in the valid Phase 4 round — proving the harness is fair, not rigged).

**Result (N=1, indicative not a significance claim — and N=3 deliberately NOT run because the pattern does not hold):**
- **T03 (rename): the Phase-1 win replicates under the now-valid harness.** Both succeed; substrate ~2.9x fewer tokens (1359 vs 3910), ~1.8x faster (30.6s vs 56.4s), 0 vs 2 retries. Robust.
- **T01 (add_parameter):** substrate `error_wall_time`; at the raised 420s/40t budget it did MORE tool calls (33) than the prior 240s round (22) and still failed. More budget produced more work, not success → by the R3 anti-inflate clause this is NOT budget-bound; do not raise further.
- **T05 (the reasoning control):** baseline succeeds trivially (5 tools, 16s); substrate `error_wall_time` at 12 tool calls / 300s. The control is INVERTED — the substrate loses where the file baseline trivially wins. The strongest possible evidence the gap is the substrate, not a rigged comparison.
- **T08 (change_return_type):** substrate terminated "success" but the corpus vitest fails (0/1); it passed pre-remediation — that earlier "win" was a scoring artifact the symmetric scorer correctly destroyed.

**Decided / concluded:** Phase 1's `rename_symbol` substrate advantage is real and replicable. Phase 1.5's tool expansion (`add_parameter`, `change_return_type`, `replace_body`) does NOT generalize that advantage: the tools pass 170 unit tests but the agent cannot effectively wield them on real tasks. Do NOT run N=3 (would spend ~$3 confirming a non-pattern). Do NOT inflate budgets (forbidden by BS-R3; more budget already produced more thrash, not success).

**Instrumentation gap (a real harness defect, recorded per "log the failure too"):** the R3 spec required operator timeout classification from the session log, but `--keep-artifacts` does not actually persist a readable per-tool transcript — `substrate.ts` takes a `logPath?` and the runner threads a `keepArtifacts` boolean, but nothing converts the boolean into a concrete written log and trial records carry no `sessionLog`. So the precise budget-bound-vs-BS15E-thrash-vs-tool-ergonomics label cannot be log-classified as the protocol demands; the conclusion above is drawn from aggregates (terminal reasons, tool counts vs. budget, the inverted control), which is strong but not the spec-mandated method.

**Design-doc impact:** none to the architecture; this is an empirical finding about agent-effectiveness of the new tools + a harness instrumentation defect. The strata-design.md thesis stands on T03; it is NOT demonstrated for the broader tool set.

**Revisit when:** the keepArtifacts->logPath wiring is fixed and a cheap targeted round captures real transcripts → then classify (thrash vs ergonomics) to guide tool/prompt rework; that rework, not a benchmark re-run, is the next lever for the Phase 1.5 tools.

**Context:** Phase 1.5R's three fixes (R1 seed-clean, R2 scorer/quality scope equivalence, R3 per-task budget + classification protocol) are implemented and green key-free.

**Decided / Observed:** Acceptance holds before any operator live round: (1) unmodified seed src is `tsc --noEmit` clean under the post-R1 src-only corpus tsconfig; `tests/` remains present, in `vitest.config.ts` include, and a real fail-before signal. (2) `scopeEquivalence.test.ts` passes for all four tasks × correct/half-done/seed: substrate-side pure core and baseline-side `scoreTaskSharedCriteria` return byte-identical text booleans, and tsc scope is `["src/**/*.ts"]` with no `tests/`. (3) Per-task `maxTurns`/`wallTimeMs` are first-class in `runner.ts` and threaded unchanged into the session; T03/T08 remain 25t/240000ms by default, while T01/T05 carry the artifact-derived higher defaults; the projected-spend line prints the per-task ceiling. (4) `pnpm -r build` and `pnpm -r test` are green key-free: existing 152 passing + 2 skipped baseline held, plus 18 passing cases in the two allowed new bench test files. The genuine T03 regression guards are byte-unchanged. No BS-R1/R2/R3 fired during implementation.

**Why:** Only a valid harness may produce a number anyone should believe; the N=1→N=3 validation-before-distribution discipline is unchanged.

**Design-doc impact:** none.

**Revisit when:** the operator runs the keyed re-validation N=1; record its DR-round entry regardless of outcome.

## 2026-05-15 — R3: per-task maxTurns/wallTimeMs first-class + --task-budget + timeout-classification protocol (Phase 1.5R DR3)

**Context:** Phase 1.5R remediation. Substrate T01 timed out at 22 tool calls and T05 at 17 under the 240,000 ms global wall. Budgets were single global values; the structurally bigger tasks need justified per-task budgets plus a protocol that classifies timeouts rather than inferring them.

**Considered:** (a) raise the single global budget; (b) make maxTurns/wallTimeMs per-task overridable with artifact-derived defaults for T01/T05, T03/T08 untouched, plus operator-recorded classification.

**Decided:** (b). `runner.ts` now has `PerTaskBudget`, `DEFAULT_PER_TASK_BUDGET` (T01 40t/420000ms, T05 40t/300000ms; T03/T08 no override and therefore global 25t/240000ms), `resolveTaskBudget`, `parseTaskBudget`, and `--task-budget=T01:maxTurns=40,wallMs=420000;T05:maxTurns=40,wallMs=300000`. The projected-spend line prints resolved per-task budgets. `SessionLog` `session_start` now records `wallTimeMs` alongside `maxTurns` so operator timeout classification has the configured budget in the log.

**Timeout-classification protocol (operator-recorded, never auto-inferred):** every substrate `error_wall_time`/`error_max_turns` is classified from the session log into exactly one bucket and recorded as `T0N: <bucket> — <one-sentence evidence>`: (1) budget-bound, monotonic progress; one bounded logged raise and one re-run only; (2) BS15-E thrashing, wrong-tool loops or oscillation; surface the tool-selection finding, do not inflate; (3) genuine tool-ergonomics failure, right tool cannot express the task; surface the substrate limitation. A second bucket-1 timeout at the raised budget escalates to bucket 3.

**Why:** Quantified, bounded, honest. T03/T08 budgets are unperturbed, while T01/T05 get room justified by the failing artifact without opening an inflate-until-green loop.

**Design-doc impact:** none — additive runner plumbing; the session budget contract is unchanged.

**Revisit when:** the re-validation round's classified evidence shows T01/T05 need a different shape of help than one bounded raise; that is the honest BS15-E finding, not a third raise.

## 2026-05-15 — R2c: scopeEquivalence.test.ts proves substrate==baseline byte-identical over the identical src-only scope (Phase 1.5R DR2c, BS-R2 gate)

**Context:** Phase 1.5R remediation. The methodology requires the BS-Bench-B/BS15-C identical-core property: "did the task succeed" must be the same question for substrate and baseline, over the identical scope, through one pure core.

**Considered:** n/a — this is the key-free gate and bail-signal observation.

**Decided / Observed:** Added `packages/bench/tests/scopeEquivalence.test.ts`: per task (T01/T03/T05/T08) × state (correct/half-done/seed), the substrate-side pure `evaluateT0NTextCriteria` core and the baseline-side `readModuleMap`→`scoreTaskSharedCriteria` path return byte-identical text-criteria booleans on the same logical post-edit Map. The test also asserts the materialized corpus tsconfig scope is exactly `["src/**/*.ts"]` while `tests/` remains present, and that `tscNoEmitSrc` fails loudly if `tests/` is reintroduced. BS-R2 did not fire; no byte-frozen existing test was edited.

**Why:** A non-equivalent scorer invalidates every number. This proves equivalence key-free before any operator live round, exactly as D1/D2/D12 require.

**Design-doc impact:** none — restores and gates the identical-core integrity property.

**Revisit when:** render canonicalization diverges from baseline whitespace for a semantically-identical result on any task (BS-R2 fires — do not ship that task's number, do not fork the core).

## 2026-05-15 — R2b: evaluateT0NCriteria returns the rendered Map additively; substrate resultQuality unified to the baseline's two probes (Phase 1.5R DR2b)

**Context:** Phase 1.5R remediation. The substrate `resultQuality` was not scope-equivalent: T03 re-derived a deterministic rename and T01/T05/T08 mirrored `validateAfterCommitClean`, while the baseline ran `tscNoEmit` and `vitestRun` over its edited temp tree. `runAgentForPrompt` closes its in-memory DB before returning, so resultQuality needs the final rendered text before closure.

**Considered:** (a) re-derive each task deterministically; (b) have the per-task `evaluateT0NCriteria` wrapper additively expose the rendered `Map<modulePath,text>` it already builds, then materialize that exact Map to a scratch corpus-shaped tree and run the same probes as baseline.

**Decided:** (b). `evaluateT0{1,3,5,8}Criteria` now returns `T0NCriteria & { rendered: Map<string,string> }`; the property is non-enumerable so existing boolean `Object.entries(criteria)` regression guards stay unchanged. `AgentT03Result`/`AgentTaskResult` carry optional `rendered`. `substrate.ts` now uses one quality path for every task: materialize `result.rendered` as `src/`, copy post-R1 `tsconfig.json`, `package.json`, `vitest.config.ts`, and seed `tests/`, symlink repo `node_modules`, then run `tscNoEmitSrc` and `vitestRun`.

**Why:** Substrate quality is now measured on the exact text the shared per-task core scored, using the same src-only typecheck and real vitest signal as the baseline. BS-R2 did not fire at this step; no byte-frozen tests were edited.

**Design-doc impact:** none — restores the scorer-equivalence requirement D1/D2/D12 already mandate.

**Revisit when:** a future task's committed output cannot be expressed as a rendered src Map; that would be a BS-R2 finding for that task's quality sub-metric.

## 2026-05-15 — R2a: src-scoped tscNoEmitSrc with an explicit scope guard; baseline points at it (Phase 1.5R DR2a)

**Context:** Phase 1.5R remediation. Pre-fix the baseline typechecked its whole temp tree through the corpus tsconfig while the substrate typechecked rendered src only. Post-R1 the tsconfig is src-only, but a future re-add of `tests/**` would silently re-break equivalence unless the quality path asserts the scope.

**Considered:** (a) rely on R1 alone; (b) add an explicit `tscNoEmitSrc` wrapper that asserts the resolved corpus `include` is src-only before delegating to the unchanged `tscNoEmit`.

**Decided:** (b). `quality.ts` now exports `resolveCorpusTsconfigInclude`, `assertSrcOnlyScope`, and `tscNoEmitSrc`. The baseline `defaultValidateWorkingTree` uses `tscNoEmitSrc`; the original `tscNoEmit` remains unchanged for compatibility and existing regression guards.

**Why:** The src-only typecheck invariant is now enforced where the quality probe runs, so a future `tests/` glob fails loudly instead of producing a non-equivalent benchmark number.

**Design-doc impact:** none — additive helper enforcing the existing scorer-equivalence requirement.

**Revisit when:** the corpus legitimately needs a non-`src/`-prefixed production glob; broaden the assertion while retaining the explicit `tests/` exclusion.

## 2026-05-15 — R1: corpus typecheck scope is src-only; vitest is the test-based signal (Phase 1.5R DR1)

**Context:** Phase 1.5R remediation. The N=1 round surfaced that `examples/medium/tests/format.test.ts` is written against the post-`add_parameter` signature, so `tsc --noEmit` over a scope including `tests/` fails on the unmodified seed and breaks the seed-clean invariant.

**Considered:** (a) edit/delete the post-signature assertions to make the seed clean (BS-R1: weakens T01's bar); (b) exclude `tests/` from the corpus typecheck scope while keeping it in the vitest scope so the test-based signal remains fail-before/pass-after.

**Decided:** (b). `examples/medium/tsconfig.json` `include` is now `["src/**/*.ts"]`. `compilerOptions`, `vitest.config.ts`, `tests/`, and all `src/` fixtures are unchanged. "The corpus compiles" (`tscClean`) now means "src compiles"; the task test signal runs under vitest. Key-free acceptance: unmodified seed src is `tsc --noEmit` clean, while `tests/` stays on disk, in the vitest include, and remains a real fail-before signal.

**Why:** Restores the seed-clean invariant without weakening a task criterion. T01's post-task signature is still required by `evaluateT01TextCriteria` and by `tests/format.test.ts` running under vitest. BS-R1 did not fire.

**Design-doc impact:** none — corrects an implementation regression and confirms validation-before-distribution discipline.

**Revisit when:** the corpus gains a non-test src module that legitimately must be excluded, or a future task genuinely requires `tests/` in the typecheck scope (would reopen BS-R1).

## 2026-05-15 — Phase 1.5 N=1 validation round caught an invalid 4-task harness; remediation before any N=3

**Context:** First keyed 4-task live round, N=1 validation (8 runs, $0.73), `claude-sonnet-4-6`. Run as a cheap gate before the N=3 distribution. It did its job: results were NOT a clean pattern and diagnosis found the harness invalid, not the substrate beaten.

**What the round showed:** substrate T03 ✓ and T08 ✓ (rename + change_return_type work end-to-end via the agent); substrate T01 and T05 hit `error_wall_time`; baseline 0/1 on ALL four tasks including T03 (which the baseline passed cleanly 3/3 in the Phase 4 round).

**Root causes (three, distinct):**
1. **Seed-clean invariant broken (Pass 3 fixture defect).** `examples/medium/tests/format.test.ts` is written against the post-`add_parameter` signature (asserts a 2nd param; calls with 2 args). On the unmodified seed `formatTimestamp` takes 1 arg, so `tsc --noEmit` over the whole seed corpus is NOT clean (2 diagnostics). Runtime fail-before/pass-after is correct for a test-based criterion, but it must not make the seed fail typecheck.
2. **Substrate/baseline tsc-scope asymmetry (scorer non-equivalence).** `quality.ts` tsc's the baseline's whole temp tree (incl `tests/format.test.ts` → fails → baseline `tscClean:false` on every task → baseline 0/1 across the board, incl T03). The substrate re-derives quality from only its rendered changed modules — a different file set. The two configs are typecheck-judged over different scopes, violating the BS15-C/BS-Bench-B identical-core integrity property the methodology depends on.
3. **Substrate timeouts on T01/T05** (`error_wall_time`, 17–22 tool calls before the wall) — independent of scoring. Wall-time too tight for the harder tools, and/or BS15-E (tool-selection thrashing at the 11-tool surface), and/or tool ergonomics. Needs its own diagnosis; may be an honest "substrate struggles here" result.

**Decided:** Do NOT run N=3 on an invalid harness; do NOT hack the fixture green. Remediate all three (operator-approved "fix all 3 properly"): (1) exclude `tests/` from the corpus tsconfig so "tscClean" means "src compiles" with vitest as the separate test-based success signal, restoring the seed-clean invariant; (2) make substrate AND baseline score/tsc the identical file scope (restore scorer equivalence); (3) raise/parameterize wall-time for the harder tools and re-diagnose the T01/T05 timeouts (BS15-E). Then re-run N=1 validation, then N=3. Remediation goes through the spec→plan→Codex machine.

**Design-doc impact:** none — confirms the validation-before-distribution discipline and the scorer-equivalence requirement; corrects an implementation regression, not the design.

**Revisit when:** the remediated N=1 re-validation either clears (proceed to N=3) or surfaces a genuine substrate limitation on T01/T05 (report honestly, do not massage).

## 2026-05-15 — Bench task abstraction; T03 path preserved unchanged (Phase 1.5 Task 12 / D14)

**Context:** The Phase 4 harness was T03-specific (`task:"T03"`, hard-wired scorer/report). The four-task pattern needs T01/T05/T08 beside T03 without rewriting the proven path.

**Decided:** Added `BenchTask` (`packages/bench/src/tasks/`, one module per task), generalized `runner.ts` to loop a `--tasks` list (default all four), kept `bench:t03` as `--tasks=T03`, and added `bench` for the four-task default. Per-task baseline/substrate runners delegate to the matching `@strata/verify` per-task core through `scoreBaselineTask` / `runAgentTask`; T05 threads seed and post-edit test text symmetrically for the byte-identical anti-cheat. The report gained `buildSuiteReport`/`renderSuiteMarkdown`: per-task distributions plus a cross-task pattern section stating the claim and falsifier (structural tasks separate and T05 does not, else report honestly). Existing `buildReport`, `runSubstrateTrial`, `runBaselineTrial`, and `runAgentT03` signatures are preserved for the Phase 4 T03 path.

**Why:** Generalize the harness without forking the T03 regression path. Scorer cores stay in `@strata/verify` to preserve the acyclic package graph and config-equivalent scoring discipline.

**Design-doc impact:** none — additive generalization on the reserved bench slot.

**Revisit when:** a fifth task is added (add a task module and verify core; the runner does not change) or the live round shows a per-task scorer is not config-portable (BS15-C — do not ship that task's number).

## 2026-05-15 — Agent surface 8 -> 11; minimal prompt additions; BS15-E framing (Phase 1.5 Task 11 / D13)

**Context:** The three new mutation tools must be agent-visible. Going 8->11 may degrade tool selection (BS15-E).

**Decided:** Registered `add_parameter`, `change_return_type`, and `replace_body` in `tools.ts` over the shared `{ db, actor }` context, with zod shapes reusing `nodeIdSchema`/`txHandleSchema`, and added all three to `STRATA_TOOL_NAMES`/qualified tool names for the runtime guard. Prompt changes are minimal: one plain-English sentence per new tool plus a "Choosing the right mutation" paragraph. The single worked pattern stays rename and key-free tests assert no benchmark-specific prompt recipes. The obsolete pre-existing tool-surface count assertion was updated 8->11; T03 behavior tests were not changed.

**Why:** Mechanical registration; the hermetic isolation contract is unchanged. BS15-E is an empirical live-round question, not something inferred from no-key tests. Wrong-tool paths must not be scored as substrate wins and task-specific recipes must not be added to hide tool-selection confusion.

**Design-doc impact:** takes the mutation-tool count to four (rename + the three), inside `strata-design.md` Phase 1 "5-7" target.

**Revisit when:** the live round shows the agent cannot reliably select the right mutation tool after honest prompt iteration (BS15-E — surface as the tool-granularity finding; do not paper over).

## 2026-05-15 — Agent session generalized to per-task entry points; T03 path preserved (Phase 1.5 Task 10)

**Context:** Phase 4's substrate path is `runAgentT03`/`T03_PROMPT`, T03-specific. The four-task benchmark needs T01/T05/T08 substrate runs without forking the proven T03 loop.

**Decided:** Extracted the `runAgentT03` body into an internal `runAgentForPrompt(params, prompt, scoreFn)`; `runAgentT03` now delegates to it with public signature/return unchanged. Added `TASK_PROMPTS` and `runAgentTask(taskId, ...)` selecting prompt plus the matching `@strata/verify` per-task scorer. `runLiveSession`'s prompt is parameterized and defaults to `T03_PROMPT`. Hermetic Options are reused unchanged.

**Why:** One session loop, zero intended behavior change for T03, and no live call added. Replay/synthetic tests remain the key-free guard; the existing T03 replay and live-test path stay the regression net.

**Design-doc impact:** none — additive generalization.

**Revisit when:** a fifth task is added (extend `TASK_PROMPTS` and a scorer; the loop does not change).

## 2026-05-15 — T05 control scorer core in @strata/verify; symmetric anti-cheat (Phase 1.5 D12 — T05, BS15-C/BS15-D)

**Context:** T05 is the reasoning control: parity is the credibility anchor. Its criteria include the anti-cheat "test file byte-identical to seed", which MUST be applied identically for both configs or the control is invalid.

**Decided:** `packages/verify/src/t05Criteria.ts` mirrors `t03Criteria.ts`: pure core (half-open comparison present, closed interval gone, test file byte-identical), with `seedTestText` passed in explicitly and never file-read inside the core. The substrate wrapper renders committed source modules and feeds the seed test under `T05_TEST_KEY`; the baseline adapter will feed its post-edit test text under the same key. Substrate-only `operationRowAppended` = ReplaceBody. Core stays in verify (no cycle).

**Why:** T05 must be expressible by BOTH configs as a localized body edit with no reference-graph advantage to the substrate (`replace_body` confers none of the fan-out leverage that wins T01/T03/T08). The passed-in seed text makes the anti-cheat provably symmetric (BS15-D), and the BS15-C key-free equivalence test feeds file text and rendered store text through one core.

**Design-doc impact:** none.

**Revisit when:** the live round shows T05 gave the substrate a structural advantage or handicapped the baseline (BS15-D — stop and surface; do not tune T05 to manufacture parity or a win).

## 2026-05-15 — T08 per-task scorer core in @strata/verify; BS15-C did NOT fire for T08 (Phase 1.5 D12 — T08)

**Context:** T08 (return-type narrowing) needs one provably-identical pure core for both configs.

**Considered / Decided:** Same as D12-T01: `packages/verify/src/t08Criteria.ts` mirrors `t03Criteria.ts`; pure text core (literal-union return type, no `as string` on `getRole` results, caller guards intact), substrate wrapper renders committed store modules and adds substrate-only `operationRowAppended` (ChangeReturnType). Core stays in verify (no cycle).

**Why:** BS15-C key-free equivalence feeds file text and rendered store text through one core and asserts identical text booleans. T08's number is portable across substrate and baseline only because the scorer has no config-specific branch.

**Design-doc impact:** none.

**Revisit when:** render canonicalization diverges from baseline whitespace for a semantically-identical T08 result (BS15-C fires — do not ship T08's number, do not fork the scorer).

## 2026-05-15 — T01 per-task scorer core in @strata/verify; BS15-C did NOT fire for T01 (Phase 1.5 D12 — T01)

**Context:** T01 needs substrate and baseline scored by one provably-identical pure core (BS-Bench-B / BS15-C discipline), the T03 pattern.

**Considered:** (a) duplicate regexes in the bench adapter; (b) one pure `evaluateT01TextCriteria(Map)` core in @strata/verify fed by substrate-render and baseline-file adapters; (c) move it to bench.

**Decided:** (b). `packages/verify/src/t01Criteria.ts` mirrors `t03Criteria.ts`: pure text core (timezone signature/default, server `"UTC"` callsites, UI `"local"` direct callsite, HOF reference not mis-edited), and `evaluateT01Criteria` renders committed store modules then delegates to the same core while adding substrate-only `operationRowAppended` (AddParameter). Core stays in verify (no cycle).

**Why:** "T01 succeeded" means byte-identically the same for both configs. The BS15-C key-free equivalence test feeds file text and rendered store text through the same core and asserts identical text booleans, gating T01's number.

**Design-doc impact:** none — additive scorer core mirroring D1.

**Revisit when:** render canonicalization diverges from baseline whitespace for a semantically-identical T01 result (BS15-C fires — do not ship T01's number, do not fork the scorer).

## 2026-05-15 — examples/medium gains a runnable offline vitest suite; baseline temp-tree resolves vitest via node_modules symlink (Phase 1.5 D11, Open Question 2 / BS15-D gate)

**Context:** T01/T05 success criteria are `pnpm vitest run`. examples/medium had no src/lib, no tests, no vitest dep; `materializeCorpus` copied without installing; the implementer cannot reach the registry. This is exactly the "Revisit when: the corpus gains its own vitest suite" condition the 2026-05-15 "Baseline temp-checkout" entry named.

**Considered:** (a) `pnpm install` into the temp tree (needs registry and is operator-only); (b) symlink the repo-root node_modules into the temp tree (vitest + typescript already on disk via pnpm); (c) symlink only vitest/.pnpm/typescript/@types.

**Decided:** (b). Added `src/lib/{format,dateRange,permissions}.ts`, `src/server/events.ts`, `src/ui/timeline.ts`, `tests/{format,dateRange}.test.ts`, `vitest.config.ts`, a `package.json` test script + documentary vitest devDep, and `tests/**` in the corpus tsconfig include. `materializeCorpus` removes any copied corpus `node_modules` cache and symlinks the repo-root `node_modules` into the temp tree after the recursive copy, so the baseline's `pnpm vitest run` resolves offline with ZERO registry at run time. The seed deliberately fails the new signal (`dateRange` closed-interval bug, and T01's missing parameter is caught by the corpus typecheck/type-level test), so the suite is not vacuous. Existing T03 modules are left byte-identical.

**Why:** The deps already exist on disk; resolution is the only gap. No `pnpm install`, no registry, no per-trial dependency cost. The whole-node_modules symlink did not need the narrower fallback in this environment.

**Design-doc impact:** none — implements spec § Fixtures + Open Question 2; supersedes the "Baseline temp-checkout" entry's "no install/symlink required" clause (the corpus now has a vitest suite, exactly its named Revisit condition).

**Revisit when:** the corpus gains real runtime (non-dev) deps, an SDK/vitest upgrade changes resolution, or the live baseline shows the symlink form needs to be the narrow (c) variant.

## 2026-05-15 — add_parameter shipped (Phase 1.5 D10 — tool)

**Context:** With BS15-B cleared by the callsite-resolution probe, the tool now fans an argument out to resolved direct callsites.

**Considered:** n/a — settled by spec; build record.

**Decided:** `packages/store/src/addParameter.ts` follows the spine: validate name/type/default via public-API parse; declaration edit inserts `name: type[ = default]` at the clamped position as a zero-width text-span edit; each direct callsite from `resolveCallsites` gets a zero-width arg-slot edit at the matching argument position (slot value = the parameter default if any else `undefined`); one `AddParameter` op row records affected = [declaration, ...callsiteStatements]. HOF/aliased reference identifiers are NOT edited, so the compiler flags arity/type breaks honestly rather than the tool silently mis-editing them.

**Why:** Clean spine extension for the declaration edit; the callsite fan-out reuses the BS15-B-cleared resolver and stays reference-graph based, not text search. The tool's deterministic guarantee is "every resolvable direct callsite gets an argument slot"; the semantic value remains the caller's per-site decision.

**Design-doc impact:** none — implements spec § tool specs / `add_parameter`.

**Revisit when:** a live T01 round shows a callsite shape the resolver misses (re-probe before assuming a wall — BS15-B discipline).

## 2026-05-15 — add_parameter callsite resolution probed; BS15-B did NOT fire (Phase 1.5 D10 — probe)

**Context:** BS15-B: the genuine-new-work risk of Phase 1.5. `node_references` resolves reference identifiers, not enclosing CallExpression argument lists.

**Considered:** (a) accept BS15-B as a substrate wall; (b) investigate whether re-parsing the referring statement + walking up from the reference identifier to its enclosing call (callee === that identifier) reliably resolves callsites, with HOF/aliased uses correctly classified as non-argument arity-risk sites.

**Decided / Observed:** (b). `packages/store/src/callsites.ts` `resolveCallsites(db, functionId)` resolves direct and template-literal callsites and correctly classifies `.map(formatTimestamp)` and `const f = formatTimestamp` as `nonCallReferences` (compiler-flagged arity breaks, never silently mis-edited). The probe fixture produced counts `{ resolvedDirectCallsites: 2, arityRiskReferences: 2, unresolvedReferences: 0 }`; import-specifier references are ignored as import edges, not callsites or arity-risk sites. Public TS APIs only (BS1 discipline). The substrate's reference-integrity pitch holds for callsite fan-out on the T01 stress shapes tested here.

**Why:** A missed callsite must not be papered over with text search — that abandons the substrate's whole argument. The probe is isolated and early so a fired signal stops the phase before the tool is built.

**Design-doc impact:** none — confirms the spec crux's add_parameter feasibility argument held in implementation.

**Revisit when:** the T01 corpus or live round surfaces a callsite shape (e.g. re-exported-then-called, decorator) the walk-up misses — re-probe before assuming a wall, same as BS1.

## 2026-05-15 — replace_body shipped; input is validated body text, not structured AST (Phase 1.5 D9, Open Question 3)

**Context:** Phase 1 stores bodies as raw text and renders canonically; `replace_body` needs an input shape.

**Considered:** (a) structured AST body input + a body-construction API + structured render path; (b) validated `{ ... }` body text the tool syntactically pre-checks.

**Decided:** (b). `packages/store/src/replaceBody.ts` takes a body string including braces, wraps it as `function __probe__() <body>` + `ts.createSourceFile`, requires one `ts.Block` consuming the whole text and zero compiler syntactic diagnostics through the public `ts.createProgram` API, then queues one whole-body `textSpanMutation` + one `ReplaceBody` op row (params: function_id + new_body_len; the literal body is recoverable from the post-commit payload). Interior identifiers of the new body are NOT lowered/re-resolved into `node_references` — the same limitation Phase 1 documented; validate-before-commit is the safety net (a body referencing something undefined fails tsc and commit blocks). Identical-body / non-FunctionDeclaration / no-body are no-op/throw.

**Why:** Matches the storage model; (a) is the deferred Phase 2 lowering and out of scope. T05's fix is a single-statement comparison flip with no new cross-module references, so the interior-reference caveat does not bite the control.

**Design-doc impact:** none — implements spec § tool specs / `replace_body` + Open Question 3.

**Revisit when:** a task needs interior-reference integrity after `replace_body` (logged Phase 2 decision; would be BS15-A if T05 needed it — it does not).

## 2026-05-15 — change_return_type shipped on the rename spine (Phase 1.5 D8)

**Context:** Phase 1.5's lowest-risk tool: change a function declaration's return-type annotation.

**Considered:** n/a — settled by spec; this records the build shape.

**Decided:** `packages/store/src/changeReturnType.ts` follows the `rename.ts` spine: declaration lookup → `locateSpan(payload,"returnType")` → one `textSpanMutation` (replace existing annotation, or insert `: T` after the param list `)` when absent) → one `ChangeReturnType` op row. Identical-type and non-FunctionDeclaration are no-op/throw, mirroring `rename_symbol`. The tool edits ONLY the annotation; caller repair is agent reasoning (T08 framing), not a tool fan-out. Type validity is a public-API syntactic pre-check (wrap + `ts.createSourceFile` + compiler syntactic diagnostics through `ts.createProgram`), not a hand-rolled grammar or internal parser diagnostics.

**Why:** Clean spine extension on the Task 1 overlay + Task 2 locator; no lowering (BS15-A did not fire for this tool).

**Design-doc impact:** none — implements spec § tool specs / `change_return_type`.

**Revisit when:** a task needs the tool to also repair callers (it does not — that is agent reasoning per spec/T08).

## 2026-05-15 — On-demand re-parse span location, no ingest lowering (Phase 1.5 D7, Open Question 1)

**Context:** The three tools must locate parameter-list / return-type / body spans inside a function declaration on the current statement-raw-text + identifier-child model.

**Considered:** (a) extend ingest to lower parameters/bodies/return-types into structured nodes; (b) locate spans on demand by re-parsing the statement's own stored raw payload with `ts.createSourceFile` + public `getChildren`.

**Decided:** (b). `packages/store/src/spanReparse.ts` exports `locateSpan(payload, "params"|"returnType"|"body")`. The payload IS `statement.getFullText`, so re-parsed offsets are payload offsets directly; absent return type / empty param list return a zero-width insertion span. Public TS APIs only (`createSourceFile`, `getChildren`, `getStart`/`getEnd`); no internal properties, no `forEachChild`+`.jsDoc` (BS1 discipline).

**Why:** Exact and schema-free; structured lowering is deferred Phase 2 work and not needed for the three tasks. One source of truth so the tools don't each hand-roll re-parse.

**Design-doc impact:** none — additive store helper.

**Revisit when:** a tool needs structured nodes rather than a text span (BS15-A — stop and surface).

## 2026-05-15 — textSpanMutations overlay + generalized spliceStatement (Phase 1.5 D6, Open Question 1)

**Context:** Phase 1.5's three tools edit non-identifier regions (parameter list, return type, body) of a statement's raw payload. Phase 1's overlay was identifier-text only.

**Considered:** (a) structured AST-node lowering of params/bodies/return-types; (b) generalize the existing text-splice mechanism to arbitrary text spans, with identifier mutation as the degenerate case.

**Decided:** (b). `TxOverlay` gains `textSpanMutations: Map<statementId, TextSpanEdit[]>` where `TextSpanEdit = { start, end, oldText, newText }`; `IdentifierMutation` is the degenerate span. `spliceStatement`, render, and `commitWithoutValidate`/`materializeStatementPayloads` apply text-span edits with the same descending-offset, oldText-checked algorithm Phase 1 used; identifier offsets reshift by the net text-span delta. `TextSpanEdit` is owned by `@strata/store`; `render` consumes it (keeps `render → store` one-directional, no cycle).

**Why:** The statement payload is verbatim source, so a span edit on it is exact and needs no schema change; the splice already did descending-offset oldText-checked edits. Structured lowering is real Phase 2 work and unnecessary (per-tool argued in the spec crux). Behavior-preserving for `rename_symbol`: every pre-existing rename/agent/replay/T03 test stays green unchanged (the regression net).

**Design-doc impact:** none — additive overlay generalization; supersedes the Phase 1 "Transaction overlay stores identifier text mutations in memory" entry's narrowness (text-span is the superset).

**Revisit when:** a tool needs structured parameter/body/return-type node lowering rather than text-span edits (that is BS15-A — stop and surface, do not half-lower).

## 2026-05-15 — First T03 benchmark round: substrate beats file-based baseline on every metric (BS-Bench-A/C/D resolved)

**Context:** First keyed live benchmark round (operator-run, `bench:t03`), `claude-sonnet-4-6`, validation N=1 then distribution N=3 per config. Same verbatim T03 prompt, same model, same 10-criterion shared bar, same success scoring core for both configs. Resolves the operator-pending bail signals from the D5 entry below.

**Result (N=3, both configs 3/3 success, 0 retries, tsc+vitest clean 3/3):**
- Total tokens — substrate raw [1201, 1270, 1473] (mean 1315) vs baseline [4450, 4514, 4682] (mean 4549). Distributions **disjoint** (substrate max 1473 < baseline min 4450), ~3.5x fewer.
- Wall time — substrate 24.6–30.3s vs baseline 57.4–59.4s. Disjoint, ~2.2x faster.
- Tool/edit invocations — substrate 7–11 vs baseline 25–27. Disjoint, ~3x fewer.
- Cost/run — substrate ~$0.038 vs baseline ~$0.184, ~4.9x cheaper. Round spend: $0.26 (N=1) + $0.67 (N=3) = $0.93 total.

**Bail signals:**
- **BS-Bench-A — cleared.** The file-based baseline completed T03 successfully 3/3; the comparison is meaningful (a baseline that couldn't do the task would have made the numbers vacuous).
- **BS-Bench-C — cleared.** $0.93 for the full validation+distribution round; no cost explosion. N capped at 5, dry-run available.
- **BS-Bench-D — did NOT fire.** Distributions are cleanly separated, not swamped by variance. Had they overlapped at N=3 the report and this entry would record "no separable signal" — they do not. The report and this entry explicitly frame N=3 as an observed separation, **not** a statistical-significance claim; larger N is future work.

**Why this matters:** This is the core thesis of strata-design.md ("AI coding agents are bottlenecked by the file abstraction… a structural substrate makes agents fundamentally more efficient") demonstrated empirically on a real task: same model, same task, same success criteria, materially less work to the right answer, with no quality regression.

**Design-doc impact:** none — this is the evidence the design predicted. Feeds the eventual Phase 5 write-up. Raw per-round artifacts under `packages/bench/results/` are gitignored by intent (reproducible, cost-bearing, operator-run); this entry is the durable record of the finding.

**Revisit when:** the benchmark broadens past T03 (needs Phase 1.5 tools) or runs at larger N / multiple models — re-measure; a single-task N=3 separation is a strong directional result, not the final word.

## 2026-05-15 — Phase 4 verticalizes on the T03 substrate-vs-baseline benchmark (D5); BS-Bench-A/C/D operator-pending

**Context:** `@strata/bench` now runs the substrate (`runAgentT03`, reused as-is) and a file-tools baseline (temp copy of `examples/medium`) N trials each on T03, scores both through the shared `evaluateT03TextCriteria` core (BS-Bench-B gate green key-free), aggregates distributions, and writes artifacts via the operator-only key-gated `bench:t03` script. `strata-design.md` Phase 4 remains broader (10 tasks); this is the verticalized T03-only slice the spec settled.

**Considered:** n/a — verticalization is settled by the approved spec; this is the build record plus the bail-signal observation status.

**Decided / Observed:** Deferred: no API key in this environment; the live round is an operator action via `ANTHROPIC_API_KEY=... pnpm --filter @strata/bench bench:t03 -- --trials=3`. All harness logic (scorer-equivalence BS-Bench-B gate, metrics/distribution math, retry counter, report, temp-tree materialization, and resultQuality probes) is green key-free. BS-Bench-A (whether the baseline can complete T03 with file tools), BS-Bench-C (actual per-round/per-run cost), and BS-Bench-D (whether distributions overlap or separate at N=3-5) are explicitly operator-pending and must be recorded from round one regardless of outcome. Runner module-system guard form used: CommonJS `require.main === module` with `__dirname` because `tsconfig.base.json` is `module: "CommonJS"`. Baseline SDK form used: `tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"]`, `systemPrompt: { type: "preset", preset: "claude_code" }`, `settingSources: []`, `strictMcpConfig: true`, `mcpServers: {}`.

**Why:** BS-Bench-A/C/D are measurement findings recorded from the real live round, never inferred from skipped logic. The substrate path was not modified; `runAgentT03` remains the substrate. The CommonJS guard preserves script-only execution without using `import.meta`, and the baseline SDK options make the contrast file-tools-yes / Strata-tools-no / ambient-MCP-no.

**Design-doc impact:** none — `strata-design.md` Phase 4 remains the broader target; this records the implemented verticalized slice and the operator-pending live round.

**Revisit when:** the operator completes the keyed live round (record actual BS-Bench-A/C/D observations as a new newest-first entry if this deferred form was already committed), N is raised as a budgeted operator decision, or Phase 4.5 widens to a second task.

## 2026-05-15 — Baseline temp-checkout = recursive copy plus git init; file tools pinned (D4, Open Question 3)

**Context:** Phase 4's baseline needs an isolated, writable, real `.ts` tree with the corpus tsconfig/package.json and working `tsc --noEmit`. Open Question 3 left clone-vs-copy and corpus-deps handling to implementation.

**Considered:** `git clone --depth=1 file://`; recursive copy + `git init`; recursive copy only.

**Decided:** Recursive `cpSync(corpusRoot, tmp, { recursive: true })` into an OS temp dir, then `git init` in that temp tree for live operator runs. The baseline needs no repo history; `examples/medium` is a no-emit corpus with no own vitest suite and no runtime deps, so no `pnpm install`/symlink is required. Unit tests pass `initGit: false` so key-free tests do not run git. The SDK tool surface is the explicit allow-list `["Read", "Write", "Edit", "Glob", "Grep", "Bash"]` with `systemPrompt: { type: "preset", preset: "claude_code" }`, `settingSources: []`, `strictMcpConfig: true`, and no Strata MCP server.

**Why:** Copy is the minimal mechanism that gives an isolated writable real tree; `git init` gives Claude Code a repository-shaped workspace without depending on repository history. Pinning the tool list keeps the fairness invariant auditable: same model, same task prompt, same success bar; vary substrate vs. files, not ambient MCP servers.

**Design-doc impact:** none — implements spec § "Baseline config" / Open Question 3.

**Revisit when:** the corpus gains its own runtime deps or vitest suite, an SDK upgrade changes `Options.tools`/`systemPrompt` semantics, or the operator live run shows Claude Code requires different plain-file-tool scoping.

## 2026-05-15 — Symmetric T03 retry/failure counting rule shipped as specified (D3, Open Question 1)

**Context:** `docs/benchmarks.md` Open Questions flags that "retry" is undefined for the file baseline, so the metric is meaningless without a concrete rule. The Phase 4 spec proposed a symmetric definition.

**Considered:** count every failed tool call (over-counts a single self-correction as 3); count only explicit substrate commit blocks (no file analog); the spec's "failed verification + subsequent mutation = one self-correction" rule.

**Decided:** Shipped the spec's rule. Substrate retry = a `validate` returning diagnostics OR `commit_transaction` `{ ok:false }`, followed by a further mutating tool call (`rename_symbol`/`begin_transaction`/`rollback_transaction`). Baseline retry = a `tsc`/`vitest`/test Bash run exiting non-zero OR a re-edit of an already-edited file, followed by a further `Edit`/`Write`. A failed check with no subsequent mutation is NOT a retry.

**Why:** Symmetric on each side's native verify/edit primitives, derivable from each config's session log with no extra instrumentation, resilient to differing tool vocabularies. The worked example (one failed validate -> rollback -> corrected rename) counts as ONE, matching the spec's stated intent.

**Design-doc impact:** none — resolves `benchmarks.md` Open Question; the rule is reported alongside the metric so a reader can audit it.

**Revisit when:** the first live round's logs (operator, Task 9) show mis-classification — a corrected rule is then logged as a NEW newest-first entry, never silently retuned.

## 2026-05-15 — @strata/bench created; T03 scorer core stays in @strata/verify (D2)

**Context:** Phase 4's harness needs a package. `strata-design.md` § "Project layout" reserves `packages/bench`. The shared scorer core (D1) could nominally live in `bench`.

**Considered:** (a) put `evaluateT03TextCriteria` in `bench`; (b) keep it in `@strata/verify` and have `bench` import it from the verify barrel.

**Decided:** (b). `packages/bench` (`@strata/bench`) depends on `@strata/agent`/`@strata/verify`/`@strata/ingest`/`@strata/render`/`@strata/store` + the SDK + zod, NOT `@strata/cli`. The scorer core stays in `@strata/verify`.

**Why:** (a) cycles: `verify`'s own `evaluateT03Criteria` needs the core, and `agent`->`verify`, `bench`->`agent`/`verify`. Keeping it in `verify` keeps the graph acyclic (`bench` -> `agent` -> ... -> `verify`; `bench` -> `verify`) and lets `bench` reach the core via the barrel with no `cli` edge and no deep `dist/` import. The scorer core must NOT be relocated to `bench` later.

**Design-doc impact:** none — additive package on the reserved `packages/bench` slot.

**Revisit when:** a non-T03 benchmark task is added (the harness generalizes; the T03 scorer does not move).

## 2026-05-15 — T03 text-criteria core extracted (evaluateT03TextCriteria) in @strata/verify (D1)

**Context:** Phase 4 needs the substrate and the file-based baseline to score the nine text-derived T03 criteria through identical logic, or the comparison is invalid (BS-Bench-B). The nine criteria were inlined inside `evaluateT03Criteria`, coupled to `db`/`batch`.

**Considered:** (a) duplicate the regexes in the bench baseline adapter; (b) extract a pure `Map<modulePath,text>`-taking core in `@strata/verify` that `evaluateT03Criteria` delegates to and the baseline adapter also calls; (c) move the scorer into the new `@strata/bench`.

**Decided:** (b). `packages/verify/src/t03Criteria.ts` now exports `evaluateT03TextCriteria(modules)` (the nine text criteria, regexes verbatim) and `T03TextCriteria`. `evaluateT03Criteria` keeps its signature, builds the rendered-text Map from `db`/`batch` exactly as before, delegates the nine, and adds `commitReturnedOk`/`validateAfterCommitClean`/`operationRowAppended` unchanged.

**Why:** A single pure core called by both adapters makes "T03 succeeded" mean exactly the same thing for substrate and baseline. (c) was rejected: it would cycle (`verify` needs the core; `agent`->`verify`; `bench`->`agent`/`verify`). The core MUST stay in `@strata/verify` — moving it to `bench` later would reintroduce the cycle; do not "tidy" it there.

**Design-doc impact:** none — refactor only; `evaluateT03Criteria` signature/behavior unchanged, `cli` `t03.test.ts` and `agent` `replay.test.ts` green unchanged.

**Revisit when:** T03 grows criteria, or a fourth caller needs the core.

## 2026-05-15 — Agent hermetic isolation: `LSP` disallowed + `strictMcpConfig`/`settingSources` required

**Context:** Phase 3 live BS-A run. With `tools: []` (documented as "disable all built-in tools"), the runtime invariant guard still tripped — first on an injected `LSP` tool, then (after fixing that) on `mcp__claude_ai_Breeze__*` tools leaking in from the operator's `~/.claude.json`. Both violate the CLAUDE.md invariant that the agent's only tools are the in-process Strata ones and its world is the node graph, not files. The bail-signal guard caught this; it was NOT relaxed.

**Considered:**
- Relax the runtime guard to allow `LSP` / ambient MCP tools — rejected: papers over a real invariant violation and would invalidate the benchmark (an `LSP` tool inspects real files; Breeze tools perform arbitrary RMM actions).
- Whack-a-mole add every ambient tool to a banned list — rejected: not hermetic, brittle.
- Use the SDK's own hard-removal/isolation mechanisms — chosen.

**Decided:** In `runLiveSession` options: (1) add `"LSP"` to `BANNED_BUILTINS` (fed to `disallowedTools`, the SDK's documented "removed from the model's context and cannot be used" path) — `tools: []` does not strip `LSP` in `@anthropic-ai/claude-agent-sdk@0.2.118`; (2) set `strictMcpConfig: true` — in the underlying Claude CLI this means "use only the explicitly-passed MCP servers, ignore all other sources"; without it the SDK inherits `~/.claude.json` servers (Breeze); (3) set `settingSources: []` explicitly (documented default when omitted, set to make hermetic intent unambiguous). After these, the strict guard passes live and the agent completes T03 through only the 8 Strata tools.

**Why:** Enforces the invariant via the SDK's own mechanisms rather than weakening the check. Documents two installed-SDK-vs-docs gaps (the Phase 3 spec already flagged this class of risk): `tools: []` does not cover `LSP`; `strictMcpConfig`'s type doc says "strict validation" but its operative effect is MCP source isolation.

**Design-doc impact:** none — confirms strata-design.md § "The Agent" ("no file tools ... entire world is the node graph") is enforceable on this SDK with explicit isolation options.

**Revisit when:** upgrading `@anthropic-ai/claude-agent-sdk` (re-verify `tools: []`/LSP/`strictMcpConfig` behavior — these are version-observed, not type-guaranteed), or if a future SDK injects another ambient tool the guard catches.

## 2026-05-15 — Phase 3 verticalizes on agent-drives-T03 (D5)

**Context:** Phase 3 now has `@strata/agent` wrapping the existing store/verify spine as eight in-process SDK tools, a static worldview prompt, session logging, a headless `query()` live path configured with `tools: []`, and a deterministic replay path that passes all 11 shared `evaluateT03Criteria` checks. The design doc's Phase 3 remains broader than this slice.

**Considered:** broaden to the full benchmark harness, more tools, and the Claude Code baseline now; or ship the single agent-drives-T03 vertical slice and broaden in Phase 3.5/4.

**Decided:** single vertical slice. Phase 3 verticalizes on the proven `rename_symbol` T03 spine with no filesystem tools. Broadening to more tasks, more tools, and baseline comparison is Phase 3.5/4.

**Why:** Verticalizing isolates agent/SDK-integration risk from substrate risk. The substrate was already green for T03, so this run focuses on whether a Strata-only tool loop can drive the same outcome. The no-key replay path proves the substrate outcome deterministically. BS-A and the live half of BS-B are not claimed from skipped tests; they remain operator-pending keyed runs. BS-C cost capture wiring exists in the session log and will be populated by the operator's keyed run.

**Design-doc impact:** none — `strata-design.md` Phase 3 remains the target; this records the implemented first slice.

**Revisit when:** the operator completes the keyed live acceptance, Phase 3.5 adds a second tool/task, or Phase 4 builds the baseline comparison.

## 2026-05-15 — Phase 3 acceptance determinism: recorded-transcript replay (D4)

**Context:** The agent T03 acceptance test calls a live model, but CI must be deterministic and key-free.

**Considered:** key-gated live-only with a retry budget; or record a live transcript and replay the tool-call sequence through the real handlers so the store outcome is a pure function of the sequence.

**Decided:** Use replay. `runAgentT03` supports a replay path that re-executes `{ tool, args }` steps through the real Strata handlers and substitutes `"$TX"` with a fresh transaction handle. The committed fixture at `packages/agent/tests/fixtures/agent-t03-transcript.jsonl` is clearly labeled as a synthetic placeholder because this environment has no key; it keeps key-free CI exercising the full replay path and all 11 criteria. The operator replaces it with a real keyed live recording using `pnpm --filter @strata/agent build && ANTHROPIC_API_KEY=... pnpm --filter @strata/agent record:t03-fixture`.

**Why:** Replay keeps CI deterministic without secrets while a real live run remains the source of truth once recorded. The store outcome is a pure function of the recorded tool-call sequence, so replay is a faithful substrate-outcome reproduction, not a mock. The current placeholder is not represented as a real agent run; live confirmation remains operator-pending.

**Design-doc impact:** none — implements spec § "Acceptance test" / Open Question 2.

**Revisit when:** the SDK changes how tool calls are surfaced, the T03 corpus changes, or the operator regenerates the placeholder from a successful live run.

## 2026-05-15 — Phase 3 agent drives T03 live: BS-A / BS-C observation

**Context:** Phase 3 Task 10 wires the headless agent against the verbatim T03 prompt with only the eight Strata tools and `tools: []`.

**Considered:** n/a — this is a bail-signal observation entry, not a design choice.

**Decided / Observed:** Deferred in this environment: no Anthropic API key or Claude Code OAuth token is available, so the live BS-A run is an operator action. The live half of BS-B is likewise pending keyed confirmation from the SDK session. The CI proof for substrate outcome is the replay path added in Task 11. BS-C: token, cost, and wall-time numbers are pending the operator live run, but the session log now captures `SDKResultMessage` usage, per-model usage, total cost, and duration fields.

**Why:** BS-A is the substrate-agent-fit signal; BS-C is a primary Phase 4 cost signal. Both must be recorded from a real live run, not inferred from skipped tests.

**Design-doc impact:** none.

**Revisit when:** the operator runs the keyed live acceptance, the prompt is iterated again, the tool set is widened, or Phase 4 benchmarking begins.

## 2026-05-15 — Phase 3 SDK session integration shape pending live confirmation (D3)

**Context:** Phase 3 BS-B asks whether the SDK runs headless with only custom in-process tools and `tools: []`, and whether tool results compose with our transaction model. Task 4 cleared the tool loop at the handler layer with no model; Task 5 adds the live one-tool session probe.

**Considered:** trust BS4 (schema-only) and build the full orchestrator directly; or probe a minimal one-tool session first.

**Decided:** probe-first. `packages/agent/src/session.ts` implements a single-yield async-generator prompt and `collectSession(...)` over the public `query(...)` API. `packages/agent/tests/sessionSmoke.test.ts` registers an in-process `createSdkMcpServer` with one `ping` tool, runs with `tools: []`, `allowedTools: ["mcp__probe__ping"]`, `bypassPermissions` + `allowDangerouslySkipPermissions`, `maxTurns`, and an `abortController`. Result: pending-live-confirmation — this environment has no API key, so the live SDK probe is skipped until the operator runs it with `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.

**Why:** The session/loop is the part BS4 did not exercise. Probing one tool isolates "the SDK headless loop composes" from "our eight tools / system prompt are right" before the full orchestrator. The no-key surface remains covered by Task 4's direct handler test; BS-B live confirmation is not claimed from a skipped test.

**Design-doc impact:** none — confirms the intended integration shape in code, with live confirmation pending.

**Revisit when:** the keyed Task 5 probe runs, an SDK upgrade changes `query`/`Options.tools`/MCP server handling, or the full Task 10 session reveals loop behavior the one-tool probe did not.

## 2026-05-15 — `read_node` added to @strata/store for the Phase 3 agent

**Context:** Phase 3's `read_node` tool needs "a node plus optional shallow children". `@strata/store` exposed `findNodeById` and `listChildren` separately; the agent must not reach into store internals.

**Considered:** (a) compose `findNodeById`+`listChildren` inside `packages/agent`; (b) add a public `readNode`/`read_node` to `@strata/store`.

**Decided:** (b). `packages/store/src/read_node.ts` exports `readNode(db, id, { includeChildren? })` (alias `read_node`) returning `{ node, children? }`.

**Why:** Keeps the dependency edge clean (`agent -> store` public surface only) and matches the spec's note that this helper belongs in `store`, not in `agent`. Minimal: one level of children, no recursion (Open Question 1 — widen only if agent behavior shows it's needed).

**Design-doc impact:** none — additive public API on an existing package.

**Revisit when:** the agent's transcript shows it repeatedly needs deeper traversal than one child level (then it becomes a logged tool-widening decision per Open Question 1).

## 2026-05-15 — T03 scoring extracted to `@strata/verify`

**Context:** Phase 3 needs the agent path and the programmatic `cli t03` path to score against identical logic so the agent cannot be given a weaker or vacuous check. The scoring block was inlined inside `runT03`, and Plan Amendment 1 moved the shared scorer boundary from `@strata/cli` to `@strata/verify`.

**Considered:** (a) duplicate the regex/operation checks in the agent test; (b) extract the post-commit scoring into `@strata/cli`; (c) extract it into `@strata/verify` and export it through the verify barrel.

**Decided:** (c). `packages/verify/src/t03Criteria.ts` exports `evaluateT03Criteria(db, batch, srcRoot, input)` and `emptyT03Criteria()`, re-exported from `@strata/verify`. `runT03` keeps driving the rename + post-commit re-validate itself and passes `commitReturnedOk`/`validateAfterCommitClean`/`renameTxId` in; the regex/operation-row scoring moved behavior-preservingly.

**Why:** `@strata/verify` already owns validation and depends on the store/render surface the scorer needs, while both `@strata/cli` and the Phase 3 agent can consume it without creating an `agent -> cli` dependency or a fragile deep `dist/` import. The 4th `input` arg keeps the function pure while letting each caller feed in its own commit outcome.

**Design-doc impact:** none — refactor only; `RunT03Result` shape unchanged, existing `t03.test.ts` unchanged and green.

**Revisit when:** T03 grows additional criteria, or Phase 4 creates a dedicated `@strata/bench` package that should own benchmark-acceptance logic.

## 2026-05-15 — Phase 1 verticalizes around `rename_symbol`

**Context:** Phase 1 completed Tasks 10-14 after the substrate pieces from Tasks 0-9 were already green. The design doc's Phase 1 remains broader than this run's implemented mutation surface.

**Considered:**
- Implement the whole Phase 1 mutation set now.
- Ship the single `rename_symbol` vertical slice with the infrastructure it forced, then broaden later.

**Decided:** Phase 1 ships as the `rename_symbol` vertical slice: identifier-level ingest, TypeChecker references, transactions, operation log, render splicing, `@strata/verify` validate-before-commit, CLI smoke commands, and the T03 acceptance path.

**Why:** The T03 path exercises the load-bearing substrate without prematurely designing every mutation. The stable-ID, overlay, JSDoc traversal, source-map, validation, and SDK-schema decisions have all been tested against the same hero operation.

**Design-doc impact:** none for now. `strata-design.md` still describes the broader target; this records the implemented Phase 1 slice.

**Revisit when:** Phase 1.5 adds the second structural mutation and tests whether the same transaction/reference/render spine generalizes.

## 2026-05-15 — BS4 cleared with SDK Zod tool schemas

**Context:** Phase 1 Task 12 probed whether `@anthropic-ai/claude-agent-sdk` can express the future Strata tool shapes before Phase 3 agent work starts.

**Considered:**
- A hand-written JSON-schema-shaped smoke object only.
- A smoke harness that also type-checks against the SDK's real `tool(...)` / `SdkMcpToolDefinition` API.

**Decided:** Use the SDK's typed `tool(...)` surface with explicit Zod schemas for `TxHandle`, `NodeId`, and `Diagnostic[]`, plus a serializable `sdk-smoke` command output for inspection.

**Why:** The installed SDK exposes `tool` and accepts Zod raw-shape schemas. The smoke harness type-checks and runs, so BS4 is cleared without inventing a custom schema representation.

**Design-doc impact:** none — this confirms the planned Phase 3 SDK direction remains viable.

**Revisit when:** Phase 3 adds the real agent tool registry, or an SDK upgrade changes `SdkMcpToolDefinition` / `tool(...)`.

## 2026-05-15 — Validate uses the nearest corpus tsconfig before root defaults

**Context:** Phase 1 Task 11 T03 initially failed validation before any rename-specific check: `examples/medium` imports `.ts` extensions and uses `import.meta` / top-level await, but `@strata/verify` was compiling rendered files with the monorepo `tsconfig.base.json` CommonJS defaults.

**Considered:**
- Keep using only `tsconfig.base.json` and special-case T03.
- Load the nearest `tsconfig.json` from the rendered module paths, falling back to `tsconfig.base.json` when no corpus config exists.

**Decided:** `@strata/verify` now loads the nearest corpus `tsconfig.json` for rendered module roots and falls back to `tsconfig.base.json`.

**Why:** The corpus already compiles cleanly under its own `examples/medium/tsconfig.json`; validation should check rendered output under the same compiler options as the corpus, not unrelated package defaults. This was an implementation bug, not a TypeChecker resolution wall.

**Design-doc impact:** supersedes the earlier Phase 0 assumption that one root base config is enough for verification.

**Revisit when:** validation spans multiple package roots with incompatible configs.

## 2026-05-15 — BS2 T03 timing recorded below total-run threshold

**Context:** Phase 1 Task 11 timed the built T03 path: ingest `examples/medium`, rename `User` to `Account`, validate through `@strata/verify`, commit, and assert acceptance criteria.

**Considered:** Stop if the run exceeded the plan's total-run timing note or if a single-module ingest / affected-node transaction clearly crossed the BS2 thresholds.

**Decided:** Continue. The final built command reported `wallTimeMs = 511.3`; `/usr/bin/time -p` reported `real 0.69`, `user 1.21`, `sys 0.06`.

**Why:** The full command is well below the plan's 5s T03 total-run note, and no single 2k-LOC ingest or ~50-node transaction threshold was clearly exceeded by this fixture.

**Design-doc impact:** none.

**Revisit when:** T03 grows to the intended ~15 modules / ~40 type positions, or validate timing becomes agent-loop visible.

## 2026-05-15 — Render source maps are per-module statement spans

**Context:** Phase 1 Task 9 moved validation into the new `@strata/verify` package and maps TypeScript diagnostics from rendered files back to graph nodes.

**Considered:**
- A per-module source map of rendered byte spans to renderable node IDs.
- A deeper identifier-level source map that maps diagnostics directly to Identifier nodes.

**Decided:** `renderWithSourceMap` returns `Array<{ renderedStart; renderedEnd; nodeId }>` sorted by `renderedStart` for each module. `@strata/verify` keys those maps by rendered module path and binary-searches the span containing `diagnostic.start`. In Phase 1 those entries point to renderable statement/EOF nodes; Identifier rows remain splice inputs rather than source-map targets.

**Why:** TypeScript diagnostics are file-position based, and statement-level mapping is enough to make validate failures actionable for the rename slice. Identifier-level mapping can be layered on later without changing the per-module map contract. The BS3 probe on the two-module validate corpus took 322.9ms cold and returned one mapped diagnostic for the intentional half-rename, below the 500ms bail threshold, so a fresh `ts.Program` per validate call remains acceptable.

**Design-doc impact:** none — this locks in the Phase 1 source-map shape without changing `strata-design.md`.

**Revisit when:** diagnostics need to drive automatic repair at identifier precision, or validate on the medium corpus crosses the BS3 threshold.

## 2026-05-15 — Transaction overlay stores identifier text mutations in memory

**Context:** Phase 1 Task 6 implemented transactions for the `rename_symbol` slice.

**Considered:**
- Store full replacement `NodeRow` values in the overlay keyed by node ID.
- Store only identifier-text mutations keyed by identifier node ID, plus pending operation rows.

**Decided:** The Phase 1 overlay is an in-memory `identifierMutations: Map<identifierId, { text }>` plus `pendingOps: PendingOp[]`, keyed by `tx_id`. `commitWithoutValidate` materializes those text mutations into canonical Identifier payload rows. Open transactions do not survive process restart; startup recovery marks persisted `status='open'` rows as `rolled_back`.

**Why:** The public Task 6/9 mutation surface queues identifier updates without a database handle, so it cannot safely construct full replacement rows at queue time. The canonical offset and statement splice context stay in the store rows until validate/commit materializes the transaction view. This preserves the Phase 1 rename invariant while keeping the overlay small and tied to operation intent.

**Design-doc impact:** none to `strata-design.md`; this records a narrower implementation shape than the plan's full-`NodeRow` overlay option.

**Revisit when:** mutations need non-identifier replacements, or read APIs must expose a fully overlay-merged graph view before commit.

## 2026-05-15 — BS1 probed and cleared: AST traversal must use `getChildren`, not `forEachChild` + internal `.jsDoc`

**Context:** Phase 1 Task 4. The BS1 probe ("resolves the JSDoc `@param {User}` identifier") fired: the resolver resolved 5 of 6 `User` references, missing the JSDoc one. Per the spec this is a bail signal — stop, do not work around. Investigation followed before accepting the bail.

**Considered:**
- Accept BS1 as a true substrate wall (TypeScript can't do reference-aware rename through JSDoc) and re-spec.
- Investigate whether the miss is a substrate limitation or an implementation defect.

**Decided:** Not a true bail. Root cause is an implementation defect: the ingest/resolver traversal used `ts.forEachChild` (which deliberately skips JSDoc nodes) plus the **internal** `node.jsDoc` property as a workaround. The internal property is absent from TypeScript's public typings, so `tsc -b` failed outright; and even cast, `forEachChild` is the wrong traversal for JSDoc. A standalone probe (`/tmp/bs1-probe.mjs`) proved `checker.getSymbolAtLocation` **does** resolve JSDoc `@param {User}` and `@returns {User}` type-reference identifiers to their `InterfaceDeclaration` when the AST is walked with the public `node.getChildren(sourceFile)` API (which includes JSDoc). Resolution: all identifier traversal in `packages/ingest` uses a pre-order DFS over `node.getChildren(sourceFile)`; `ts.forEachChild` + `.jsDoc` is banned for identifier discovery.

**Why:** The spec's BS1 threshold is explicit — "if the workaround is no more than a different TypeChecker/AST method, continue." Switching `forEachChild`→`getChildren` is exactly a different AST method. The substrate (TS Compiler API) is sufficient for reference-aware rename including JSDoc; the bail signal correctly prevented a papered-over probe but the wall was illusory.

**Design-doc impact:** none — confirms the design's premise rather than changing it. Strengthens spec § "Open questions" Q1: TypeChecker accuracy is adequate for JSDoc type references.

**Revisit when:** a later identifier-bearing construct (e.g. template literal types, satisfies expressions) is missed by `getChildren` traversal — re-probe before assuming a wall, same as here.

## 2026-05-15 — Identifier lowering stops at TypeScript identifiers

**Context:** Phase 1 Task 3 added identifier-level ingest for `rename_symbol`, which needs addressable nodes for declaration and reference occurrences without turning the whole AST into graph rows.

**Considered:**
- Emit every `ts.Identifier` under each statement, including declaration names, type references, expression references, property names, and JSDoc identifiers surfaced by the TypeScript AST.
- Emit only rename-candidate identifiers after TypeChecker resolution.
- Add deeper expression/property-access lowering immediately.

**Decided:** Emit every `ts.Identifier` occurrence under a statement as an `Identifier` node with `{ text, offset }`, while leaving string literals, template literal text, and ordinary comment text out of the identifier layer. Identifier rows are non-renderable until the render splice work lands.

**Why:** The raw statement payload remains the canonical render path for now, and a shallow identifier layer is enough for Phase 1 rename resolution. Deferring filtering until Task 4 keeps ingest simple and lets the TypeChecker decide which identifiers are real references.

**Design-doc impact:** none — this locks in the Phase 1 plan's identifier emission boundary without changing the broader node graph direction.

**Revisit when:** later mutations need property-access member renames, expression-level edits, or comment-aware transformations outside JSDoc.

## 2026-05-15 — Stable node IDs use path plus structural child path

**Context:** Phase 1 Task 1 needs deterministic node IDs before identifier-level ingest and rename operations can preserve identity across non-structural mutations.

**Considered:**
- Path + structural-position hash: `modulePath`, dot-joined child index path, and node kind.
- Content-anchored IDs based on source text or syntax-node content.

**Decided:** Use `sha1(modulePath + ":" + childIndexPath + ":" + kind)`, truncated to 16 hex characters, implemented as the single `nodeId()` helper in `@strata/store`.

**Why:** This is deterministic across re-ingest of unchanged files and stable across Phase 1 rename mutations, which only change identifier text and do not alter parent/child shape. Content anchoring would better survive statement insertion, but it is more work than Phase 1's rename slice needs.

**Design-doc impact:** none yet — this resolves a Phase 1 plan-level open choice without changing the design direction.

**Revisit when:** operations need identity stability across structural edits such as inserted statements or moved declarations.

## 2026-05-14 — EOF trivia stored as a sibling `EndOfFileTrivia` node, not on the module

**Context:** Phase 0 ingest review found trailing trivia (comments/whitespace between the last statement's end and EOF) was silently dropped because `sourceFile.statements` doesn't include the `endOfFileToken`. A real codebase with a trailing footer comment would round-trip lossy without ingest noticing.

**Considered:**
- (a) Add a synthetic child node of kind `EndOfFileTrivia` at the highest `childIndex`, with the trivia text as its payload.
- (b) Attach the trivia to the module node (e.g., JSON-encode `{ path, trailingTrivia }` into the module payload).

**Decided:** (a). The module payload stays a plain string label, and rendering — which already orders children by `childIndex` — concatenates the trivia naturally as the last child.

**Why:** Keeps the module payload schema simple (still just a path string), avoids special-casing module payload parsing in render, and produces byte-identical round-trip on the new comment fixture and on all examples/small/*.ts. The trade-off is one extra node per module and a non-statement kind in the child list — fine because `EndOfFileTrivia` is structurally just another payload-bearing child for Phase 0.

**Design-doc impact:** none yet — Phase 0 is intentionally pre-schema. Lock in when the formal node-graph schema is written for Phase 1.

**Revisit when:** statement-level lowering lands and ingest no longer stores raw source text per child. The lowering for EOF trivia will probably remain "verbatim text" since it has no semantic structure, but the node kind may want renaming once other trivia kinds (between-statement comments, JSDoc) get their own representation.

## 2026-05-14 — Verify uses in-process TypeScript Compiler API, not subprocess `tsc`

**Context:** Phase 0 CLI initially shelled out to `npx tsc --noEmit` with hard-coded compiler options that didn't match `tsconfig.base.json`. Three problems: (1) PATH-dependent `npx` resolution, (2) the rendered output was being type-checked under different settings than the project's own build, (3) it contradicted the 2026-05-14 "TS Compiler API everywhere" decision logged below.

**Decided:** Verify is now in-process: `ts.createProgram([outputPath], options)` + `ts.getPreEmitDiagnostics(program)`. Compiler options are loaded from `tsconfig.base.json` via `ts.readConfigFile` + `ts.parseJsonConfigFileContent`. No subprocesses anywhere in `packages/cli`.

**Why:** Consistency with the parser/printer decision; one toolchain for parse, print, and verify. Also faster (no `npx` cold start), and the rendered output is checked under the same compiler options that the project's own packages build under.

**Design-doc impact:** Consistent with strata-design.md § Verify ("TypeScript Compiler API for in-process type checks"). The design doc was already correct — Phase 0's first cut diverged and has now been brought back in line.

**Revisit when:** multi-file verification is needed (Phase 2). The current implementation only type-checks the single rendered file; Phase 2 will need program-level verification across all rendered modules.

## 2026-05-14 — Use TypeScript Compiler API for parse + print in Phase 0 (drop tree-sitter and Prettier)

**Context:** Phase 0 bootstrap. The design doc specifies `tree-sitter-typescript` for parsing and `prettier` for canonical rendering, with the TS compiler API reserved for type-checking in `verify`.

**Considered:**
- tree-sitter + Prettier as specified.
- @swc/core (fast Rust parser with a built-in printer).
- TypeScript Compiler API (`typescript` package) for both parse and print, with Prettier added later only if style needs tightening.

**Decided:** Use the TypeScript Compiler API for both parse and print in Phase 0. No tree-sitter, no swc, no Prettier yet.

**Why:** The design's stated reason for tree-sitter is "round-trip preservation," but Strata renders canonically and discards original formatting — that benefit is moot for our pipeline. Meanwhile `verify` already needs the TS compiler API, so using it as the parser too collapses three toolchains into one. `ts.createPrinter()` produces serviceable canonical output; Prettier can be a post-pass when we have a reason to add it. Cuts dependencies, install time, and conceptual surface for a phase whose only goal is proving the pipeline.

**Design-doc impact:** Supersedes the Tech stack § "Parser" recommendation and the Render § "prettier" line *for Phase 0*. Will revisit at Phase 1 boundary; if expression-level lowering reveals TS-printer output to be inadequate, reopen.

**Revisit when:** (a) we need richer formatting control than `ts.createPrinter()` provides; (b) ingest perf becomes a bottleneck (swc); (c) we need incremental reparse for live editing (tree-sitter).
