# Strata — Results

*The complete, honest story. Status: 2026-05-16. Authoritative decision trail: [`decisions.md`](../decisions.md). Architecture: [`strata-design.md`](../strata-design.md).*

## The thesis

AI coding agents are bottlenecked by the file abstraction. They consume context loading whole files to change one function, emit fragile text diffs, and re-derive structure a parser already knows. Strata replaces files with a persistent, queryable node graph: agents address functions/declarations/identifiers by stable ID, mutate through structural operations inside transactions, and never see a filesystem. The bet: same model, same task — materially less work to the right answer.

This document reports what was built, what was measured, where the claim holds, and — just as carefully — where it does not.

## What was built (Phases 0–1.5)

A TypeScript pnpm monorepo, 35 commits (`9c5e21d` → `9774597`), every phase gated by explicit bail-signals:

- **Phase 0 — round-trip.** TypeScript → SQLite node graph → rendered TypeScript, byte-identical, `tsc`-clean. Decision logged: the TS Compiler API does parse + print + verify (tree-sitter/Prettier dropped — canonical rendering makes round-trip-preservation moot).
- **Phase 1 — the `rename_symbol` vertical slice.** Identifier-level lowering, a `TypeChecker`-resolved reference index, transactions with an operation log, validate-before-commit. Acceptance: benchmark task **T03** (rename `User`→`Account` across imports, JSDoc, type positions, generics, namespace imports, a type-only re-export — *without* touching a `"User"` string literal) passes programmatically against a real multi-module corpus.
- **Phase 3 — the agent.** A headless `@anthropic-ai/claude-agent-sdk` agent with **only** the structural tools and **no filesystem tools**, completing T03 end-to-end through the tool loop. Hermetic isolation had to be earned (see below).
- **Phase 4 — the benchmark.** `@strata/bench`: the Strata agent vs. a file-tools "Claude Code" baseline on a temp git checkout, same prompt/model/success-bar, N trials, distributions.
- **Phase 1.5 — three more tools.** `add_parameter`, `change_return_type`, `replace_body`, on a generalized text-span overlay, to test whether the win *generalizes* past one task. (170 unit tests green.)

## The methodology is the credibility (the hard-won part)

The result is trustworthy because the harness was attacked, not flattered. Three times the project hit a wall and *stopped* rather than papering over it:

1. **BS1 (Phase 1).** A JSDoc-resolution probe failed. Investigation — not a workaround — showed the substrate was fine; the implementation had used `ts.forEachChild` (which skips JSDoc) plus an internal `.jsDoc` property. A standalone probe proved the public `TypeChecker` resolves JSDoc references. The bail-signal *correctly prevented a papered-over probe*.
2. **Agent isolation (Phase 3).** The live agent's strict tool-guard caught the SDK injecting an `LSP` tool, then ambient `~/.claude.json` MCP servers (Breeze) leaking in. The guard was **not** relaxed; isolation was enforced via the SDK's own mechanisms (`disallowedTools`, `strictMcpConfig`, `settingSources:[]`). Two installed-SDK-vs-docs gaps were documented.
3. **Scorer asymmetry (Phase 1.5).** The first 4-task round was *invalid*: a fixture broke the seed `tsc`-clean invariant and the substrate/baseline were scored over different file scopes. This was caught by an N=1 validation round **before** spending on N=3, diagnosed, and remediated (one shared src-only scope, proven byte-identical by a key-free `scopeEquivalence` gate across 4 tasks × 3 states). The T03 baseline passing again *after* the fix — exactly as in the pre-bug Phase 4 round — is what proves the harness is fair, not rigged.

A benchmark that survives its own adversarial review is worth more than one that always wins.

## The result: the thesis holds for atomic structural edits

**T03 (rename), N=3 per config, `claude-sonnet-4-6`, identical prompt/model/success-bar, one shared scoring core. Both configs 3/3 success, identical output quality (tsc + corpus tests pass):**

| Metric | Substrate | Baseline | Separation |
|---|---|---|---|
| Total tokens | [1201, 1270, 1473] | [4450, 4514, 4682] | **disjoint**, ~3.5× fewer |
| Wall time | 24.6–30.3 s | 57.4–59.4 s | **disjoint**, ~2.2× faster |
| Tool/edit calls | 7–11 | 25–27 | **disjoint**, ~3× fewer |
| Cost / run | ~$0.038 | ~$0.184 | ~4.9× cheaper |
| Self-corrections | 0 | 0–2 | — |

The token distributions do not overlap (substrate max 1473 < baseline min 4450). This is an *observed separation at N=3*, explicitly **not** a statistical-significance claim — but it is robust: T03 reproduced the win again under the fully-remediated, independently-validated harness (substrate 1359 tok / 30.6 s vs. baseline 3910 tok / 56.4 s) and again after a system-prompt change. Same model, same task, same bar, no quality loss — the structural substrate does materially less work to the right answer. **The file-abstraction bottleneck is real, and removing it helps.**

## The boundary: it does not (yet) generalize to multi-step refactors

Phase 1.5 added three more tools to test generalization. They pass 170 unit tests. The agent **cannot effectively wield them on real tasks**, and — importantly — this was *diagnosed from the agent's actual tool-call transcripts*, then a cheap fix was *attempted and falsified*:

- **T05 (a one-line bugfix control):** the substrate agent made 23 tool calls, **zero mutations**, looped on read-only exploration, and timed out. The file baseline did it in 5 calls / 16 s. The control inverted — the strongest possible evidence the gap is the substrate, not a rigged comparison.
- **T01 (`add_parameter`):** the agent distrusts the tool's callsite fan-out, hand-patches callsites with `replace_body`, collides with the edits the tool already queued, rolls back, retries — never converging.
- **T08 (`change_return_type`):** the agent commits *confidently wrong* — `validate` (tsc-clean) passes, but the corpus test fails. **The commit gate is weaker than the task's real success criterion.**

A fair, general system-prompt + tool-description rework (explore-then-act discipline; an explicit "do not hand-patch callsites" instruction) was applied and re-validated. The failing transcripts were **byte-for-byte unchanged**. Conclusion (recorded as a terminal bail-signal, not iterated further): **this boundary is not prompt-engineerable.** Rename works because it is a single unambiguous operation with no decisions; the expanded tools introduce choices — which tool, when to stop exploring, did the change actually satisfy the task — that the current loop does not equip the agent to make.

## Honest limitations

- **N is small.** All separations are observed at N=1–3 and reported as indicative, never as significance claims.
- **One task carries the positive result.** The robust win is rename (T03). It is one task, one ~3–5k-LOC corpus, one model (`claude-sonnet-4-6`).
- **The negative is also bounded.** "Not agent-effective" was shown for three tools on this corpus/model; it is diagnosed, not merely observed, but it is not proof of an impossibility.
- **TypeScript only**; the substrate leans on the TS Compiler API (a Rust port would need its own resolver — a known, logged consideration, not undertaken).

## The named next lever — built, found invalid as-built (BG-4), fixed (task-scoped), and keyed-validated: PASS (2026-05-16)

The boundary's one substantive lever — **the agent loop must gate commit on behavioral task-acceptance (run the tests), not just `tsc`-clean** — has now been built. The on-disk render+tsc+test runner was lowered into `@strata/verify` so the agent's commit gate and the benchmark scorer are *one shared function by construction*; `commit_transaction` now refuses a change that type-checks but fails the corpus test suite, returning the failing tests to the agent the same way type errors already are — on live runs only, leaving the proven T03 path and the (now 176) key-free tests byte-unchanged. The build record — including an attempted error-swallowing deviation that was caught and rejected, then fixed properly — is logged in [`decisions.md`](../decisions.md) (2026-05-16); the spec and task plan are under [`docs/specs/`](specs/2026-05-16-behavioral-commit-gate-design.md) and [`docs/superpowers/plans/`](superpowers/plans/2026-05-16-behavioral-commit-gate.md).

The first operator-keyed re-run ($1.52, N=1) **falsified the gate as built**: `runCorpusAcceptance` ran the *entire* corpus vitest suite, and the shared seed `examples/medium` deliberately ships a failing test that **is the T05 task's own fail-before fixture** — making the gate structurally unsatisfiable for T01/T03/T08 by the correct task change alone. The agent reached green only by *also* fixing the unrelated T05 bug (T08 verbatim: *"I need to fix isWithinRange in the same transaction"*), which **triggered BG-4** (the proven atomic rename regressed to a two-transaction rename-plus-unrelated-bugfix, 2176 tok / 12 tools / 45 s) and contaminated the T03/T08 scorer. That was logged as a STOP, not papered over.

The gate was then made **task-scoped**: an authoritative fail-loud `behavioralFixturesForTask` map in `@strata/verify` (T01→`format.test.ts`, T05→`dateRange.test.ts`, T03/T08→`[]` tsc-only); `vitestRun`/`runCorpusAcceptance` additively scoped (`undefined`⇒whole-suite preserved so the key-free suite is byte-identical); the live gate **and** both scorers resolve the *same* function so gate==scorer holds per task. Built TDD, 8 tasks, two-stage review per task, key-free suite 188 passing / 2 skipped, final whole-branch review READY TO FINISH. Spec `docs/superpowers/specs/2026-05-16-gate-scope-redesign-design.md`; plan `docs/superpowers/plans/2026-05-16-gate-scope-redesign.md`.

The second operator-keyed re-run (same form, N=1, **$0.79**), classified from transcripts against the *pre-committed* bail signals **GS-1..GS-4**, **passed all four**: **GS-1** — T03 returned to the canonical single clean transaction (1228 tok / 6 tools / 28 s / 0 retries, 0 unrelated `replace_body`), BG-4 fully reversed, still beating baseline (3553 tok / 21 tools); **GS-2** — the gate has correct task-scoped teeth (it rejected T05's empty no-op first transaction with T05's *own* fail-before signal, driving a real fix → 1/1); **GS-3** — T03 and T08 each committed in one transaction with only their own edits, no cross-task collateral (the BG-4 symptom is gone); **GS-4** — scorer==gate, no divergence. Substantively: **T08 is now a clean substrate win (1/1, one transaction; baseline 0/1)**; **T05 succeeds 1/1, gate-driven** (a correctness success at N=1, not an efficiency win — substrate 18 tools/74 s vs baseline 6/19 s). **T01 still fails — and the gate is provably not its lever**: it never reaches `commit_transaction` (`validate` fails twice with `oldText mismatch` — the diagnosed `add_parameter`/manual-`replace_body` callsite-collision thrash — then wall-aborts), so the behavioral gate is never invoked. T01's remaining lever is `add_parameter` tool legibility and/or model capability, a different lever than the commit gate and one prompt tuning already failed to move. Authoritative classification: the [`decisions.md`](../decisions.md) entry (2026-05-16, "Keyed validation of the task-scoped gate: GS-1..GS-4 ALL PASS").

That N=1 result was then **hardened at N=3** (pre-registered tamper-evidently as HN-1..HN-4 in [`docs/superpowers/specs/2026-05-16-n3-hardening-prereg.md`](superpowers/specs/2026-05-16-n3-hardening-prereg.md) *before* the round; `claude-sonnet-4-6`, 24 live runs, $3.82; classified from the 12 transcripts). Outcome — no bail STOP:
- **HN-1 PASS, 3/3.** Every T03 trial is the canonical single clean rename (1 transaction, 0 `replace_body`, 7 tools, ~1040 tok, 22–25 s, 0 retries), disjoint from baseline (≤1066 vs ≥3825 tok). **The flagship proven win is re-replicated at N=3 on the now-valid harness** — the strongest evidence the gate-scope fix preserved it.
- **HN-3 PASS, 3/3.** The T05 gate-driven mechanism replicates every trial (scoped gate rejects the no-op first transaction with T05's *own* fixture → real fix → success). Honest caveat: T05 is a *correctness* success but an *efficiency loss* vs baseline (~6.5k vs ~0.8k tok).
- **HN-4 PASS, 0/3 isolated.** T01 fails every trial via the diagnosed `add_parameter`/`replace_body` `oldText mismatch` thrash; never a correct committed change; no surprise success. Gate confirmed not its lever.
- **HN-2 — recorded 2/3, root-caused to a scorer artifact, corrected to 3/3.** All three T08 trials were process-identical, clean, single-transaction, no cross-task collateral, tsc-clean + vitest-passing + committed. Investigation #1 (systematic debugging) found `callersTypecheckUnderNarrowType` scanned the *whole* `permissions.ts` for `role === "x"`: it (i) rejected the valid exhaustive `switch (role)` caller all three agents wrote (false negative → trial-1 spuriously failed) and (ii) passed trials 2/3 only off a coincidental `role === "x"` in `getRole`'s body (false positive → right answer, wrong reason). The criterion was corrected to be caller-scoped and form-agnostic (`if` *or* `switch`), justified by measurement-correctness independent of outcome and verified by: 2 new TDD tests, a deterministic re-score (OLD reproduces 2/3 exactly, NEW = 3/3 with 2/3 now passing for the *legitimate* reason), and an independent opus integrity audit ("legitimate, sound, not gerrymandered"). **T08's true behavioral pass rate at N=3 is 3/3.**

Net at N=3, after the T08 criterion correction: **T03 3/3 (flagship, robust), T05 3/3 (gate-driven *correctness* win, not efficiency), T08 3/3 (scorer artifact corrected, audited), T01 0/3 (firmly isolated to the known non-gate lever).** Authoritative: the newest-first [`decisions.md`](../decisions.md) entries (2026-05-16, "T08 HN-2 root-caused …" and "N=3 hardening …"). **The T01 lever is now positively identified.** A frozen pre-registered single-variable probe (`docs/superpowers/specs/2026-05-16-t01-stronger-model-probe-prereg.md`; `claude-opus-4-7`, N=2, T03 as guard, $3.70) **ruled out model capability**: at the strongest available model T01 still scored **0/2, never reaching a correct committed change**, via the *identical* `add_parameter`/`replace_body` `oldText-mismatch` collision thrash (same mechanism, not a new one); the T03 guard stayed canonical under the swap, so the read is valid. The L2 probe pointed at tool legibility as the hypothesised T01 lever; that hypothesis was then **built and falsified**. A bonus observation from the probe: the Opus *file baseline* hit `error_max_turns` on the **T03 rename** (25 tools) where the substrate finished in **6** — the atomic-edit win is, if anything, *amplified* under a stronger model (N=2, indicative).

**The T01 boundary is now exhaustively characterized.** The `add_parameter` legibility redesign was implemented (an itemized, audit-proof `AddParameterManifest` of exactly what the tool did, surfaced in the tool result; description held byte-constant as the control) and keyed-validated under a frozen pre-reg (`docs/superpowers/specs/2026-05-17-add-parameter-legibility-probe-prereg.md`; `claude-sonnet-4-6`, N=3, T03 guard, $2.86). Result (AP-1 PASS / **AP-2 NEGATIVE** / **AP-3 mechanism unchanged**): T01 substrate **0/3, operationRowAppended 0/3**; the manifest *was delivered* and the agent **ignored the verifiable evidence and hand-patched callsites with `replace_body` anyway**, hitting the identical `oldText mismatch` collision — byte-same thrash as pre-manifest sonnet and Opus — then terminating confident-wrong. T03 stayed canonical 3/3 (read valid). So tool-**result** legibility is insufficient, exactly as tool-**description** legibility was: T01 is **not a communication problem**. The boundary is now bounded by **four independent, pre-registered, transcript-classified, falsified levers** — prompt/description tuning (BS-P-B), the commit gate (built/validated, not T01's lever), model capability (Opus probe, L2), and tool-result legibility (AP round) — with the atomic-edit win (T03) robust, replicated and model-independent across all four. Authoritative: the newest-first [`decisions.md`](../decisions.md) entry (2026-05-17, "`add_parameter` legibility keyed validation: AP-2 NEGATIVE …").

Remaining levers (all deeper than legibility/prompt/model/gate — those four are terminal): (a) a tool-surface/affordance change (e.g. removing the `replace_body` escape hatch so the agent *cannot* hand-patch a tool-touched span) or an agent-loop redesign that forbids re-editing it — a different class of change, its own brainstorm→spec→plan→keyed-validation cycle; (b) optional fresh keyed N=3 to confirm T08 3/3 beyond the three audited transcripts; (c) the deferred retirement of brittle text-criteria proxies for the behavioral-gate signal. Most honestly: this is a clean, defensible point to **write up the precisely-bounded result** rather than keep iterating.

## What is reproducible

```
pnpm install && pnpm -r build && pnpm -r test     # 176 passing, 2 key-gated skipped
node packages/cli/dist/cli.js roundtrip <file.ts>  # Phase 0
node packages/cli/dist/cli.js t03 ./examples/medium # Phase 1 acceptance (programmatic)
# Live agent + benchmark (needs ANTHROPIC_API_KEY; writes gitignored results/):
pnpm --filter @strata/bench bench -- --trials=0      # dry-run, cost projection
pnpm --filter @strata/bench bench -- --trials=3 --tasks=T03
pnpm --filter @strata/bench bench -- --trials=1 --tasks=T01,T05,T08,T03  # behavioral-gate re-run (operator)
```

The two key-gated agent tests are reproduced key-free in CI via a committed real transcript fixture. Raw benchmark artifacts are gitignored by design (reproducible, cost-bearing, operator-run); the durable findings live in [`decisions.md`](../decisions.md).

## Remaining Phase-5 deliverable

A 5–10 minute demo video (per `strata-design.md` § Phase 5) is the one artifact this write-up cannot produce; it is left for a human.

## Bottom line

Strata demonstrates, under adversarial scrutiny, that removing the file abstraction makes an agent measurably more efficient at an atomic structural edit — fewer tokens, less time, fewer steps, no quality loss. It also demonstrates, with equal rigor, that this advantage does not yet generalize to multi-step refactors, that the cheap (prompt) fix does not work, and exactly which deeper lever remains. A proven win, a precisely-bounded scope, a diagnosed boundary, and a falsified easy answer — that is the result. The one deeper lever that diagnosis named has since been built and is green key-free; whether it moves the boundary is the next measurement, not a claim made here.
