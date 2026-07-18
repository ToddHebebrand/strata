# Phase-6 live-comparison harness: deterministic gate evidence

**Date:** 2026-07-16 (evening)
**Worktree:** `feature/phase6-live-comparison-design`
**Evidence commit:** recorded in the final section below.
**Toolchain:** rustc/cargo 1.89.0, node v26.3.0 (Homebrew; native modules are
built against MODULE_VERSION 147 — run all test commands with
`/opt/homebrew/bin` first in PATH), pnpm 10.26.2, TypeScript 5.9.3 (toolchain)
compiling package code pinned at workspace 5.8-series configs.

## What this gate covers

Tasks 0–7 of `docs/superpowers/plans/2026-07-16-phase-6-live-comparison.md`,
the operator-approved `x-namespace-enriched-v1` corpus (decisions.md
2026-07-16), the amended M acceptance (serialize-plus-fresh-decision), the
qualified X dynamic-expansion stop gate, the matched worktree baseline, the
preregistered schedule/artifacts/accounting/live-guard harness, and the
remediation of all nine findings from the single post-implementation
independent review.

## Independent review (Task 8 Step 4)

- Model: `gpt-5.6-sol`, reasoning `xhigh`, read-only sandbox, repo-grounded,
  447k tokens. Reviewed commit: `f4afd740`.
- Result: 2 blockers, 7 majors, and explicit no-finding dispositions for
  authority escape and claim strength. Every finding was verified against the
  code before acceptance; all nine were accepted and fixed in commit
  `e3032ae` (plus `b19b487` for a criterion-drift finding discovered by the
  gate itself, below).

Accepted findings and their fixes:

1. **No production live orchestration (blocker).** `orchestrator.ts` now
   drives the frozen schedule deterministically — pre-registered arm order,
   a cumulative-cost stop *before* another arm's sessions are consumed, a
   dispositive stop, per-arm artifact writes, and finalization — with its own
   test suite. `liveAdapter.ts` composes the production pieces (daemon
   lifecycle, two concurrent coordination sessions with the real SDK query,
   harness-side materialization/verification/audit; baseline SDK sessions
   through `runBaselineTrial`) and is imported only after the approval guard
   passes.
2. **Strata tasks were unstartable (blocker).** Assignments now register
   arm-equivalent target addressing: the Strata prompt supplies the exact
   stable IDs its appendix references, the baseline prompt supplies the same
   targets as file locations, task bodies remain byte-identical, and tests
   assert no stable ID appears in a baseline prompt.
3. **Worktree sibling traversal.** Task and integration worktrees now live
   under separate unguessable temp roots.
4. **Unfrozen configuration files.** The manifest freezes every corpus file
   outside `src/` (`frozenTreeFiles`) and the verifier rejects both
   modifications to them and any file not in the registered inventory
   (`.git`/`node_modules` excluded).
5. **Accounting gaps.** `computeTeamAccounting` now ingests the verifier
   result (failed verification counts dispositive `invalid_final_code`),
   cache-read/cache-creation tokens, API duration, tool calls, and
   coordination/integration counters.
6. **Over-permissive rerun.** `permitProviderRerun` requires a
   provider-class failure value in addition to zero output/cost.
7. **Approval gaps.** The live guard now binds `verifierDigest` (a digest of
   the live-compare sources) and an exact `credentialSource`, requires a
   clean worktree, and refuses when both credential variables are set.
8. **Artifact layout.** Per-trial/per-arm `team.json`/`verification.json`/
   `canonical-audit.json`, a `tasks/` stream, and write-once evidence
   snapshots; finalization hashes the full tree recursively.
9. **Mutable manifest.** `createQualifiedTaskManifest` deep-freezes its
   result and `runBaselineTrial` reasserts the registration digest before any
   session.

Registered system prompts for the three session role classes were added in
the same remediation (they are hashed into the manifest); the registration
digest was re-frozen and ends at
`c792052fb3652c229640574ac140ee79febc917e07789daf41822edf6a031257`.

## Gate-discovered regression fixed en route

The full gate caught that `packages/verify` T03 criteria still encoded the
retired type-only serializer import; the enriched corpus made
`namespaceImportRenamed` unsatisfiable. Fixed in `b19b487` (criterion regex
plus verify/bench inline snippets); the agent package returned to its exact
documented baseline of two stale-fixture failures
(`Declaration not found: 5073ecfb56151b41` in `labSeam.test.ts` and
`replay.test.ts`), which remain outside Phase-6 scope and are not
regenerated here.

## Dry-run manifest (key-free, verbatim)

```
dry-run PASS: 30 planned sessions across 6 matched trials
summed per-query budgets: USD 42.00
projected round maximum: USD 55.00
model claude-sonnet-4-6, seed pilot-seed-1, corpus x-namespace-enriched-v1
source digest 41c9059a91e814995471708fa3cd165dc15a1f45f492b809d01831978b3c6eb8
task registration digest c792052fb3652c229640574ac140ee79febc917e07789daf41822edf6a031257
no live result written; no keyed call made
```

No credential was read (proved by a trapping-proxy test) and no live result
was written.

## Full gate results

Every command ran with `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`
removed, on the final tree (commit `6d46c4c` plus this documentation).

| Gate | Result |
| --- | --- |
| `pnpm --filter @strata/agent test` | 59 passed, 2 skipped, and exactly the 2 documented stale-fixture failures (`5073ecfb56151b41` in `labSeam.test.ts`/`replay.test.ts`) — the accepted pre-existing baseline, outside Phase-6 scope |
| `pnpm --filter @strata/live-compare test` | 14 files, 116 passed (sequential; includes both-order D/R/S/G, amended M, the X stop gate, baseline, schedule, artifacts, runner, cli, orchestrator, module-circle pin) |
| `pnpm --filter @strata/agent build`, `pnpm --filter @strata/live-compare build` | PASS |
| `cargo test -p strata-kernel --test local_service` | 13 passed (includes shared protocol-v1 conformance with the `kind` field) |
| `cargo test -p strata-kernel --test local_service_recovery` / `local_service_sealing` | PASS |
| `pnpm -r --no-bail test` | store 177, render 13, ingest 21, verify 70, kernel-bridge 71, bench 62, cli 22, live-compare 116 — all green; only the agent package carries its documented 2-failure baseline (so plain `pnpm -r test` exits non-zero at that package by construction) |
| `pnpm -r build` | PASS (after `6d46c4c`) |
| `cargo test -p strata-kernel` (default) | PASS, all targets (after `6d46c4c` fixed the in-binary unit-test initializer) |
| `cargo test -p strata-kernel --features coordination-test-api` | PASS (177s) |
| `cargo test -p strata-kernel --features redb-spike-api` | PASS (164s) |
| `cargo test -p strata-kernel --test api_sealing` | PASS |
| `pnpm kernel:full-key-free:test` | PASS — 109 green cargo test-result lines, zero failures (439s) |
| `pnpm live-compare:dry-run …` (exact plan command) | PASS, verbatim output above |

Two full-gate-only breakages were found and fixed during this step (commit
`6d46c4c`): the all-targets cargo run compiles an in-binary server unit test
that still built `ServiceEvent` without `kind`, and the repo-wide `tsc -b`
caught that `@strata/bench`'s `TerminalReason` never gained `max_budget` from
the Task-1 hermetic extraction. Both were invisible to every targeted
per-package gate run earlier in the day.

## Not claimed

No live model call or spend occurred anywhere in Tasks 0–8. The deterministic
gate does not claim live-model behavior, prevalence of dynamic expansion,
within-module concurrent publication (explicitly out of scope per the amended
M), or any cost/performance comparison — those require the separately
approved Task 9.
