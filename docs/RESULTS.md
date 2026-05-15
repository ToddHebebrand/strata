# Strata — Results

*The complete, honest story. Status: 2026-05-15. Authoritative decision trail: [`decisions.md`](../decisions.md). Architecture: [`strata-design.md`](../strata-design.md).*

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

## The clear next research direction

The boundary has one substantive remaining lever, named precisely so a successor can pick it up: **the agent loop must gate commit on behavioral task-acceptance (run the tests), not just `tsc`-clean.** This single gap underlies both T08 and (post-prompt-fix) T01. It is a loop/architecture redesign — a new research arc, not a prompt pass — and it, not more tuning, is where the multi-step generalization question should be reopened. A second open lever: evaluate a stronger model at the 11-tool multi-decision surface.

## What is reproducible

```
pnpm install && pnpm -r build && pnpm -r test     # 170 passing, 2 key-gated skipped
node packages/cli/dist/cli.js roundtrip <file.ts>  # Phase 0
node packages/cli/dist/cli.js t03 ./examples/medium # Phase 1 acceptance (programmatic)
# Live agent + benchmark (needs ANTHROPIC_API_KEY; writes gitignored results/):
pnpm --filter @strata/bench bench -- --trials=0      # dry-run, cost projection
pnpm --filter @strata/bench bench -- --trials=3 --tasks=T03
```

The two key-gated agent tests are reproduced key-free in CI via a committed real transcript fixture. Raw benchmark artifacts are gitignored by design (reproducible, cost-bearing, operator-run); the durable findings live in [`decisions.md`](../decisions.md).

## Remaining Phase-5 deliverable

A 5–10 minute demo video (per `strata-design.md` § Phase 5) is the one artifact this write-up cannot produce; it is left for a human.

## Bottom line

Strata demonstrates, under adversarial scrutiny, that removing the file abstraction makes an agent measurably more efficient at an atomic structural edit — fewer tokens, less time, fewer steps, no quality loss. It also demonstrates, with equal rigor, that this advantage does not yet generalize to multi-step refactors, that the cheap (prompt) fix does not work, and exactly which deeper lever remains. A proven win, a precisely-bounded scope, a diagnosed boundary, and a falsified easy answer — that is the result.
