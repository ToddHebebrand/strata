# Codex independent review — slice A gate 2 plan (gpt-5.6-sol, xhigh, read-only, 2026-07-19)

Brief: docs/superpowers/specs/2026-07-19-slice-a-gate2-review-brief.md
Plan under review: docs/superpowers/plans/2026-07-19-iteration6-slice-a-gate2.md (v1)
Disposition: all 9 findings verified against source by the requesting session and accepted; plan revised to v2.

1. **Blocker — the bridge metrics field is not observer-only at the response-size boundary.**

   **Claim:** Task 1 attaches metrics to every worker response, including when `--metrics` is absent. The worker currently applies its 16 MiB limit to the final serialized response and substitutes `responseTooLarge` when exceeded; Rust independently enforces the same limit. Adding metrics can therefore turn a previously valid candidate into a validation failure, violating the hard observer-only constraint. Task 1 also lands the producer before Task 2 teaches Rust’s `deny_unknown_fields` response structs about the field, leaving an intermediate commit incompatible with the normal bridge test sequence.

   **Evidence:** [gate2 plan:205-209](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-19-iteration6-slice-a-gate2.md:205), [worker.ts:149-170](/Users/toddhebebrand/Strata/packages/kernel-bridge/src/worker.ts:149), [process.rs:46-48](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/process.rs:46), [process.rs:249-275](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/process.rs:249), [protocol.rs:931-973](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/protocol.rs:931), [protocol.rs:1108-1118](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/protocol.rs:1108), [package.json:15-17](/Users/toddhebebrand/Strata/package.json:15).

   **Amendment:** Make collection explicitly opt-in from `--metrics` through `NodeBridgeConfig`; when off, create no recorder, call no `resourceUsage`, emit no metrics field, and push no buffer entry. Enforce the existing semantic-response bound before attaching metrics, then give metrics a separate fixed transport headroom; if that headroom is exhausted, omit metrics rather than change the semantic response. Land the Rust optional-field consumer before, or atomically with, the TS producer.

2. **Major — `requestBytes` does not measure serialized snapshot bytes, and `bridgeWallNs` omits snapshot construction.**

   **Claim:** The proposed `requestBytes` is the size of the entire bridge request, including bindings, intent/change-set data, and validation profile—not the serialized snapshot required by Gate 2. Snapshot cloning/conversion also happens before `NodeBridgeClient::run`, so the proposed bridge timer excludes that potentially dominant cost.

   **Evidence:** Analyze requests combine the snapshot and intent at [provider.rs:42-64](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/provider.rs:42); candidate requests combine the snapshot, validation profile, and complete change set at [executor.rs:32-79](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/executor.rs:32). Both construct requests before calling the bridge at [provider.rs:34-38](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/provider.rs:34) and [executor.rs:98-109](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/executor.rs:98). Serialization then encodes the whole request at [protocol.rs:1103-1106](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/protocol.rs:1103).

   **Amendment:** Record separate `snapshotBytes`, `totalRequestBytes`, `snapshotBuildNs`, and `requestSerializeNs`. Keep `bridgeWallNs` for subprocess/pipe/parse time.

3. **Major — the analysis timing is incomplete and cannot identify the semantic phase that caused a worker run.**

   **Claim:** A successful T03 lifecycle analyzes at submit, claim, before candidate construction, and again after candidate construction. The plan times only the first publication analysis, while every worker record is merely `analyzeIntent + changeSetId`. Repeated analysis at the same generation even receives the same derived bridge request ID, so the resulting profile cannot distinguish coordination stages from repeated bridge mechanics.

   **Evidence:** The analysis sites are submit at [coordinator.rs:224-227](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/coordinator.rs:224), claim at [coordinator.rs:352-358](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/coordinator.rs:352), pre-candidate at [publication.rs:363-369](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/publication.rs:363), and post-candidate at [publication.rs:436-454](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/publication.rs:436). Analyze request IDs contain only epoch, generation, and intent ID at [provider.rs:47-55](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/provider.rs:47). The planned record contains no phase or request correlation field at [gate2 plan:32-37](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-19-iteration6-slice-a-gate2.md:32).

   **Amendment:** Add an internal phase/correlation dimension—at minimum `submitAnalysis`, `claimAnalysis`, `preCandidateAnalysis`, `postCandidateAnalysis`, and `candidate`. Time and aggregate every invocation plus scheduler/planner time. This remains daemon-internal and need not change the socket protocol.

4. **Major — the global drain and `last_publication` slot misattribute concurrent requests.**

   **Claim:** The daemon runs connections concurrently and serializes only per change set. Different change sets can therefore share the single bridge client simultaneously. A global worker buffer may be drained by an unrelated request, and the proposed single `last_publication: Mutex<Option<_>>` can be overwritten or consumed by the wrong publishing request.

   **Evidence:** Each connection receives its own thread at [server.rs:49-55](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/server.rs:49); mutation serialization is keyed by change set at [session.rs:270-275](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:270). One `NodeBridgeClient` is shared by provider and executor at [kernel.rs:142-156](/Users/toddhebebrand/Strata/crates/strata-kernel/src/kernel.rs:142). The global publication slot is proposed at [gate2 plan:364](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-19-iteration6-slice-a-gate2.md:364).

   **Amendment:** Carry `PublicationReport` directly on `ExecutedEffect` to the request emitter. Give worker observations an internal request/attempt correlation ID and emit them independently; do not describe a global drain count as causally belonging to the request that happened to drain it.

5. **Major — `candidateNs = 0` after an optimistic retry is a measurement lie.**

   **Claim:** On optimistic retry, candidate construction has already happened, but recursion re-enters with `CandidateSource::Validated`. The proposed final report records zero candidate time and only the retry’s analysis time, discarding work incurred by the same advance request. It also invalidates the proposed `candidateNs >= candidate.bridgeWallNs` invariant.

   **Evidence:** Candidate construction occurs at [publication.rs:375-399](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/publication.rs:375); retry recursion reuses the validated candidate at [publication.rs:695-721](/Users/toddhebebrand/Strata/crates/strata-kernel/src/coordination/publication.rs:695). The plan explicitly assigns zero at [gate2 plan:304-315](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-19-iteration6-slice-a-gate2.md:304).

   **Amendment:** Thread a timing accumulator through retries or emit per-attempt reports. The request-level totals must include all analysis and candidate work; per-attempt values can additionally show candidate reuse.

6. **Major — the promoted counter is not a Node-worker-start counter, and error starts disappear from the artifact.**

   **Claim:** The current counter increments before request serialization, size validation, and `Command::spawn`, so it can count a run where no Node process started. Conversely, the planned buffer records only the successful parse exit, while the acceptance oracle defines worker starts as `workerRuns.length`; timeouts, nonzero exits, oversized responses, and parse failures vanish despite the plan claiming error runs are counted.

   **Evidence:** Counter increment precedes serialization and spawn at [process.rs:103-124](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/process.rs:103). The planned single-success recording and omitted error paths are explicit at [gate2 plan:261-275](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-19-iteration6-slice-a-gate2.md:261), while the oracle equates starts with successful records at [gate2 plan:455-458](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-19-iteration6-slice-a-gate2.md:455).

   **Amendment:** Increment `workerStartsTotal` only after successful `spawn`. Emit one terminal record for every spawned child, with outcome/error class and optional worker stages. Keep pre-spawn bridge attempts as a separately named counter if useful.

7. **Major — `publicationBytes` materially undercounts the coordinated redb publication.**

   **Claim:** Summing operation, delta, ticket, and event values does not represent publication bytes. The same transaction also mutates fences, resource clocks, lifecycle state, publication attempts, idempotency, generation digests, and metadata. The acceptance suite then presents the partial number as a publication byte cost.

   **Evidence:** Coordinated publication writes fences and clocks before the graph records and writes lifecycle plus attempt state afterward at [storage.rs:276-340](/Users/toddhebebrand/Strata/crates/strata-kernel/src/storage.rs:276). Even the graph helper writes idempotency, digest, and metadata beyond the four encoded records at [storage.rs:343-389](/Users/toddhebebrand/Strata/crates/strata-kernel/src/storage.rs:343).

   **Amendment:** Either rename the field to `coreGraphRecordValueBytes` and exclude it from publication-cost claims, or count categorized logical key/value bytes for every mutation in the transaction. Do not describe it as physical redb bytes without storage-engine evidence.

8. **Major — the promised committed profile artifact is ignored by Git.**

   **Claim:** The plan says the Gate 2 artifact is committed, but `packages/live-compare/results/*` is ignored except for `.gitkeep`; `git add -A` will not include the timestamped profile. Task 7 would consequently cite evidence absent from the reviewed commit.

   **Evidence:** [.gitignore:23-24](/Users/toddhebebrand/Strata/.gitignore:23), [gate2 plan:383](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-19-iteration6-slice-a-gate2.md:383), [gate2 plan:507-509](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-19-iteration6-slice-a-gate2.md:507).

   **Amendment:** Produce deterministic `gate2-profile.json` and `.md` evidence and explicitly unignore those files, or commit them under `docs/spikes/`. Keep timestamped local rerun artifacts ignored.

9. **Minor — `seedNs` and recovery snapshot-byte plumbing are underspecified.**

   **Claim:** `Gate2Profile` requires `seedNs`, but the proposed `RecoveryReport` has no seed duration. The current create path performs an undifferentiated `store.seed`, while recovery’s encoded snapshot bytes are consumed and decoded inside `DurableStore::latest_snapshot`, not “in hand” in `kernel.rs` as the plan assumes.

   **Evidence:** The create path is [kernel.rs:174-193](/Users/toddhebebrand/Strata/crates/strata-kernel/src/kernel.rs:174); latest-snapshot bytes are read and decoded at [storage.rs:648-668](/Users/toddhebebrand/Strata/crates/strata-kernel/src/storage.rs:648). The mismatched planned interfaces are [gate2 plan:303-306](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-19-iteration6-slice-a-gate2.md:303) and [gate2 plan:387-403](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-19-iteration6-slice-a-gate2.md:387).

   **Amendment:** Add an explicitly measured `seed_ns` or separate `SeedReport`, and have storage return the encoded snapshot length alongside the decoded snapshot.

The restart choreography itself is sound: reusing the directory skips seed when `kernel.redb` exists at [service.ts:27-32](/Users/toddhebebrand/Strata/packages/live-compare/src/service.ts:27), and recovery loads the latest snapshot then replays every later delta at [kernel.rs:250-286](/Users/toddhebebrand/Strata/crates/strata-kernel/src/kernel.rs:250). A one-publication flow should therefore report one replayed operation.

**Verdict: plan needs amendment.** The minimal amendment set is findings 1–8; finding 9 should be resolved while revising the report interfaces.
