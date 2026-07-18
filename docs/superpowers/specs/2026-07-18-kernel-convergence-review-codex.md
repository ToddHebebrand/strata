# Independent Codex review: kernel convergence (verbatim)

Received 2026-07-18. Reviewer: Codex CLI `gpt-5.6-sol`, reasoning `xhigh`,
read-only sandbox, repo-grounded. Brief:
[`2026-07-18-kernel-convergence-review-brief.md`](2026-07-18-kernel-convergence-review-brief.md).

**Verification note (per repo rule, checked before acceptance):** the four
pivotal empirical claims were verified against the code in-session —
(1) the kernel's model-visible lifecycle is four calls
(`begin_change_set → add_intent → submit_change_set → advance_change_set`,
`packages/live-compare/src/tools.ts`), matching the SQLite path's four;
(2) the daemon hard-codes `NodeBridgeConfig::tsc_only`
(`crates/strata-kernel/src/bin/strata_kernel_service/main.rs`);
(3) the SQLite path's rollback state is a process-local `Map`
(`overlays`, `packages/store/src/transactions.ts`) that
`startupRecoverOpenTransactions` cannot reconstruct after a crash;
(4) coordinated publication rejects an empty reservation scope
(`crates/strata-kernel/src/storage.rs`). All four hold as cited.

The review body below is verbatim and unedited.

---

## 1. Verdict

**Converge the canonical graph, publication lifecycle, and operation history on the kernel. Do not require SQLite’s complete deletion.** SQLite may remain an ephemeral TypeScript-worker substrate or a rebuildable, generation-stamped vector/index projection, but it should not remain an alternative canonical mutation engine.

That conclusion follows from the code, not architectural aesthetics:

- The kernel already commits fences, resource clocks, the graph delta, operation, ticket, event, generation digest, lifecycle transition, and publication attempt in one redb transaction (`crates/strata-kernel/src/storage.rs:231-340`, `crates/strata-kernel/src/storage.rs:343-389`). Keeping a separate canonical SQLite graph would create two durability authorities with no cross-engine atomic commit.
- The existing SQLite path has exactly the crash hole the kernel was built to remove: inserted/deleted canonical rows are undone using a process-local `Map` (`packages/store/src/transactions.ts:26-57`, `packages/store/src/transactions.ts:145-199`), while restart merely marks open transactions rolled back and cannot reconstruct that undo state (`packages/store/src/transactions.ts:280-285`). The approved kernel design identifies the same limitation (`docs/superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md:9-15`).
- The approved architecture already defines the kernel as the only canonical writer and explicitly rejects SQLite as the target canonical representation (`docs/superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md:46-81`, `docs/superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md:225-230`). The latest decision likewise calls the split “provisional, not architecture” (`decisions.md:27-41`).

The empirical case supports preserving the kernel but not migrating immediately. The N=3 Phase-6 round favored the kernel in every evaluable cost and makespan cell, with 18/18 Strata arms green, but the report correctly limits that claim to its exact model, prompts, corpus, and scenarios (`docs/spikes/2026-07-18-phase-6-n3-directional-results.md:46-66`, `docs/spikes/2026-07-18-phase-6-n3-directional-results.md:68-94`). Therefore: **the split is honest staging today; it is not the honest durable end state.**

## 2. Strongest attack on Claims 1 and 2

### Claim 1: solo fast-path economics

The proposed **bypass** is the wrong design. A solo publisher that skips reservations or fencing would be a second semantic path: coordinated publication expressly rejects an empty reservation scope (`crates/strata-kernel/src/storage.rs:434-453`). “N=1” is also not a stable correctness property—a second client may arrive while analysis or validation is running. Any optimization should coalesce transport or make scheduling immediately ready while retaining the same scope inference, fresh-state checks, validation binding, fences, and atomic publication.

However, the claim that the kernel necessarily adds model-visible ceremony is weaker than the brief suggests:

- A one-intent SQLite mutation is normally `begin_transaction → rename_symbol → validate → commit_transaction` (`packages/agent/src/tools.ts:272-285`, `packages/agent/src/tools.ts:472-519`).
- A one-intent kernel mutation is `begin_change_set → add_intent → submit_change_set → advance_change_set` (`packages/live-compare/src/tools.ts:124-159`). `advance_change_set` internally claims, executes, validates, and publishes (`crates/strata-kernel/src/bin/strata_kernel_service/session.rs:566-655`).
- A properly batched three-operation change is likewise six calls on either surface: begin, three mutations/intents, validate/commit or submit/advance.

The extract artifacts prove the observed regressions—121.1% and 208.1% of file-tool cost (`packages/bench/results/dogfood-extract-2026-05-29T04-00-33-315Z-corrected.md:9-28`, `packages/bench/results/dogfood-extract-2026-05-29T04-26-30-720Z.md:9-28`)—but they do not prove that store lifecycle complexity caused all of it. The later transcript review found that the system prompt itself prescribed per-mutation validation and produced three transactions; the batching correction remains unvalidated (`decisions.md:1069-1077`).

The actual current N=1 risk is hidden wall-time and memory work:

- Submit performs semantic analysis, and claim performs fresh planning again (`crates/strata-kernel/src/coordination/coordinator.rs:205-228`, `crates/strata-kernel/src/coordination/coordinator.rs:352-359`).
- Every analysis serializes the entire graph snapshot (`crates/strata-kernel/src/bridge/provider.rs:42-64`); candidate construction does so again (`crates/strata-kernel/src/bridge/executor.rs:32-79`).
- Every bridge invocation starts a new Node process (`crates/strata-kernel/src/bridge/process.rs:103-147`).
- Each worker reconstructs the full snapshot in an in-memory SQLite database and byte-compares its export (`packages/kernel-bridge/src/snapshot.ts:75-100`).
- Every agent tool request opens a fresh Unix-socket connection (`packages/live-compare/src/client.ts:92-169`).

Thus one uncontended rename currently incurs at least two full-graph analysis hydrations plus one full-graph candidate hydration and validation. The repository contains no N=1 kernel-versus-SQLite stage profile, and the Phase-6 comparison is against Git worktrees, not the SQLite product. **Cost parity is plausible because model-visible call counts can be equal, but it is currently unproven; latency parity on larger corpora is wishful until the full-snapshot/process costs are measured.** No correctness bypass should be built to obtain it.

### Claim 2: stable logical IDs

The current scheme is more deeply position-coupled than a small ID-function replacement:

- IDs hash module path, child-index path, and kind (`packages/store/src/ids.ts:3-20`).
- Deleting one statement deliberately rekeys every later sibling and EOF node (`packages/store/src/removeChildStatement.ts:13-33`, `packages/store/src/removeChildStatement.ts:64-112`).
- Moving a declaration recreates it with a target-derived ID and deletes the source identity (`packages/store/src/moveDeclaration.ts:84-91`, `packages/store/src/moveDeclaration.ts:140-154`).
- Identifier re-derivation intentionally churns IDs inside changed statements, and existing operation-log IDs are accepted as point-in-time pointers (`decisions.md:1332-1353`).

Content addressing is correctly rejected as canonical identity. If syntax or content participates in the ID, a rename or body edit changes identity. If a stable opaque identifier is added alongside a content hash, the hash has become a version/digest—not the identity—which is already how the kernel treats graph and candidate digests.

A workable logical model exists: an immutable opaque node identity, an independent ordering/position field, and a deterministic noncanonical origin locator used for initial ingest or reconciliation. Existing 16-hex IDs can be retained verbatim as legacy opaque IDs; migration need not rekey them.

The hard qualification is re-ingest. No stateless algorithm looking only at current source can know that one of two identical declarations was moved, or recover the historical ID of a node whose position and content both changed. Therefore:

- If “deterministic re-ingest” means re-ingesting unchanged source against its existing canonical graph, reconciliation can preserve identity.
- If it means rebuilding an edited codebase into an empty store and recovering all historical identities without annotations or prior state, the requirements are mutually incompatible.

My estimate from the affected surfaces is: **the core logical-ID representation is weeks; the actual convergence prerequisite—reconciliation semantics, structural operations, references, persisted DB migration, operation-history continuity, indexes, and compatibility behavior—is quarters.** Calling the whole prerequisite “weeks” would understate the work visible in `removeChildStatement`, `moveDeclaration`, materialization, and the logged point-in-time history semantics.

## 3. Sequencing risks not named

- **The daemon’s validation gate is currently weaker than the shipped product’s.** The service hard-codes `NodeBridgeConfig::tsc_only` (`crates/strata-kernel/src/bin/strata_kernel_service/main.rs:88-95`). The candidate worker supports a behavioral mode, but uses plain `commit()` in tsc-only mode (`packages/kernel-bridge/src/candidate.ts:111-143`); the shipped agent path instead renders a scratch corpus and runs both tsc and Vitest (`packages/verify/src/validate.ts:306-345`, `packages/verify/src/corpusRun.ts:225-298`). Product convergence cannot inherit “only-green-together” from the current live daemon without closing this semantic gap.

- **The kernel lacks the product’s discovery worldview.** The shipped agent can find declarations, list exports, search semantically, inspect references, and read nodes before mutation (`packages/agent/src/tools.ts:120-268`, `packages/agent/src/tools.ts:532-577`). The coordination surface only inspects caller-supplied known IDs and explicitly tells the model not to discover or guess them (`packages/live-compare/src/tools.ts:124-145`). The Phase-6 agent evidence therefore does not prove an arbitrary user task can orient itself on the kernel.

- **Operation-history schemas are not equivalent.** SQLite records each operation’s parameters, timestamp, affected IDs, actor, and optional reasoning (`packages/store/src/schema.ts:53-72`, `packages/store/src/transactions.ts:253-275`). The kernel’s canonical `OperationRecord` has actor and reasoning but no timestamp or parameters, and multiple intents are collapsed under `CompositeChangeSet(n)` (`crates/strata-kernel/src/model.rs:54-68`, `crates/strata-kernel/src/coordination/publication.rs:575-587`). Parameters survive in durable intent state, but canonical audit and L3 consumers would need different join semantics. Moreover, existing SQLite operations commonly have `reasoning:null`; the original prompt is stored on the transaction instead (`packages/store/src/rename.ts:71-80`, `packages/store/src/transactions.ts:59-78`). Migration must preserve historical nulls and transaction grouping, not fabricate per-operation reasoning.

- **L2/L3 cannot simply follow publication asynchronously without a generation contract.** L3 currently joins transaction prompts, per-operation rows, and affected IDs from one SQLite database (`packages/store/src/commitPatterns.ts:83-139`). The live coordination agent logs only a prompt hash outside canonical kernel state, while `begin_change_set` persists model-supplied reasoning (`packages/live-compare/src/agent.ts:163-186`, `packages/live-compare/src/tools.ts:135-145`). L2 is keyed by node IDs/content hashes and already has known in-session staleness after rename (`docs/product-roadmap.md:63-72`). Any retained SQLite index must be rebuildable from a named redb generation and refuse to serve mixed-generation results; otherwise it becomes a second authority.

- **A dual-write migration would amplify the SQLite crash weakness.** SQLite can expose precommit row changes whose undo exists only in memory (`packages/store/src/transactions.ts:26-57`), whereas redb atomically binds publication attempts, operations, events, deltas, and digests and verifies those bindings during recovery (`crates/strata-kernel/src/storage.rs:231-340`, `crates/strata-kernel/src/coordination/durable.rs:601-660`). SQLite should therefore be an offline migration source or derived projection during cutover, not a writable rollback peer.

- **Large-corpus behavior is uncharacterized.** Full snapshots are serialized and hydrated for every analysis and candidate, while validation renders every module before bounding dirty inputs (`crates/strata-kernel/src/bridge/provider.rs:42-64`, `packages/kernel-bridge/src/snapshot.ts:75-100`, `packages/verify/src/validate.ts:50-75`). Restart similarly loads the latest snapshot and replays every later delta (`crates/strata-kernel/src/kernel.rs:213-254`). The repository has a snapshot-writing API but no demonstrated production compaction policy (`crates/strata-kernel/src/storage.rs:774-820`).

- **Native packaging is a separate product project.** `kernel-bridge` and `live-compare` are private 0.0.0 packages (`packages/kernel-bridge/package.json:1-23`, `packages/live-compare/package.json:1-27`); the published CLI has no kernel dependency (`packages/cli/package.json:31-50`). The daemon currently requires explicit database, initial snapshot, worker, source, corpus, audit, and socket-token paths and assumes `node` is discoverable (`crates/strata-kernel/src/bin/strata_kernel_service/main.rs:41-105`). Cross-platform binaries, upgrades, worker discovery, service lifetime, clean shutdown, and clean-room npm installation are unproven.

## 4. Smallest honest first slice and measurement gates

The smallest honest slice is a **fresh-store, rename-only, N=1 compatibility vertical slice**:

- The kernel is the sole canonical graph/history writer.
- The full coordination semantics still run: scope inference, immediate scheduling, fresh claim analysis, real validation, fences, and atomic publication. There is no solo correctness bypass.
- The agent gets only the minimal real product surface needed for T03: declaration discovery, bounded inspection/reference reads, one rename, and one logical transaction lifecycle. Both SQLite-control and kernel arms expose the same tool descriptions and call structure.
- SQLite may be used ephemerally inside the TypeScript candidate worker, but not as a second persisted graph.
- Legacy DB migration, L2/L3, `add_parameter`, stable-ID replacement, and the other structural tools remain out of this slice. This tests the canonical-core decision, not the entire migration.

Measurement gates, in order:

1. **Key-free semantic parity:** On `examples/medium`, both arms must produce equivalent nodes, references, rendered TypeScript, tsc/Vitest results, and one auditable rename carrying actor, original task context/reasoning, parameters, and affected IDs. Crash injection must still yield only the complete old or complete new generation. A second client introduced at every nominal “solo” stage must not change correctness.

2. **Key-free observability:** Record per-stage wall time, peak memory, serialized snapshot bytes, Node-worker starts, SQLite hydration time, validation time, redb publication time, and restart replay time. Without this, a keyed result cannot distinguish coordination semantics from bridge mechanics.

3. **Unkeyed noninferiority:** Across cold and warm repeated runs on `examples/medium` and a roughly thousand-module corpus, require no extra agent-visible lifecycle calls, kernel p95 mutation wall time no worse than 1.25× SQLite, and bounded rather than corpus-explosive peak memory. Failure here stops keyed spend.

4. **Clean-room product gate:** Install the packed CLI into a repository-free scratch environment, start/restart the native service, discover and rename a symbol, pass tsc plus tests, and reopen the same canonical database. The current published clean-room proof covers the SQLite exploration path only (`docs/product-roadmap.md:74-80`).

5. **Keyed N=3 noninferiority:** Compare kernel-backed N=1 directly with SQLite-backed N=1 using the same model, prompt, reduced tool surface, scorer, corpus, and arm order balancing. Require both arms 3/3 green, every paired kernel/SQLite cost ratio ≤1.10, no increase in tool calls or turns, and median wall time ≤1.25×. Only after that passes should the kernel arm be compared with file tools to renew the historical T03 claim. The old evidence—3/3 green, 1,201–1,473 versus 4,450–4,682 tokens and roughly $0.038 versus $0.184—is valid only for the measured SQLite substrate (`packages/bench/results/t03-2026-05-15T17-45-47-468Z.md:1-30`).

## 5. Evidence that would falsify “converge”

I would treat any of the following as falsifying this end state, not merely delaying it:

- **N=1 parity requires a semantic bypass.** If the noninferiority gate cannot be met without skipping scope inference, fresh-state analysis, validation binding, reservations, or fenced publication, then “N=1 is the same lifecycle” is false. Keep the split rather than disguise two paths behind one API.

- **Logical identity requires forbidden provenance.** If the ID proof cannot preserve sibling/move stability, existing legacy IDs, and history continuity without content-addressed identity, source-file annotations, or stateless recovery claims that fail on duplicate/moved declarations, then the full structural surface cannot converge honestly.

- **Canonical history cannot migrate losslessly.** A dry-run migration that cannot preserve transaction grouping, operation parameters, actor, historical null reasoning, original task prompt where recorded, point-in-time affected IDs, and ordered history—or that must rewrite old IDs retroactively—falsifies redb as the sole canonical continuation of the existing product history (`packages/store/src/schema.ts:53-72`, `decisions.md:1347-1353`).

- **Derived indexes cannot remain derived.** If L2/L3 correctness requires SQLite writes to participate atomically in redb publication, or consumers cannot reject/rebuild stale generations, SQLite remains co-canonical and the proposed convergence boundary is false.

- **Removing full-graph bridge costs violates the settled semantic boundary.** If large-corpus measurements remain unacceptable and fixing them would require letting Node workers mutate canonical storage, moving TypeScript semantics into Rust, or bypassing validation, the kernel is a successful coordination proof but not the right single-agent product core.

- **A real product surface still needs the SQLite authority.** If declaration discovery, reference queries, behavioral validation, any third typed operation, or clean-room daemon packaging cannot operate from kernel generations/history without reopening the persisted SQLite graph, then the provisional split is the honest architecture after all.
