# Codex independent review — slice A gate 3 plan (gpt-5.6-sol, xhigh, read-only, 2026-07-20)

Brief: docs/superpowers/specs/2026-07-20-slice-a-gate3-review-brief.md
Plan under review: docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md (v1)
Disposition: all 9 findings (5 blockers, 3 majors, 1 minor) verified against source by the requesting session — incl. Blocker 2 (product lifecycle validate+commit via replay.test.ts:40), Minor 9 (candidate validates once, candidate.ts:121), Blocker 4 (buildCorpusInputs scans corpusRoot/src, tasks.ts) — and accepted; plan revised to v2. Pressure checks that held are preserved as v2 rationale.

## Findings

1. **Blocker — Kernel-only observability contaminates the primary wall-time verdict.**  
   The plan times kernel mutations with `--metrics` enabled so it can obtain `serverWallNs` ([plan:68](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:68), [plan:72](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:72)). Metrics mode performs an extra full-snapshot serialization during every analysis and candidate build ([provider.rs:40](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/provider.rs:40), [executor.rs:108](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/executor.rs:108)). It also emits and flushes JSONL before the mutation returns ([session.rs:258](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:258), [metrics.rs:132](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/metrics.rs:132)). SQLite receives no comparable observer workload. This can unfairly push the kernel above 1.25×, particularly when the snapshot is replicated 40×.

   **Amendment:** Run the dispositive caller-wall schedule with metrics completely off for both arms. Run a separate, identically scheduled metrics-on characterization for server stages and RSS. Never subtract the observer cost from measured values or substitute server wall for caller wall.

2. **Blocker — The timed windows are not symmetric, and the proposed “4 vs 4” assertion is false for the specified execution.**  
   The SQLite measurement executes and times only `commit()` after `begin` and `rename_symbol`, while the kernel primary includes both `submit` and `advance` ([plan:67](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:67), [plan:68](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:68)). Yet Task 6 claims SQLite also executes `validate` ([plan:153](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:153)). The real product transcript explicitly calls `validate` before `commit_transaction` ([replay.test.ts:40](/Users/toddhebebrand/Strata/packages/agent/tests/replay.test.ts:40)), and `commit()` validates again internally ([validate.ts:237](/Users/toddhebebrand/Strata/packages/verify/src/validate.ts:237)). The existing gate-1 SQLite flow confirms that calling `commit()` alone is only three mutation calls, not four ([gate1.ts:222](/Users/toddhebebrand/Strata/packages/live-compare/src/gate1.ts:222)).

   This boundary can unfairly penalize the kernel by charging both post-draft calls while excluding SQLite’s explicit post-draft validation.

   **Amendment:** Make the primary current-product wall begin after draft construction and cover `submit + advance` for kernel versus `validate + commit` for SQLite. Report commit-only, validate-only, submit-only, and advance-only walls secondarily. Derive lifecycle parity from a runtime call trace or injected spies—not an adjacent list that can disagree with execution.

3. **Blocker — The sample sizes cannot support a p95 noninferiority verdict.**  
   The plan uses direct point ratios with no uncertainty rule ([plan:35](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:35)) and proposes medium N=25/8 and big N=12/4 ([plan:172](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:172), [plan:173](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:173)). Under the chosen nearest-rank implementation ([redb_spike.rs:258](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/redb_spike.rs:258)):

   - N=8, 12, or 4 makes p95 the sample maximum.
   - N=25 makes p95 the second-largest sample.
   - p99 is the maximum for every proposed N.

   Separate per-arm distributions also leave arm order unspecified ([plan:90](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:90)), allowing cache state, background load, or thermal drift to bias the ratio. A single noisy maximum can cause either a false pass or a false falsifier.

   **Amendment:** Pre-register paired, seeded AB/BA arm ordering; preserve pair ID, order, and iteration. Select N through a precision/power calculation, not runtime convenience. Pass only when a one-sided 95% upper confidence bound for the p95 ratio is ≤1.25. If the confidence interval crosses 1.25, record **INCONCLUSIVE**, not PASS or falsifier-5 FAIL.

4. **Blocker — The proposed big-corpus layout is outside both the ingest and kernel validation roots.**  
   Task 1 places modules under `outDir/copyNN/src/**` ([plan:46](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:46)), but `buildCorpusInputs()` scans only `<corpusRoot>/src/**` ([tasks.ts:535](/Users/toddhebebrand/Strata/packages/live-compare/src/tasks.ts:535)). The daemon likewise fixes `source-root` to `<corpusRoot>/src` ([service.ts:54](/Users/toddhebebrand/Strata/packages/live-compare/src/service.ts:54)), and the worker rejects any module outside that root ([candidate.ts:279](/Users/toddhebebrand/Strata/packages/kernel-bridge/src/candidate.ts:279)). As written, the test expecting `buildCorpusInputs(corpusRoot)` to return the copies cannot pass.

   There is also a scale mismatch: the current tracked `examples/medium/src` set contains 22 TypeScript modules, so ×40 produces 880, not the asserted 1,000. The source domain is exactly the `src/**/*.ts` set ([tsconfig.json:18](/Users/toddhebebrand/Strata/examples/medium/tsconfig.json:18)).

   **Amendment:** Generate `outDir/src/copyNN/**` and use `include: ["src/**/*.ts"]`. Preserve the operator-approved ×40 but correct every count and label to 880, or obtain approval to use ×46 for 1,012 modules. Run a full-scale typecheck and actual serialized bridge-request bound check before starting repeated measurements—not merely a four-copy typecheck.

5. **Blocker — The 8× total-RSS ratio can hide corpus-explosive memory and the measurement omits warm accumulation.**  
   Memory is measured in a separate one-mutation run ([plan:111](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:111), [plan:113](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:113)), then judged by `big/medium ≤ 8` on total peak RSS ([plan:133](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:133)). Gate 2 already measured medium worker RSS at 249,397,248 bytes ([gate2 profile:8](/Users/toddhebebrand/Strata/docs/spikes/gate2-observability-profile.md:8)); the predicate would therefore permit nearly 2 GB for the big worker alone. A large fixed Node runtime baseline also lets linearly growing corpus allocations appear nearly flat in a total-RSS ratio.

   The separate one-mutation run cannot see persistent-history growth. SQLite appends operation rows on every commit ([transactions.ts:253](/Users/toddhebebrand/Strata/packages/store/src/transactions.ts:253)); the daemon appends pending, effect, and completed journal records on every request ([session.rs:420](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:420), [session.rs:451](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:451)).

   **Amendment:** Measure RSS during the exact cold and full warm schedules, retaining per-iteration high-water marks. Define the product headline as combined daemon-plus-active-worker RSS, with daemon and worker components separately reported. Replace the 8× total ratio with a preregistered absolute 1k capacity cap plus baseline-adjusted component growth using a tiny/empty control. Apply the falsifier predicate to kernel memory; an exploding SQLite control should invalidate the comparison, not count as a kernel failure.

6. **Major — “Cold” is process-cold for kernel but only database-cold for SQLite, while warm-state drift is not analyzed.**  
   The global definition promises a fresh process/seed ([plan:23](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:23)), but Task 3 specifies only a fresh in-memory SQLite DB ([plan:90](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:90)). The existing SQLite flow opens a new DB inside the already-running Node process ([gate1.ts:203](/Users/toddhebebrand/Strata/packages/live-compare/src/gate1.ts:203)), whereas kernel startup spawns a new daemon ([service.ts:54](/Users/toddhebebrand/Strata/packages/live-compare/src/service.ts:54)). SQLite can therefore retain V8/module/JIT warming across nominal cold samples.

   Alternating rename itself is reasonable, and TypeScript does create a fresh `Program` on every validation rather than keeping an incremental program cache ([validate.ts:92](/Users/toddhebebrand/Strata/packages/verify/src/validate.ts:92), [validate.ts:142](/Users/toddhebebrand/Strata/packages/verify/src/validate.ts:142)). But graph size is the only fixed state; histories and journals grow, making early and late warm samples nonexchangeable.

   **Amendment:** Execute every cold sample in a fresh isolated child for both arms. Run warm arms in two persistent isolated processes, interleaved according to the balanced schedule. Retain generation/iteration and report first-half versus last-half p95 plus latency/RSS trend; pre-register a warm horizon instead of calling N “unbounded.”

7. **Major — `serverWallNs` cannot be safely attributed as planned and then disappears from the profile.**  
   Kernel worker records carry `changeSetId`, but request records carry only action, wall, publication, and sequence ([gate2.ts:84](/Users/toddhebebrand/Strata/packages/live-compare/src/gate2.ts:84), [gate2.ts:116](/Users/toddhebebrand/Strata/packages/live-compare/src/gate2.ts:116)). Reading an accumulating warm-run JSONL and summing action names can accidentally include earlier mutations. Moreover, the plan promises distributions for every timed quantity ([plan:19](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:19)), but the profile contains only caller-wall distributions ([plan:34](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:34)).

   **Amendment:** Add request/change-set identity to request metrics, or bracket each mutation by file offset/sequence and require exactly one new submit plus one publishing advance. Retain raw and aggregated server-wall distributions. Describe caller-minus-server as total client/framing/scheduling/observer overhead—not merely socket-connect cost.

8. **Major — The decisive operator run is not machine-enforced or provenance-bound.**  
   The big script merely prints verdicts ([plan:173](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:173)); the operator later reads and interprets them manually ([plan:190](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:190)). The run is intentionally absent from the automated chain ([plan:177](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:177)), while the proposed artifact schema has no source commit, binary/harness digest, host, runtime versions, or schedule seed ([plan:31](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:31)).

   **Amendment:** Keep the heavy run operator-invoked, but make it tri-state and machine-enforced: exit 0 for PASS, 2 for valid measured FAIL, and 1 for infrastructure/inconclusive. Always write the artifact first. Record HEAD, dirty-state/harness digest, binary hashes, corpus digest/count, OS/CPU, Node/Rust versions, schedule seed/order, N, and metrics mode. Add a cheap CI test that validates the committed artifact and its exact decision-source commit.

9. **Minor — The runtime estimate incorrectly says the kernel runs tsc twice per mutation.**  
   The plan uses that assertion to justify moving the large run out of CI ([plan:26](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:26)). The candidate worker calls `commit()` once ([candidate.ts:121](/Users/toddhebebrand/Strata/packages/kernel-bridge/src/candidate.ts:121)), and that commit performs one `validate()` ([validate.ts:237](/Users/toddhebebrand/Strata/packages/verify/src/validate.ts:237)). Under the corrected four-call SQLite product lifecycle, SQLite—not kernel—performs an explicit validation followed by commit’s second validation.

   **Amendment:** Correct the runtime model and run a non-dispositive pilot solely to size N/timeouts before freezing the statistical schedule.

## Pressure checks that held

- Caller-side wall should remain the primary current-product metric. Charging Unix-socket connection cost is honest because the client is deliberately one-request-per-connection today ([client.ts:95](/Users/toddhebebrand/Strata/packages/live-compare/src/client.ts:95), [client.ts:170](/Users/toddhebebrand/Strata/packages/live-compare/src/client.ts:170)). Server wall is diagnostic only.
- Identical copies do not benefit from a retained TypeScript incremental `Program`; validation constructs a new program each time. Balanced ordering is still needed for process/JIT and system-cache effects.
- The bridge-frame estimate is safe after correcting the corpus layout. A read-only ingest produced a 9,549,461-byte ×40 snapshot, consistent with gate 2’s 238,642-byte medium snapshot ([gate2 profile:10](/Users/toddhebebrand/Strata/docs/spikes/gate2-observability-profile.md:10)) and below the 32 MiB request bound ([process.rs:51](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/process.rs:51)).
- Medium-in-CI plus operator-run big corpus is acceptable if Finding 8 is implemented.
- The plan’s response to an actual red result is appropriately strict ([plan:15](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:15), [plan:191](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:191)). The problem is that the present predicates could manufacture the wrong red—or green—before that discipline applies.

## Verdict

**Plan needs amendment.**

Minimal amendment set:

1. Metrics-off, full-product caller wall as primary; metrics-on server/RSS characterization separate.
2. Execute and trace the real four-call lifecycle; time SQLite `validate + commit` versus kernel `submit + advance`.
3. Replace point-estimate N=25/12/8/4 gating with balanced paired scheduling, adequate N, and a one-sided confidence rule with an INCONCLUSIVE state.
4. Move replicated modules under `corpusRoot/src`, correct the 880/1,000 claim, and full-scale preflight the corpus.
5. Redesign RSS around the real warm schedule, combined process footprint, an absolute cap, and baseline-adjusted growth.
6. Make cold processes symmetric, bind every metric to a sample, and provenance-bind/machine-enforce the operator artifact.
tokens used
239,486
## Findings

1. **Blocker — Kernel-only observability contaminates the primary wall-time verdict.**  
   The plan times kernel mutations with `--metrics` enabled so it can obtain `serverWallNs` ([plan:68](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:68), [plan:72](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:72)). Metrics mode performs an extra full-snapshot serialization during every analysis and candidate build ([provider.rs:40](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/provider.rs:40), [executor.rs:108](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/executor.rs:108)). It also emits and flushes JSONL before the mutation returns ([session.rs:258](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:258), [metrics.rs:132](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/metrics.rs:132)). SQLite receives no comparable observer workload. This can unfairly push the kernel above 1.25×, particularly when the snapshot is replicated 40×.

   **Amendment:** Run the dispositive caller-wall schedule with metrics completely off for both arms. Run a separate, identically scheduled metrics-on characterization for server stages and RSS. Never subtract the observer cost from measured values or substitute server wall for caller wall.

2. **Blocker — The timed windows are not symmetric, and the proposed “4 vs 4” assertion is false for the specified execution.**  
   The SQLite measurement executes and times only `commit()` after `begin` and `rename_symbol`, while the kernel primary includes both `submit` and `advance` ([plan:67](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:67), [plan:68](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:68)). Yet Task 6 claims SQLite also executes `validate` ([plan:153](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:153)). The real product transcript explicitly calls `validate` before `commit_transaction` ([replay.test.ts:40](/Users/toddhebebrand/Strata/packages/agent/tests/replay.test.ts:40)), and `commit()` validates again internally ([validate.ts:237](/Users/toddhebebrand/Strata/packages/verify/src/validate.ts:237)). The existing gate-1 SQLite flow confirms that calling `commit()` alone is only three mutation calls, not four ([gate1.ts:222](/Users/toddhebebrand/Strata/packages/live-compare/src/gate1.ts:222)).

   This boundary can unfairly penalize the kernel by charging both post-draft calls while excluding SQLite’s explicit post-draft validation.

   **Amendment:** Make the primary current-product wall begin after draft construction and cover `submit + advance` for kernel versus `validate + commit` for SQLite. Report commit-only, validate-only, submit-only, and advance-only walls secondarily. Derive lifecycle parity from a runtime call trace or injected spies—not an adjacent list that can disagree with execution.

3. **Blocker — The sample sizes cannot support a p95 noninferiority verdict.**  
   The plan uses direct point ratios with no uncertainty rule ([plan:35](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:35)) and proposes medium N=25/8 and big N=12/4 ([plan:172](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:172), [plan:173](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:173)). Under the chosen nearest-rank implementation ([redb_spike.rs:258](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/redb_spike.rs:258)):

   - N=8, 12, or 4 makes p95 the sample maximum.
   - N=25 makes p95 the second-largest sample.
   - p99 is the maximum for every proposed N.

   Separate per-arm distributions also leave arm order unspecified ([plan:90](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:90)), allowing cache state, background load, or thermal drift to bias the ratio. A single noisy maximum can cause either a false pass or a false falsifier.

   **Amendment:** Pre-register paired, seeded AB/BA arm ordering; preserve pair ID, order, and iteration. Select N through a precision/power calculation, not runtime convenience. Pass only when a one-sided 95% upper confidence bound for the p95 ratio is ≤1.25. If the confidence interval crosses 1.25, record **INCONCLUSIVE**, not PASS or falsifier-5 FAIL.

4. **Blocker — The proposed big-corpus layout is outside both the ingest and kernel validation roots.**  
   Task 1 places modules under `outDir/copyNN/src/**` ([plan:46](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:46)), but `buildCorpusInputs()` scans only `<corpusRoot>/src/**` ([tasks.ts:535](/Users/toddhebebrand/Strata/packages/live-compare/src/tasks.ts:535)). The daemon likewise fixes `source-root` to `<corpusRoot>/src` ([service.ts:54](/Users/toddhebebrand/Strata/packages/live-compare/src/service.ts:54)), and the worker rejects any module outside that root ([candidate.ts:279](/Users/toddhebebrand/Strata/packages/kernel-bridge/src/candidate.ts:279)). As written, the test expecting `buildCorpusInputs(corpusRoot)` to return the copies cannot pass.

   There is also a scale mismatch: the current tracked `examples/medium/src` set contains 22 TypeScript modules, so ×40 produces 880, not the asserted 1,000. The source domain is exactly the `src/**/*.ts` set ([tsconfig.json:18](/Users/toddhebebrand/Strata/examples/medium/tsconfig.json:18)).

   **Amendment:** Generate `outDir/src/copyNN/**` and use `include: ["src/**/*.ts"]`. Preserve the operator-approved ×40 but correct every count and label to 880, or obtain approval to use ×46 for 1,012 modules. Run a full-scale typecheck and actual serialized bridge-request bound check before starting repeated measurements—not merely a four-copy typecheck.

5. **Blocker — The 8× total-RSS ratio can hide corpus-explosive memory and the measurement omits warm accumulation.**  
   Memory is measured in a separate one-mutation run ([plan:111](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:111), [plan:113](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:113)), then judged by `big/medium ≤ 8` on total peak RSS ([plan:133](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:133)). Gate 2 already measured medium worker RSS at 249,397,248 bytes ([gate2 profile:8](/Users/toddhebebrand/Strata/docs/spikes/gate2-observability-profile.md:8)); the predicate would therefore permit nearly 2 GB for the big worker alone. A large fixed Node runtime baseline also lets linearly growing corpus allocations appear nearly flat in a total-RSS ratio.

   The separate one-mutation run cannot see persistent-history growth. SQLite appends operation rows on every commit ([transactions.ts:253](/Users/toddhebebrand/Strata/packages/store/src/transactions.ts:253)); the daemon appends pending, effect, and completed journal records on every request ([session.rs:420](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:420), [session.rs:451](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/session.rs:451)).

   **Amendment:** Measure RSS during the exact cold and full warm schedules, retaining per-iteration high-water marks. Define the product headline as combined daemon-plus-active-worker RSS, with daemon and worker components separately reported. Replace the 8× total ratio with a preregistered absolute 1k capacity cap plus baseline-adjusted component growth using a tiny/empty control. Apply the falsifier predicate to kernel memory; an exploding SQLite control should invalidate the comparison, not count as a kernel failure.

6. **Major — “Cold” is process-cold for kernel but only database-cold for SQLite, while warm-state drift is not analyzed.**  
   The global definition promises a fresh process/seed ([plan:23](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:23)), but Task 3 specifies only a fresh in-memory SQLite DB ([plan:90](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:90)). The existing SQLite flow opens a new DB inside the already-running Node process ([gate1.ts:203](/Users/toddhebebrand/Strata/packages/live-compare/src/gate1.ts:203)), whereas kernel startup spawns a new daemon ([service.ts:54](/Users/toddhebebrand/Strata/packages/live-compare/src/service.ts:54)). SQLite can therefore retain V8/module/JIT warming across nominal cold samples.

   Alternating rename itself is reasonable, and TypeScript does create a fresh `Program` on every validation rather than keeping an incremental program cache ([validate.ts:92](/Users/toddhebebrand/Strata/packages/verify/src/validate.ts:92), [validate.ts:142](/Users/toddhebebrand/Strata/packages/verify/src/validate.ts:142)). But graph size is the only fixed state; histories and journals grow, making early and late warm samples nonexchangeable.

   **Amendment:** Execute every cold sample in a fresh isolated child for both arms. Run warm arms in two persistent isolated processes, interleaved according to the balanced schedule. Retain generation/iteration and report first-half versus last-half p95 plus latency/RSS trend; pre-register a warm horizon instead of calling N “unbounded.”

7. **Major — `serverWallNs` cannot be safely attributed as planned and then disappears from the profile.**  
   Kernel worker records carry `changeSetId`, but request records carry only action, wall, publication, and sequence ([gate2.ts:84](/Users/toddhebebrand/Strata/packages/live-compare/src/gate2.ts:84), [gate2.ts:116](/Users/toddhebebrand/Strata/packages/live-compare/src/gate2.ts:116)). Reading an accumulating warm-run JSONL and summing action names can accidentally include earlier mutations. Moreover, the plan promises distributions for every timed quantity ([plan:19](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:19)), but the profile contains only caller-wall distributions ([plan:34](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:34)).

   **Amendment:** Add request/change-set identity to request metrics, or bracket each mutation by file offset/sequence and require exactly one new submit plus one publishing advance. Retain raw and aggregated server-wall distributions. Describe caller-minus-server as total client/framing/scheduling/observer overhead—not merely socket-connect cost.

8. **Major — The decisive operator run is not machine-enforced or provenance-bound.**  
   The big script merely prints verdicts ([plan:173](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:173)); the operator later reads and interprets them manually ([plan:190](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:190)). The run is intentionally absent from the automated chain ([plan:177](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:177)), while the proposed artifact schema has no source commit, binary/harness digest, host, runtime versions, or schedule seed ([plan:31](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:31)).

   **Amendment:** Keep the heavy run operator-invoked, but make it tri-state and machine-enforced: exit 0 for PASS, 2 for valid measured FAIL, and 1 for infrastructure/inconclusive. Always write the artifact first. Record HEAD, dirty-state/harness digest, binary hashes, corpus digest/count, OS/CPU, Node/Rust versions, schedule seed/order, N, and metrics mode. Add a cheap CI test that validates the committed artifact and its exact decision-source commit.

9. **Minor — The runtime estimate incorrectly says the kernel runs tsc twice per mutation.**  
   The plan uses that assertion to justify moving the large run out of CI ([plan:26](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:26)). The candidate worker calls `commit()` once ([candidate.ts:121](/Users/toddhebebrand/Strata/packages/kernel-bridge/src/candidate.ts:121)), and that commit performs one `validate()` ([validate.ts:237](/Users/toddhebebrand/Strata/packages/verify/src/validate.ts:237)). Under the corrected four-call SQLite product lifecycle, SQLite—not kernel—performs an explicit validation followed by commit’s second validation.

   **Amendment:** Correct the runtime model and run a non-dispositive pilot solely to size N/timeouts before freezing the statistical schedule.

## Pressure checks that held

- Caller-side wall should remain the primary current-product metric. Charging Unix-socket connection cost is honest because the client is deliberately one-request-per-connection today ([client.ts:95](/Users/toddhebebrand/Strata/packages/live-compare/src/client.ts:95), [client.ts:170](/Users/toddhebebrand/Strata/packages/live-compare/src/client.ts:170)). Server wall is diagnostic only.
- Identical copies do not benefit from a retained TypeScript incremental `Program`; validation constructs a new program each time. Balanced ordering is still needed for process/JIT and system-cache effects.
- The bridge-frame estimate is safe after correcting the corpus layout. A read-only ingest produced a 9,549,461-byte ×40 snapshot, consistent with gate 2’s 238,642-byte medium snapshot ([gate2 profile:10](/Users/toddhebebrand/Strata/docs/spikes/gate2-observability-profile.md:10)) and below the 32 MiB request bound ([process.rs:51](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bridge/process.rs:51)).
- Medium-in-CI plus operator-run big corpus is acceptable if Finding 8 is implemented.
- The plan’s response to an actual red result is appropriately strict ([plan:15](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:15), [plan:191](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md:191)). The problem is that the present predicates could manufacture the wrong red—or green—before that discipline applies.

## Verdict

**Plan needs amendment.**

Minimal amendment set:

1. Metrics-off, full-product caller wall as primary; metrics-on server/RSS characterization separate.
2. Execute and trace the real four-call lifecycle; time SQLite `validate + commit` versus kernel `submit + advance`.
3. Replace point-estimate N=25/12/8/4 gating with balanced paired scheduling, adequate N, and a one-sided confidence rule with an INCONCLUSIVE state.
4. Move replicated modules under `corpusRoot/src`, correct the 880/1,000 claim, and full-scale preflight the corpus.
5. Redesign RSS around the real warm schedule, combined process footprint, an absolute cap, and baseline-adjusted growth.
6. Make cold processes symmetric, bind every metric to a sample, and provenance-bind/machine-enforce the operator artifact.
