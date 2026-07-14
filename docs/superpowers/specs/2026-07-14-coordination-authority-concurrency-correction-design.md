# Coordination authority and concurrency correction

**Status:** approved 2026-07-14

**Scope:** correct the Rust/redb coordination scheduler before the TypeScript validation bridge begins

**Supersedes:** the scheduler PASS recorded at implementation commit `1410eaa`

## Why this correction exists

The task-scoped scheduler reviews passed, but the final whole-branch review found that the integrated API did not prove the original multi-agent thesis:

1. Default callers could supply both `IntentAnalyzer` and `CandidateBuilder`. Because analyzer output defined the write and reservation scope, a caller could authorize an arbitrary node and return a matching delta. Raw storage publication was sealed, but semantic authority was not kernel-owned.
2. Two disjoint claims captured at generation 0 could not both publish. After the first advanced the global generation, the second failed the exact-generation check and remained `Executing` until cancellation or restart.
3. Candidate construction ran while the scheduler and publication locks were held. A future render/typecheck/test worker could therefore block every disjoint lifecycle operation for seconds or minutes.
4. Submission, reconsideration, expiry, cancellation, and claim-time terminal release could create `Ready` authority or release blockers without a fresh trusted analysis. Some offers could contain stale fingerprints, and some newly unblocked tickets could remain stranded.
5. Drafts and claims had no complete deterministic expiry model.

These are decision-grade failures. The existing deterministic tests remain useful evidence for durability, FIFO behavior, recovery, containment, and atomic commit mechanics, but the scheduler gate is no longer a PASS.

## Constraints

- Clients supply typed `IntentParameters`; they never supply analyzers, reservation keys, scope fingerprints, fences, or resource versions.
- TypeScript remains authoritative for production language semantics.
- Until the TypeScript bridge exists, default builds do not execute semantic coordination mutations.
- Deterministic semantic providers and test builders are injectable only through a non-default research feature.
- Candidate builders and validation workers are untrusted. Their output is data, never authority.
- Graph, operation, coordination, event, resource-version, idempotency, and fencing writes still commit in one redb transaction.
- FIFO, all-or-ticket reservations, service epochs, durable events, restart recovery, and the existing SQLite path remain intact.
- This correction does not add the TypeScript worker bridge, transport, authentication, task orchestration, multi-host consensus, or live model runs.

## Alternatives considered

### 1. Seal analyzer injection but retain global serialization

The kernel could own the analyzer while keeping exact global-generation checks and running the builder inside the publication critical section. This is mechanically smaller, but it still invalidates disjoint claims after unrelated commits and makes slow validation a global stop-the-world operation. Rejected.

### 2. Kernel-owned semantics with optimistic resource validation

The kernel owns semantic authority. Candidate construction runs without global locks. Publication revalidates the exact resources and indexes the intent depended on, rebases a still-valid delta onto the current generation, and commits through the existing short redb sequencer. Chosen.

### 3. Structural replay or merge

The kernel could replay or merge a candidate operation onto the newest graph. That requires conflict-resolution semantics and stable structural identity for insert/delete/move, expanding the proof into a merge engine. Rejected for this iteration.

## Trust boundary

### Default API

The default `strata-kernel` API exposes typed client operations but no way to construct or inject semantic authority.

- `submit_change_set`, `claim_ready`, reconsideration, and publication no longer take an analyzer argument.
- `IntentAnalyzer`, `IntentAnalysis`, and direct scope-analysis helpers are not exported by the default crate surface.
- `Kernel::create` and `Kernel::open` create a kernel without a production semantic provider. Semantic submit/claim/publish returns a typed `SemanticProviderUnavailable` error until the TypeScript bridge supplies the built-in production provider.
- Read-only graph access, draft creation, intent recording, event replay, and recovery remain available.
- The future TypeScript provider is implemented as a kernel-owned operation implementation selected internally from `IntentParameters`; it is not an arbitrary client trait object.

### Research feature

A non-default `coordination-test-api` feature exposes a constructor that installs deterministic test semantics. The feature is for key-free proof tests only and must not be enabled by a service build.

The research provider may implement a crate-defined trait, but the trait and constructor are unavailable under default features. A compile-fail test proves an external default crate cannot inject an analyzer or construct scope authority.

### Candidate output

`CandidateBuilder` remains an untrusted worker seam. It receives an immutable prepared request containing the typed intents, graph snapshot identity, attempt ID, and trusted scope fingerprint. It receives no redb handle, scheduler state, fencing token, or authority constructor.

It returns a candidate envelope containing only the proposed `GraphDelta` and a deterministic candidate digest. The kernel validates schema, dependency freshness, containment, candidate binding, and final graph integrity.

## Resource versions

Global graph generation remains canonical publication order and audit provenance. It is not, by itself, a conflict.

The kernel adds durable monotonic resource clocks and an equivalent in-memory projection. Initial clocks cover:

- `node:<id>`;
- `edge:<from-node-id>`;
- `children:<parent-id>`;
- `references-to:<target-id>`;
- symbol or module namespace buckets used by lookup and collision checks;
- explicit absence-query buckets used to prove that a declaration, reference, or name does not exist.

Every trusted analysis returns an `AuthorityPlan` containing read, write, validation, reservation, and dependency-version entries. The kernel augments the dependency set with every resource and index the proposed delta reads or mutates.

Each graph publication increments the clocks for every affected resource and derived index in the same redb transaction as the graph delta. Clocks never move backward or reuse a prior value, preventing ABA.

A candidate prepared at generation N may publish at generation N+k only when every recorded dependency clock still matches. If unrelated work changed no dependency, the kernel rewrites the candidate delta's base generation to the current generation and applies it. If any dependency changed, the candidate is discarded and the claim is reanalyzed; it never remains silently stranded in `Executing`.

## Optimistic candidate protocol

### Prepare

1. Briefly snapshot the immutable graph, scheduler revision, durable claim, service epoch, trusted scope, dependency clocks, and logical lease.
2. Assign or verify a durable attempt ID.
3. Release all publication and scheduler locks.

### Build

4. Run the untrusted candidate builder and future TypeScript validation worker against the immutable prepared request.
5. Builder failure or panic cannot mutate canonical state. The claim may be explicitly abandoned or allowed to expire, but its bounded lease prevents an immortal reservation.
6. Validate the returned envelope structurally and check preliminary delta containment against the trusted prepared authority.

### Revalidate and commit

7. Capture the current graph and scheduler revision, then run trusted semantic analysis outside global locks.
8. Prepare the rebased delta, tentative next immutable graph, release projection, and fresh successor analyses outside global locks.
9. Acquire locks in the universal order: publication mutex, then scheduler mutex, then redb write transaction.
10. Recheck graph generation, scheduler revision, service epoch, claim identity, lease, attempt, dependency clocks, candidate digest, scope, delta containment, and idempotency.
11. If the optimistic snapshot changed, release locks and retry the preparation loop. No semantic analysis or worker validation runs while global locks are held.
12. Commit resource clocks, graph, operation, ticket, claim release, events, idempotency, fences, and successor transitions in one redb transaction.
13. Publish the new in-memory graph and scheduler projection only after redb commits.

The retry loop is bounded. Repeated contention returns a retryable coordination result rather than holding a global mutex indefinitely.

## Centralized fresh readiness

Only one kernel planner may create a `ReadyOffer`. It accepts an immutable graph, scheduler snapshot/revision, durable typed intents, logical tick, and transition cause.

The planner:

1. simulates the triggering release or submission;
2. identifies potentially eligible queued tickets;
3. runs the kernel-owned semantic provider outside locks;
4. persists each fresh scope and dependency vector;
5. handles expansion counts and material changes;
6. recomputes FIFO/all-or-ticket selection from complete fresh scopes;
7. produces `IntentReady`, `ScopeExpanded`, or `IntentNeedsDecision` transitions;
8. applies the plan only if graph and scheduler revisions still match.

Every path uses this planner:

- initial submission;
- explicit reconsideration;
- ready-offer expiry;
- claim expiry or abandonment;
- cancellation;
- claim-time scope rejection or terminal release;
- successful publication and successor wakeup;
- post-restart reconsideration.

Recovery itself requeues reconstructable work but grants no `Ready` authority until the planner has performed fresh analysis.

## Logical leases and expiry

The host supplies deterministic logical ticks; tests never depend on wall-clock sleeps.

- Drafts record creation and expiry ticks. Expiry terminalizes the draft as cancelled, retains its audit record and intents, and emits a bounded `LeaseExpired` event with a draft-expired reason.
- Ready offers retain their existing bounded lease.
- Claims record attempt and expiry ticks. Expiry deletes active authority, fences late candidate results, requeues reconstructable work, emits `LeaseExpired`, and invokes centralized fresh readiness.
- Cancellation and service-epoch changes invalidate outstanding attempts even if a worker later returns a valid-looking delta.

## Idempotency and crash behavior

Publication identity is bound to the change set, attempt ID, and candidate digest.

- Repeating the same committed attempt and digest returns the original generation and digest.
- Reusing an attempt ID with a different candidate digest is rejected.
- A duplicate racing a finishing publication may build speculatively, but the final idempotency check admits only one commit.
- A crash before redb commit exposes the complete old graph and coordination state.
- A crash after redb commit is recovered from the operation, resource clocks, idempotency record, and durable lifecycle state.
- Restart advances the service epoch and rejects every old offer, claim, attempt, or delayed worker result.

## Deterministic acceptance gates

The correction is not complete until all of these pass on the real `examples/medium` fixture where applicable:

1. An external default-feature crate cannot import or inject semantic analyzer authority.
2. Default semantic execution without the TypeScript provider returns `SemanticProviderUnavailable` without side effects.
3. Two disjoint tickets are both claimed before either publishes; both candidates then commit successfully in either order.
4. Changes to a node, edge, parent/children index, references-to bucket, namespace bucket, and absence-query bucket each invalidate an affected stale candidate.
5. An invalidated claim is atomically requeued or moved to `NeedsDecision`; it never remains stranded in `Executing`.
6. A blocking or panicking builder does not block disjoint submit, claim, cancel, expiry, event replay, or reconsideration.
7. Malicious builder changes and reference retargets remain rejected by kernel-owned containment.
8. Table-driven tests cover fresh readiness after submission, publication, cancellation, offer expiry, claim expiry, claim rejection, reconsideration, and restart.
9. Late results after cancellation, expiry, or service restart cannot publish.
10. Draft and claim expiry survive restart and are idempotent.
11. Same-attempt/same-digest replay returns the original result; a changed digest is rejected.
12. Failure injection proves graph, resource clocks, operations, coordination, events, idempotency, and fences are complete-old-or-complete-new after reopen.
13. Existing FIFO, starvation, cursor, recovery, API-sealing, redb spike, and SQLite product tests remain unchanged and green except for already documented unrelated baselines.

## Decision and roadmap effect

The 2026-07-14 scheduler PASS is preserved as historical evidence but superseded. The **Coordination kernel** roadmap item returns to unchecked. The TypeScript validation bridge, full key-free acceptance, and live comparison remain blocked.

The redb spike PASS is unaffected: its bounded durability, replay, fencing, and immutable-reader findings remain valid. The existing SQLite product path is also unaffected.

After this correction passes task-scoped and whole-branch review, a new decision may restore the scheduler PASS and recheck the roadmap item. No live model comparison or bridge implementation begins before that gate.

## Independent review

The final whole-branch reviewer identified the integrated authority, disjoint-claim, long-lock, and stale-readiness defects. A separate read-only GPT-5.6-sol architecture review recommended kernel-owned semantics with optimistic resource-version validation over global serialization or structural merge. Its pivotal premises were verified against the actual exported traits, claim-generation check, builder lock scope, wake paths, tests, and design requirements before this design was approved.
