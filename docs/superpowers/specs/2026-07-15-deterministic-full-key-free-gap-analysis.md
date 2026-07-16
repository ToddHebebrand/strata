# Deterministic Full Key-Free Gate Gap Analysis

**Date:** 2026-07-15

**Baseline:** `4455251302bb4a3dfe75b1e2ed81173bc9285ef7`

**Governing design:** `docs/superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md`

**Bounded bridge decision:** the 2026-07-15 `decisions.md` entry approving candidate validation on the exact ingest-derived `src/**` source projection

## Scope of this analysis

The completed Rust–Node bridge proves two real structural operations, sealed execution authority, optimistic publication, redb durability, and recovery. It does not yet approve the full Phase-6 deterministic gate. This analysis maps every acceptance row from the governing design to current evidence and the remaining work.

The candidate-validation corpus remains the exact source projection established by the newest decision: 1,203 nodes and 592 references from the 1,282-node, 614-reference `examples/medium` ingest snapshot. The untouched full snapshot remains required for semantic and scope evidence. The gate may not silently omit further source dependencies or weaken candidate validation.

## Acceptance matrix

| # | Governing criterion | Current evidence | Remaining work for full approval |
|---|---|---|---|
| 1 | Two disjoint renames remain independently runnable and both commit. | Real Node-backed `examples/medium` test builds both at G0 and publishes in both orders; lower-level optimistic-publication coverage also exists. | Move this evidence into the named full-gate target and assert final TypeScript validation, both operations, both generations, and no lost update. |
| 2 | Same-symbol renames are ordered; the second receives fresh state and `IntentNeedsDecision`. | Scheduler/lifecycle test proves FIFO wakeup and decision semantics through the feature-gated graph-derived provider. | Add two independent clients using the production Node semantic provider on the real `User` declaration; publish the first rename, then prove the second wakes against fresh state and cannot auto-replay. |
| 3 | Rename and an operation touching one of its references are inferred as overlapping. | Feature-gated analyzer coverage proves inferred reference overlap before mutation. | Add the real supported-operation pair `rename_symbol(User)` and `add_parameter(greet)`, whose function signature references `User`, and prove Rust derives the overlap from Node facts before either client can mutate or publish dirty state. |
| 4 | `add_parameter` discovers a callsite added while it waited and requeues before mutation. | Real Node-backed G+1 test proves scope expansion, requeue, rebuild, and one publication covering the new callsite. | Include the test in the full-gate target and assert the multi-client event/operation history and final green projection. |
| 5 | An older wide rename cannot be starved by newer small edits. | Deterministic scheduler test proves aging and disjoint-only bypass using real-graph fixture IDs. | Bind the scopes to production Node analysis and independent logical clients, then prove only disjoint work passes while newer overlapping work cannot overtake the aged wide ticket indefinitely. No wall-clock sleeps. |
| 6 | Stale fencing tokens and old service epochs cannot publish. | Strong primitive and publication tests reject stale claims and pre-restart epochs without side effects. | Hold a real Node-backed claim across kernel reopen and invoke the normal sealed executor with it. Assert rejection occurs before publication and graph/history remain unchanged. |
| 7 | Queued tickets and unacknowledged events survive restart. | Recovery tests cover durable tickets, events, cursors, and lifecycle repair. | Reopen a database containing real Node-analyzed queued work and an unacknowledged client event; prove the independent client resumes through the public kernel API and the event cursor remains stable. |
| 8 | Failure injection at every redb boundary yields complete old or complete new state, never partial state. | Raw redb child-process tests cover every authorized boundary; coordinated in-process failure tests cover graph, operation, event, ticket, and fence rollback. | Consolidate the exhaustive boundary matrix into the full gate and add one real claimed Node candidate through the crash/reopen path to join bridge execution to the already-exhaustive redb atomicity proof. Do not duplicate an alternate publication path. |
| 9 | Snapshot-plus-operation replay is byte-equivalent for node/reference/index state and generation digest. | Replay and digest tests cover persisted graph state; real bridge recovery covers a published rename. | Publish multiple real bridge generations, cross a snapshot boundary, publish a later operation, reopen/replay, and compare canonical node/reference/index bytes plus generation digest. |
| 10 | Two changes that type-check only together commit as one change set. | Composite execution proves ordered intents, one scratch transaction, one generation, and one aggregate operation, but its rename and boolean parameter are independently valid. | Add a negative control where `add_parameter(greet)` uses type `Account` and fails on G0, then group it after `rename_symbol(User, Account)` with a universally assignable default expression. The aggregate must validate and publish once. Stop if the supported operations cannot express this without weakening validation. |
| 11 | Duplicate event delivery is harmless through event IDs and acknowledged cursors. | Durable event ID, replay, acknowledgement, and cursor tests are already strong and operation-independent. | Include the existing evidence in the named gate and add a thin independent-client assertion over events emitted by a real bridge publication. |
| 12 | No client or Node worker can mutate canonical storage outside the kernel. | Normal-build trybuild/runtime sealing proves candidate-envelope, provider, builder, hook, and direct storage authority are unavailable; the one-shot worker receives no redb path. | Keep the normal-build sealing suite in the full-gate command and add an explicit protocol assertion that real worker requests contain no canonical-storage location or authority fields. |

## Aggregate proof still missing

The repository does not have one named, deterministic command that joins the twelve rows into an auditable gate. The existing suites prove most mechanisms, but the complete evidence is split across real Node bridge tests, feature-gated scheduler tests, redb crash tests, replay tests, and normal-build sealing tests.

The full gate must add:

1. A deterministic multi-client harness whose clients use only public `Kernel` coordination calls and the sealed Rust-owned executor.
2. Real Node-backed integration for rows 2, 3, 5, 6, 7, 9, and 10, plus thin bridge joins for rows 8 and 11.
3. A named key-free command that builds the bounded worker, runs the real multi-client acceptance target, runs exhaustive redb/recovery tests, and reruns the normal-build authority-sealing tests.
4. A checked evidence table tying every row to an exact test and final invariant.

## Stop conditions

Stop and append a dated `decisions.md` entry before changing direction if any of these occur:

- Row 10 cannot be expressed with `rename_symbol` plus uniform-value `add_parameter` without adding an operation class, per-callsite values, or weakened TypeScript validation.
- A client must enumerate resource keys, reservations, clocks, fences, or containment facts.
- Node must receive a redb path, canonical store handle, candidate-digest authority, or publication authority.
- Stable logical IDs would require structural insert/delete/move concurrency.
- Complete old-or-new recovery cannot be retained at every existing authorized redb boundary.
- The source projection would need to omit more dependencies or become less strict than the approved bridge boundary.
- The normal build would need to expose feature-gated test injection or externally minted candidate envelopes.

## Scope exclusions

This gate does not add task decomposition, task assignment, live-model calls, a client network service, multi-host consensus, multi-language support, FUSE, git integration, human-compatibility layers, production distributed deployment, or concurrent structural insert/delete/move. It does not replace or remove the SQLite product path.

## Conclusion

The remaining work is an integration-and-acceptance closure over the existing kernel, not a new coordination architecture. Row 10 is the only wholly absent semantic criterion. Rows 2, 3, 5, 6, 7, 8, 9, and 11 need real bridge or multi-client joins so the final claim is not assembled solely from synthetic providers. Rows 1, 4, and 12 are strong regression evidence that must be retained in the named gate.
