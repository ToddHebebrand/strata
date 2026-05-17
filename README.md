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

**Honest scope:** this win is robust and model-independent for *atomic single-operation* edits (rename). A task-scoped behavioral commit gate (built, found invalid as first built, fixed, and keyed-validated) extends clean substrate success to two further tasks — a gate-driven correctness win and one after a scorer artifact was independently audited and corrected; generalization is partial and gate-enabled, not free. One multi-step task (`add_parameter`) remains a **precisely-bounded negative**: its failure was not closed by four independent, pre-registered, transcript-classified, falsified levers — prompt tuning, the commit gate, model capability (at the strongest available model), and tool-result legibility (an audit-proof manifest the agent received and ignored). It is a deeper agent-behavioral failure, not a communication problem. The complete, honest story is in **[`docs/RESULTS.md`](docs/RESULTS.md)**; the full decision trail in **[`decisions.md`](decisions.md)**.

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

Research artifact — **research concluded (2026-05-17)**. TypeScript only. Phases 0–1.5 complete. The thesis is proven for atomic structural edits (robust at N=3, model-independent), partially and gate-enabled for two further tasks, and the one remaining multi-step task is an exhaustively-bounded negative (four independent, pre-registered, transcript-classified, falsified levers — prompt, commit gate, model capability, tool-result legibility). The behavioral commit gate was built, found invalid as first built (BG-4), fixed (task-scoped), and keyed-validated (GS-1..GS-4 pass). Not production-grade; not multi-language; not multi-client. The full, honest story is in `docs/RESULTS.md`; every keyed round was pre-registered tamper-evidently and classified from transcripts in `decisions.md`. The only remaining Phase-5 deliverable is a human-made demo video.

## License

(Choose before public release.)
