# Strata

**A structural code substrate for AI agents.** Strata replaces the file abstraction with a persistent, queryable node graph. An AI agent addresses functions, declarations, and identifiers by stable ID; mutates them through structural operations inside transactions; verifies against a real type-checker; and never sees a filesystem.

The hypothesis: AI coding agents are bottlenecked by files. Same model, same task — a structural substrate should get to the right answer with materially less work.

## Headline result

On a reference-aware **rename** across a real multi-module TypeScript codebase — same model (`claude-sonnet-4-6`), same prompt, same success bar, one shared scoring core — a Strata agent (no filesystem tools) vs. a file-editing baseline agent:

| | Substrate | Baseline |
|---|---|---|
| Total tokens (N=3) | 1201–1473 | 4450–4682 |
| Wall time | 24.6–30.3 s | 57.4–59.4 s |
| Tool/edit calls | 7–11 | 25–27 |

Disjoint distributions, ~3.5× fewer tokens, ~2.2× faster, both 3/3 success with identical output quality. Observed separation at N=3 (not a significance claim), and it is robust — it survived a fully adversarially-validated harness and a prompt change.

**Honest scope:** this win is demonstrated for *atomic single-operation* edits (rename). It does **not** yet generalize to multi-step refactors (`add_parameter`/`change_return_type`/a bugfix): the tools pass the unit suite but the agent cannot yet effectively wield them, and prompt engineering was *proven insufficient* to bridge the gap. The one deeper lever that diagnosis named — gating commit on the real test suite, not just type-checking — **has since been implemented** (key-free green, 176 passing; the agent gate and benchmark scorer are now one shared function); whether it moves the boundary is a pending operator-run keyed measurement, not yet a claim. The full, honest story — the diagnosed boundary, the built lever, and what remains unmeasured — is in **[`docs/RESULTS.md`](docs/RESULTS.md)**.

## Architecture

```
agent  (@strata/agent)   headless Claude Agent SDK, structural tools only, no fs
  └─ tools               query · transaction · structural mutation · validate
store  (@strata/store)   SQLite node graph + edges + operation log + transactions
ingest (@strata/ingest)  TypeScript → nodes (TS Compiler API)
render (@strata/render)  nodes → canonical TypeScript (+ source map)
verify (@strata/verify)  in-process tsc over rendered output; commit gate
bench  (@strata/bench)   substrate vs. file-baseline harness, distributions
```

Files are not first-class: they exist only as transient render artifacts for `tsc`. The operation log is canonical history (no git-style commits inside the store). See [`strata-design.md`](strata-design.md) for the full design and [`decisions.md`](decisions.md) for the authoritative, append-only record of every build-time decision and divergence.

## Quick start

```bash
pnpm install
pnpm -r build
pnpm -r test                                         # 170 passing, 2 key-gated skipped

node packages/cli/dist/cli.js roundtrip <file.ts>     # parse → store → render, byte-identical
node packages/cli/dist/cli.js t03 ./examples/medium   # the rename acceptance, programmatic
```

Live agent + benchmark (needs `ANTHROPIC_API_KEY`; results are gitignored):

```bash
pnpm --filter @strata/bench bench -- --trials=0           # dry-run + cost projection
pnpm --filter @strata/bench bench -- --trials=3 --tasks=T03
```

## Status

Research artifact. TypeScript only. Phases 0–1.5 complete. The thesis is demonstrated for atomic structural edits and bounded honestly for multi-step ones. Not production-grade; not multi-language; not multi-client. The next research lever (gate agent commits on behavioral test-acceptance, not just type-checking) has been **implemented and is green key-free** as of 2026-05-16; its keyed benchmark validation — T01/T05/T08 with T03 as the regression guard — is the pending operator step, with the outcome to be logged in `decisions.md` whatever it is. Details in `docs/RESULTS.md`.

## License

(Choose before public release.)
