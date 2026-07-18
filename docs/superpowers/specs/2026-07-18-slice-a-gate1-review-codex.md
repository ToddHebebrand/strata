# Independent Codex review: slice A gate-1 plan (verbatim findings)

Received 2026-07-18. Reviewer: Codex CLI `gpt-5.6-sol`, reasoning `xhigh`,
read-only sandbox, repo-grounded. Brief:
[`2026-07-18-slice-a-gate1-review-brief.md`](2026-07-18-slice-a-gate1-review-brief.md).
Verdict: **proceed with changes** (no falsifier, no second canonical store).

**Verification note (per repo rule, checked before acceptance):** the pivotal
claims were verified in-session — T03's registered tsc-only gate
(`packages/verify/src/taskBehavioralFixtures.ts`, `corpusRun.ts` vitestRun
empty-list short-circuit, `candidate.ts` empty-fixture rejection), the global
per-mutating-request ServiceFailpoint (`session.rs` handle_mutation), the
`redb-spike-api`-gated `execute_claimed_with_failpoint` and camelCase boundary
names (`publication.rs:118`, `kernel.rs:69-81`), the scheduler older-overlap
FIFO rule (`scheduler.rs:277`), `stop()` deleting the service directory
(`service.ts:57`), the absolute-vs-relative module-path domains (`t03.ts`
collectTsFiles vs `tasks.ts:495`), and the SQLite operations-row shape
(`rename.ts:61-80`). All held. Findings incorporated in plan v2 and the
design amendments; decision logged in decisions.md 2026-07-18.

The findings below are verbatim and unedited.

---

1. **Blocker — the harness deletes the redb database before exporting it.**

   - Claim: Task 7 stops the daemon and then runs `export-snapshot`; Tasks 8–9 reopen the same database ([plan:647](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:647), [plan:713](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:713)).
   - Code: `startKernelService` always creates a new temporary directory, and `stop()` recursively deletes it—including `kernel.redb` ([service.ts:33](/Users/toddhebebrand/Strata/packages/live-compare/src/service.ts:33), [service.ts:57](/Users/toddhebebrand/Strata/packages/live-compare/src/service.ts:57)).
   - Smallest fix: split shutdown from cleanup. Add a reusable service directory/database option, `stop({ preserveDirectory: true })`, and an explicit final cleanup. Add a recovery start path that reuses an existing redb database.

2. **Blocker — the parity snapshots are not currently the same wire shape or ingest identity domain.**

   - Claim: `export-snapshot` writes the same `KernelSnapshotV1` shape and Task 7 parses both arms as that type ([plan:520](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:520), [plan:604](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:604)).
   - Code: Rust `GraphSnapshot.generation` serializes as a JSON number ([model.rs:24](/Users/toddhebebrand/Strata/crates/strata-kernel/src/model.rs:24)); TypeScript’s `KernelSnapshotV1` and strict schema require a canonical decimal string ([kernelSnapshot.ts:21](/Users/toddhebebrand/Strata/packages/ingest/src/kernelSnapshot.ts:21), [protocol.ts:53](/Users/toddhebebrand/Strata/packages/kernel-bridge/src/protocol.ts:53)).
   - There is also an identity mismatch unless explicitly corrected. Kernel qualification ingests corpus-relative module paths ([tasks.ts:495](/Users/toddhebebrand/Strata/packages/live-compare/src/tasks.ts:495)); the existing SQLite T03 product flow ingests absolute paths ([t03.ts:86](/Users/toddhebebrand/Strata/packages/cli/src/commands/t03.ts:86)). Node IDs hash the module-path string ([ids.ts:9](/Users/toddhebebrand/Strata/packages/store/src/ids.ts:9)), so “same ingest, same IDs” is false as written.
   - Field names and ordering otherwise align: both preserve payloads, include Module nodes, and sort by ID/reference keys ([snapshot.ts:103](/Users/toddhebebrand/Strata/packages/kernel-bridge/src/snapshot.ts:103), [graph.rs:94](/Users/toddhebebrand/Strata/crates/strata-kernel/src/graph.rs:94)). No payload-blanking transformation is needed—but Module payloads must be identical.
   - Smallest fix: define one canonical generation conversion and one shared corpus-input builder used by both arms. Explicitly compare Module records. If the control uses relative paths, stop calling its ingest path byte-identical to the existing CLI product path.

3. **Blocker — the proposed behavioral profile does not match the shipped T03 gate.**

   - Claim: selecting every corpus test file matches the SQLite product’s T03 `commitWithBehavioralGate` semantics ([plan:611](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:611), [plan:646](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:646)).
   - Code: the authoritative task fixture map gives T03 `[]`, explicitly meaning tsc-only and avoiding the previously invalid whole-suite gate ([taskBehavioralFixtures.ts:1](/Users/toddhebebrand/Strata/packages/verify/src/taskBehavioralFixtures.ts:1)). `vitestRun(..., [])` returns success without invoking Vitest ([corpusRun.ts:199](/Users/toddhebebrand/Strata/packages/verify/src/corpusRun.ts:199)). Conversely, the bridge rejects behavioral mode with an empty fixture list ([candidate.ts:273](/Users/toddhebebrand/Strata/packages/kernel-bridge/src/candidate.ts:273)).
   - Both planned arms could run the same auto-discovered suite, but that proves parity for a new gate profile—not parity with the shipped T03 product.
   - Smallest fix: pre-register an explicit, immutable gate-1 fixture list and use it identically in both arms. Update the design’s “matches the SQLite product gate” wording. Do not dynamically run every future test under `examples/medium`.

4. **Major — `find_declarations` is neither index-backed nor equivalent in failure behavior.**

   - Claim: discovery is served from the in-memory declaration index; the repeated snapshot cloning is acceptable and deferred to Gate 2 ([design:94](/Users/toddhebebrand/Strata/docs/superpowers/specs/2026-07-18-iteration6-slice-a-convergence-design.md:94), [plan:184](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:184), [plan:229](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:229)).
   - Code: `GraphGeneration` has node and reference maps, not a declaration-name index ([graph.rs:7](/Users/toddhebebrand/Strata/crates/strata-kernel/src/graph.rs:7)). The proposed outer scan clones the full node set once, then `declaration_name_identifier` clones it again for every candidate ([provider.rs:691](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/provider.rs:691)): effectively `O(declarations × nodes)` allocation and scanning.
   - The JSDoc defense itself is sound: Rust finds the declaration token and exact UTF-16 offset ([provider.rs:719](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/provider.rs:719)), matching SQLite’s parsed-name intent ([queries.ts:44](/Users/toddhebebrand/Strata/packages/store/src/queries.ts:44)). The kind vocabulary, including `FirstStatement`, also matches ([queries.ts:27](/Users/toddhebebrand/Strata/packages/store/src/queries.ts:27)). But Rust returns an error for an unnameable/malformed candidate while SQLite skips it.
   - Smallest fix: take one graph snapshot and build a parent-to-Identifier map for an `O(nodes)` lookup. Match SQLite’s skip behavior for unnameable candidates. Add a real-corpus JSDoc regression, not the plan’s fallback toy fixture, and measure discovery latency separately in Gates 2–3.

5. **Major — “field-for-field audit equivalence” is not true, and the assertions are too weak.**

   - Claim: kernel audit is field-for-field equivalent to the SQLite operation row ([design:193](/Users/toddhebebrand/Strata/docs/superpowers/specs/2026-07-18-iteration6-slice-a-convergence-design.md:193)).
   - Code: SQLite stores snake-case parameters, semantic Identifier IDs, and `reasoning:null` on the operation; original task context lives on the transaction ([rename.ts:61](/Users/toddhebebrand/Strata/packages/store/src/rename.ts:61), [transactions.ts:59](/Users/toddhebebrand/Strata/packages/store/src/transactions.ts:59)). Kernel `affected_node_ids` is derived from the graph delta and also includes statement nodes and reference targets ([coordinator.rs:1008](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/coordinator.rs:1008)).
   - The plan only checks `length > 1` independently in each arm ([plan:633](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:633)); it does not prove equivalent semantics.
   - Smallest fix: specify a normalized audit projection: actor, transaction/change-set task context, operation class, declaration ID, old/new name, and semantic renamed-Identifier set. Compare that projection explicitly; separately document the kernel’s broader delta-affected set.

6. **Minor — `#[serde(default)]` is sufficient for old redb reads, but the digest guidance is underspecified.**

   - Persisted operations are standalone JSON bytes and are decoded through Serde, so `#[serde(default)]` will read old records without `intents` ([storage.rs:343](/Users/toddhebebrand/Strata/crates/strata-kernel/src/storage.rs:343), [storage.rs:823](/Users/toddhebebrand/Strata/crates/strata-kernel/src/storage.rs:823)).
   - Adding the field must not change graph-generation digests: those hash only `GraphSnapshot` ([graph.rs:139](/Users/toddhebebrand/Strata/crates/strata-kernel/src/graph.rs:139)). Newly written operation bytes and the test-only whole-table digest legitimately change; existing stored bytes should not be rewritten.
   - Smallest fix: add an old-redb-record recovery fixture and explicitly forbid updates to graph, source, task-registration, delta, or event digests. Run `cargo test --features redb-spike-api` in Task 1; many `OperationRecord` literals are outside the two feature combinations currently listed.

7. **Blocker — the crash failpoints will not reach the intended `advance_change_set` publication.**

   - Claim: starting the daemon with each ServiceFailpoint exercises five journal stages during the T03 advance ([plan:687](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:687)).
   - Code: one global failpoint trips after every mutating request’s pending/effect/prepared/follow-up/completed stages ([session.rs:202](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:202)). Enabled from process start, it aborts on `begin_change_set`, long before advance.
   - The coordinated `PublishFailpoint` path does exist, but only under `redb-spike-api`, through `execute_claimed_with_failpoint` ([publication.rs:118](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/publication.rs:118)); Task 7 builds only `coordination-test-api`. Actual boundary names are camelCase, not the snake-case names stated in the interface ([kernel.rs:69](/Users/toddhebebrand/Strata/crates/strata-kernel/src/kernel.rs:69)).
   - Smallest fix: prepare and submit the change set first, restart the same database with the journal failpoint enabled, then issue only `advance_change_set`. Build the crash binary with `redb-spike-api`, while separately running parity against a default-feature binary.

8. **Blocker — graph-only old/new export is too weak a crash oracle.**

   - Claim: snapshot equality plus a later successful retry proves atomic recovery and idempotent journal replay ([plan:698](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:698)).
   - Code: the existing row-8 oracle checks graph, digest, operations, deltas, graph events, ticket, idempotency record, change set, offer, claims, coordination events, publication attempt, fences, resource clocks, scheduler revision, and table counts ([full_key_free_acceptance.rs:309](/Users/toddhebebrand/Strata/crates/strata-kernel/tests/full_key_free_acceptance.rs:309), [full_key_free_acceptance.rs:389](/Users/toddhebebrand/Strata/crates/strata-kernel/tests/full_key_free_acceptance.rs:389)). `export-snapshot` sees only nodes and references.
   - Gate 1 could therefore pass with a correct graph but duplicated/missing history, events, tickets, or journal responses.
   - Smallest fix: retain the graph export assertion, but also compare the existing full atomic-state projection and retry the exact same request/idempotency key, asserting the exact cached response. A new full T03 run with new IDs is not an idempotency test.

9. **Blocker — the after-submit intrusion case contradicts FIFO, and the concurrent oracle permits fairness violations.**

   - Claim: at every stage, including after A submits, overlapping B completes before A advances; concurrent advances may legally end in either serial order ([plan:735](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:735)).
   - Code: once A has a ready offer, an overlapping B scope is skipped; older overlapping queued/ready tickets also block younger tickets ([scheduler.rs:277](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/scheduler.rs:277)). B cannot complete before submitted-and-ready A without violating the kernel’s fairness contract.
   - The daemon does have real request concurrency—one thread per connection ([server.rs:49](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:49), [server.rs:118](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:118))—so this is not merely sequential transport. But if submission order fixes queue order, accepting either final serial outcome masks a FIFO bug.
   - Smallest fix: make expectations stage-specific. Before submit, B may commit first. After A submits, B must queue, A must win, then B wakes with fresh state/`needs_decision`. In the concurrent case, derive the required winner from durable queue sequence rather than accepting either. Pre-register the disjoint declaration/name too; exact-name discovery cannot enumerate an unspecified “different declaration.”

### Three load-bearing claims to verify

1. With one shared module-path convention and generation normalization, both arms produce byte-identical nodes/references and rendered modules; the kernel candidate does use the same `rename_symbol` implementation as SQLite ([candidate.ts:90](/Users/toddhebebrand/Strata/packages/kernel-bridge/src/candidate.ts:90)).
2. Both arms run one explicitly registered, identical tsc/Vitest profile—without whole-suite autodiscovery or an empty-fixture no-op.
3. Every crash case demonstrably reaches `advance_change_set`, recovers the complete coordination state, and exact-request replay is idempotent; intrusion tests enforce FIFO under the daemon’s real connection concurrency.

**Overall verdict: proceed with changes.** I found no convergence falsifier or second canonical store, but the current plan can either fail mechanically or pass while proving weaker/different claims than Gate 1 requires.
hook: Stop
hook: Stop Completed
tokens used
284,659
1. **Blocker — the harness deletes the redb database before exporting it.**

   - Claim: Task 7 stops the daemon and then runs `export-snapshot`; Tasks 8–9 reopen the same database ([plan:647](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:647), [plan:713](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:713)).
   - Code: `startKernelService` always creates a new temporary directory, and `stop()` recursively deletes it—including `kernel.redb` ([service.ts:33](/Users/toddhebebrand/Strata/packages/live-compare/src/service.ts:33), [service.ts:57](/Users/toddhebebrand/Strata/packages/live-compare/src/service.ts:57)).
   - Smallest fix: split shutdown from cleanup. Add a reusable service directory/database option, `stop({ preserveDirectory: true })`, and an explicit final cleanup. Add a recovery start path that reuses an existing redb database.

2. **Blocker — the parity snapshots are not currently the same wire shape or ingest identity domain.**

   - Claim: `export-snapshot` writes the same `KernelSnapshotV1` shape and Task 7 parses both arms as that type ([plan:520](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:520), [plan:604](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:604)).
   - Code: Rust `GraphSnapshot.generation` serializes as a JSON number ([model.rs:24](/Users/toddhebebrand/Strata/crates/strata-kernel/src/model.rs:24)); TypeScript’s `KernelSnapshotV1` and strict schema require a canonical decimal string ([kernelSnapshot.ts:21](/Users/toddhebebrand/Strata/packages/ingest/src/kernelSnapshot.ts:21), [protocol.ts:53](/Users/toddhebebrand/Strata/packages/kernel-bridge/src/protocol.ts:53)).
   - There is also an identity mismatch unless explicitly corrected. Kernel qualification ingests corpus-relative module paths ([tasks.ts:495](/Users/toddhebebrand/Strata/packages/live-compare/src/tasks.ts:495)); the existing SQLite T03 product flow ingests absolute paths ([t03.ts:86](/Users/toddhebebrand/Strata/packages/cli/src/commands/t03.ts:86)). Node IDs hash the module-path string ([ids.ts:9](/Users/toddhebebrand/Strata/packages/store/src/ids.ts:9)), so “same ingest, same IDs” is false as written.
   - Field names and ordering otherwise align: both preserve payloads, include Module nodes, and sort by ID/reference keys ([snapshot.ts:103](/Users/toddhebebrand/Strata/packages/kernel-bridge/src/snapshot.ts:103), [graph.rs:94](/Users/toddhebebrand/Strata/crates/strata-kernel/src/graph.rs:94)). No payload-blanking transformation is needed—but Module payloads must be identical.
   - Smallest fix: define one canonical generation conversion and one shared corpus-input builder used by both arms. Explicitly compare Module records. If the control uses relative paths, stop calling its ingest path byte-identical to the existing CLI product path.

3. **Blocker — the proposed behavioral profile does not match the shipped T03 gate.**

   - Claim: selecting every corpus test file matches the SQLite product’s T03 `commitWithBehavioralGate` semantics ([plan:611](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:611), [plan:646](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:646)).
   - Code: the authoritative task fixture map gives T03 `[]`, explicitly meaning tsc-only and avoiding the previously invalid whole-suite gate ([taskBehavioralFixtures.ts:1](/Users/toddhebebrand/Strata/packages/verify/src/taskBehavioralFixtures.ts:1)). `vitestRun(..., [])` returns success without invoking Vitest ([corpusRun.ts:199](/Users/toddhebebrand/Strata/packages/verify/src/corpusRun.ts:199)). Conversely, the bridge rejects behavioral mode with an empty fixture list ([candidate.ts:273](/Users/toddhebebrand/Strata/packages/kernel-bridge/src/candidate.ts:273)).
   - Both planned arms could run the same auto-discovered suite, but that proves parity for a new gate profile—not parity with the shipped T03 product.
   - Smallest fix: pre-register an explicit, immutable gate-1 fixture list and use it identically in both arms. Update the design’s “matches the SQLite product gate” wording. Do not dynamically run every future test under `examples/medium`.

4. **Major — `find_declarations` is neither index-backed nor equivalent in failure behavior.**

   - Claim: discovery is served from the in-memory declaration index; the repeated snapshot cloning is acceptable and deferred to Gate 2 ([design:94](/Users/toddhebebrand/Strata/docs/superpowers/specs/2026-07-18-iteration6-slice-a-convergence-design.md:94), [plan:184](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:184), [plan:229](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:229)).
   - Code: `GraphGeneration` has node and reference maps, not a declaration-name index ([graph.rs:7](/Users/toddhebebrand/Strata/crates/strata-kernel/src/graph.rs:7)). The proposed outer scan clones the full node set once, then `declaration_name_identifier` clones it again for every candidate ([provider.rs:691](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/provider.rs:691)): effectively `O(declarations × nodes)` allocation and scanning.
   - The JSDoc defense itself is sound: Rust finds the declaration token and exact UTF-16 offset ([provider.rs:719](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/provider.rs:719)), matching SQLite’s parsed-name intent ([queries.ts:44](/Users/toddhebebrand/Strata/packages/store/src/queries.ts:44)). The kind vocabulary, including `FirstStatement`, also matches ([queries.ts:27](/Users/toddhebebrand/Strata/packages/store/src/queries.ts:27)). But Rust returns an error for an unnameable/malformed candidate while SQLite skips it.
   - Smallest fix: take one graph snapshot and build a parent-to-Identifier map for an `O(nodes)` lookup. Match SQLite’s skip behavior for unnameable candidates. Add a real-corpus JSDoc regression, not the plan’s fallback toy fixture, and measure discovery latency separately in Gates 2–3.

5. **Major — “field-for-field audit equivalence” is not true, and the assertions are too weak.**

   - Claim: kernel audit is field-for-field equivalent to the SQLite operation row ([design:193](/Users/toddhebebrand/Strata/docs/superpowers/specs/2026-07-18-iteration6-slice-a-convergence-design.md:193)).
   - Code: SQLite stores snake-case parameters, semantic Identifier IDs, and `reasoning:null` on the operation; original task context lives on the transaction ([rename.ts:61](/Users/toddhebebrand/Strata/packages/store/src/rename.ts:61), [transactions.ts:59](/Users/toddhebebrand/Strata/packages/store/src/transactions.ts:59)). Kernel `affected_node_ids` is derived from the graph delta and also includes statement nodes and reference targets ([coordinator.rs:1008](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/coordinator.rs:1008)).
   - The plan only checks `length > 1` independently in each arm ([plan:633](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:633)); it does not prove equivalent semantics.
   - Smallest fix: specify a normalized audit projection: actor, transaction/change-set task context, operation class, declaration ID, old/new name, and semantic renamed-Identifier set. Compare that projection explicitly; separately document the kernel’s broader delta-affected set.

6. **Minor — `#[serde(default)]` is sufficient for old redb reads, but the digest guidance is underspecified.**

   - Persisted operations are standalone JSON bytes and are decoded through Serde, so `#[serde(default)]` will read old records without `intents` ([storage.rs:343](/Users/toddhebebrand/Strata/crates/strata-kernel/src/storage.rs:343), [storage.rs:823](/Users/toddhebebrand/Strata/crates/strata-kernel/src/storage.rs:823)).
   - Adding the field must not change graph-generation digests: those hash only `GraphSnapshot` ([graph.rs:139](/Users/toddhebebrand/Strata/crates/strata-kernel/src/graph.rs:139)). Newly written operation bytes and the test-only whole-table digest legitimately change; existing stored bytes should not be rewritten.
   - Smallest fix: add an old-redb-record recovery fixture and explicitly forbid updates to graph, source, task-registration, delta, or event digests. Run `cargo test --features redb-spike-api` in Task 1; many `OperationRecord` literals are outside the two feature combinations currently listed.

7. **Blocker — the crash failpoints will not reach the intended `advance_change_set` publication.**

   - Claim: starting the daemon with each ServiceFailpoint exercises five journal stages during the T03 advance ([plan:687](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:687)).
   - Code: one global failpoint trips after every mutating request’s pending/effect/prepared/follow-up/completed stages ([session.rs:202](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:202)). Enabled from process start, it aborts on `begin_change_set`, long before advance.
   - The coordinated `PublishFailpoint` path does exist, but only under `redb-spike-api`, through `execute_claimed_with_failpoint` ([publication.rs:118](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/publication.rs:118)); Task 7 builds only `coordination-test-api`. Actual boundary names are camelCase, not the snake-case names stated in the interface ([kernel.rs:69](/Users/toddhebebrand/Strata/crates/strata-kernel/src/kernel.rs:69)).
   - Smallest fix: prepare and submit the change set first, restart the same database with the journal failpoint enabled, then issue only `advance_change_set`. Build the crash binary with `redb-spike-api`, while separately running parity against a default-feature binary.

8. **Blocker — graph-only old/new export is too weak a crash oracle.**

   - Claim: snapshot equality plus a later successful retry proves atomic recovery and idempotent journal replay ([plan:698](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:698)).
   - Code: the existing row-8 oracle checks graph, digest, operations, deltas, graph events, ticket, idempotency record, change set, offer, claims, coordination events, publication attempt, fences, resource clocks, scheduler revision, and table counts ([full_key_free_acceptance.rs:309](/Users/toddhebebrand/Strata/crates/strata-kernel/tests/full_key_free_acceptance.rs:309), [full_key_free_acceptance.rs:389](/Users/toddhebebrand/Strata/crates/strata-kernel/tests/full_key_free_acceptance.rs:389)). `export-snapshot` sees only nodes and references.
   - Gate 1 could therefore pass with a correct graph but duplicated/missing history, events, tickets, or journal responses.
   - Smallest fix: retain the graph export assertion, but also compare the existing full atomic-state projection and retry the exact same request/idempotency key, asserting the exact cached response. A new full T03 run with new IDs is not an idempotency test.

9. **Blocker — the after-submit intrusion case contradicts FIFO, and the concurrent oracle permits fairness violations.**

   - Claim: at every stage, including after A submits, overlapping B completes before A advances; concurrent advances may legally end in either serial order ([plan:735](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md:735)).
   - Code: once A has a ready offer, an overlapping B scope is skipped; older overlapping queued/ready tickets also block younger tickets ([scheduler.rs:277](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/scheduler.rs:277)). B cannot complete before submitted-and-ready A without violating the kernel’s fairness contract.
   - The daemon does have real request concurrency—one thread per connection ([server.rs:49](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:49), [server.rs:118](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:118))—so this is not merely sequential transport. But if submission order fixes queue order, accepting either final serial outcome masks a FIFO bug.
   - Smallest fix: make expectations stage-specific. Before submit, B may commit first. After A submits, B must queue, A must win, then B wakes with fresh state/`needs_decision`. In the concurrent case, derive the required winner from durable queue sequence rather than accepting either. Pre-register the disjoint declaration/name too; exact-name discovery cannot enumerate an unspecified “different declaration.”

### Three load-bearing claims to verify

1. With one shared module-path convention and generation normalization, both arms produce byte-identical nodes/references and rendered modules; the kernel candidate does use the same `rename_symbol` implementation as SQLite ([candidate.ts:90](/Users/toddhebebrand/Strata/packages/kernel-bridge/src/candidate.ts:90)).
2. Both arms run one explicitly registered, identical tsc/Vitest profile—without whole-suite autodiscovery or an empty-fixture no-op.
3. Every crash case demonstrably reaches `advance_change_set`, recovers the complete coordination state, and exact-request replay is idempotent; intrusion tests enforce FIFO under the daemon’s real connection concurrency.

**Overall verdict: proceed with changes.** I found no convergence falsifier or second canonical store, but the current plan can either fail mechanically or pass while proving weaker/different claims than Gate 1 requires.
