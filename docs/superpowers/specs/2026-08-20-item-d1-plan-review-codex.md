# Item D-1 plan v1 — methodology review (Codex gpt-5.6-sol, high, read-only)

**Provenance.** Run 2026-08-20 against `main` at fba409f, read-only, ~160k
tokens. Plan reviewed: `docs/superpowers/plans/2026-08-20-item-d1-extraction-plan.md` (v1).

**Verdict: PROCEED-WITH-CORRECTIONS.** All corrections folded into plan v2.

**Verification (house rule: pivotal claims checked before acceptance).** Both
factual corrections re-verified by enumeration and CONFIRMED — v1 was wrong on
both counts:
- Rust fixture coupling is THREE joins in ONE file
  (`crates/strata-kernel/tests/local_service.rs`), not "six Rust test files".
- Consumers: 14 source files and 10 test files inside `live-compare`, not the
  four v1 listed.

---


**PROCEED-WITH-CORRECTIONS.** The extraction boundary matches the governing spec, and no architectural re-grounding is needed. However, Task 3 currently commits a broken `live-compare` package before Task 4 repoints its imports; Task 4 materially undercounts consumers; and its proposed structural assertion would not prove exact signature parity. Move/repoint atomically, relocate the protocol tests and fixtures with the package, and add the TypeScript project-reference edge.

## Factual corrections and missed edges

- The Rust fixture claim is overstated. There are exactly **three hardcoded paths, all in `crates/strata-kernel/tests/local_service.rs`**, at [local_service.rs:48](/Users/toddhebebrand/Strata/crates/strata-kernel/tests/local_service.rs:48), [local_service.rs:79](/Users/toddhebebrand/Strata/crates/strata-kernel/tests/local_service.rs:79), and [local_service.rs:86](/Users/toddhebebrand/Strata/crates/strata-kernel/tests/local_service.rs:86)—not six Rust test files. The separate kernel-bridge fixture path is unrelated and should remain untouched: [bridge_protocol.rs:42](/Users/toddhebebrand/Strata/crates/strata-kernel/tests/bridge_protocol.rs:42).

- Task 4 misses these direct source consumers: [gate1.ts:55](/Users/toddhebebrand/Strata/packages/live-compare/src/gate1.ts:55), [gate2.ts:17](/Users/toddhebebrand/Strata/packages/live-compare/src/gate2.ts:17), [characterize.ts:29](/Users/toddhebebrand/Strata/packages/live-compare/src/gate3/characterize.ts:29), [kernel-child.ts:25](/Users/toddhebebrand/Strata/packages/live-compare/src/gate3/kernel-child.ts:25), [step0-stage-decomposition.ts:27](/Users/toddhebebrand/Strata/packages/live-compare/src/gate3/step0-stage-decomposition.ts:27), [differential-oracle.ts:70](/Users/toddhebebrand/Strata/packages/live-compare/src/persistence/differential-oracle.ts:70), [exit-gate-memory.ts:33](/Users/toddhebebrand/Strata/packages/live-compare/src/persistence/exit-gate-memory.ts:33), and—importantly, because it must remain unstaged except for this import rewrite—[tasks.ts:5](/Users/toddhebebrand/Strata/packages/live-compare/src/tasks.ts:5).

- It also misses direct test imports in `behavioralGate`, `behavioralTimeout`, `discoveryBootstrap`, `gate1Crash`, `gate1Intrusion`, `persistenceMemory`, `persistentBridge`, and `service`; examples: [behavioralTimeout.test.ts:59](/Users/toddhebebrand/Strata/packages/live-compare/tests/behavioralTimeout.test.ts:59), [gate1Crash.test.ts:28](/Users/toddhebebrand/Strata/packages/live-compare/tests/gate1Crash.test.ts:28), [persistentBridge.test.ts:41](/Users/toddhebebrand/Strata/packages/live-compare/tests/persistentBridge.test.ts:41). The “gate tests consume the harness” wording does not cover these direct imports.

- Task 3’s move precedes consumer rewrites, so that commit is red as written ([plan:137](/Users/toddhebebrand/Strata/docs/superpowers/plans/2026-08-20-item-d1-extraction-plan.md:137), [agent.ts:8](/Users/toddhebebrand/Strata/packages/live-compare/src/agent.ts:8)). Make Tasks 3–4 one atomic commit, or use temporary forwarding files and remove them before the final commit.

- Add `{ "path": "../coordination-client" }` to `live-compare/tsconfig.json`. It currently has no references ([tsconfig.json:1](/Users/toddhebebrand/Strata/packages/live-compare/tsconfig.json:1)), while root gates invoke `pnpm --filter @strata-code/live-compare build` directly ([package.json:17](/Users/toddhebebrand/Strata/package.json:17)). Without the reference, an existing local `dist` can mask a clean-build failure.

- The `service.ts` hardcoding claim is correct: CJS-root discovery is at [service.ts:11](/Users/toddhebebrand/Strata/packages/live-compare/src/service.ts:11), and debug binary/worker defaults are at [service.ts:80](/Users/toddhebebrand/Strata/packages/live-compare/src/service.ts:80).

## Open questions

1. **Move `protocol-v1` to `packages/coordination-client/tests/fixtures/protocol-v1/`, together with `protocol.test.ts`.** Update the three Rust joins above. The fixtures define the extracted package’s wire contract; leaving them in `live-compare` preserves the wrong ownership boundary.

2. **No.** Moving `client.test.ts` does not affect Rust fixture lockstep; it imports protocol helpers but reads no fixture files ([client.test.ts:5](/Users/toddhebebrand/Strata/packages/live-compare/tests/client.test.ts:5)). Moving `protocol.test.ts`/fixtures does require the three Rust path updates.

3. **Do not retain the `live-compare` barrel re-export.** No external workspace consumer imports this private leaf, and the current barrel already exposes both files at [index.ts:5](/Users/toddhebebrand/Strata/packages/live-compare/src/index.ts:5) and [index.ts:12](/Users/toddhebebrand/Strata/packages/live-compare/src/index.ts:12). Take the private import break now.

4. **Task 2 belongs in D-1.** The three current partitions agree—TS validator [protocol.ts:216](/Users/toddhebebrand/Strata/packages/live-compare/src/protocol.ts:216), client [client.ts:61](/Users/toddhebebrand/Strata/packages/live-compare/src/client.ts:61), Rust [protocol.rs:643](/Users/toddhebebrand/Strata/crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs:643)—but the shared fixture prevents the next action addition from drifting during D-2.

5. **No additional live behavior bug today.** The partition matches, and the API mismatch is latent/type-contract debt: `kind` is widened to `string` in the interface ([tools.ts:116](/Users/toddhebebrand/Strata/packages/live-compare/src/tools.ts:116)) versus the client’s enum ([client.ts:275](/Users/toddhebebrand/Strata/packages/live-compare/src/client.ts:275)); runtime tool input is nevertheless enum-constrained ([tools.ts:62](/Users/toddhebebrand/Strata/packages/live-compare/src/tools.ts:62)). A plain assignment or `satisfies` assertion is insufficiently exact because method compatibility can accept this shape. Define `CoordinationClientApi` as a `Pick<CoordinationClient, ...>` or add exact per-method type-equality assertions.
