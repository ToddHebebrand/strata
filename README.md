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

**Honest scope:** the rename-class win is robust and model-independent. Behavioral-gate extensions and one precisely-bounded negative on a per-callsite expressiveness task (`add_parameter`) are documented in **[`docs/RESULTS.md`](docs/RESULTS.md)**; the full decision trail is in **[`decisions.md`](decisions.md)**.

## Architecture

```
agent  (@strata/agent)   headless Claude Agent SDK, structural tools only, no fs
  └─ tools (20)          query · transaction · structural mutation · validate · semantic_search
store  (@strata/store)   SQLite node graph + edges + operation log + transactions
  └─ vector index        sqlite-vec; declaration + commit-pattern embeddings (optional)
ingest (@strata/ingest)  TypeScript → nodes (TS Compiler API)
render (@strata/render)  nodes → canonical TypeScript (+ source map)
verify (@strata/verify)  in-process tsc over rendered output; commit gate
bench  (@strata/bench)   substrate vs. file-baseline harness, distributions
```

Files are not first-class: they exist only as transient render artifacts for `tsc`. The operation log is canonical history (no git-style commits inside the store). See [`strata-design.md`](strata-design.md) for the full design and [`decisions.md`](decisions.md) for the append-only record of every build-time decision and divergence.

For a visual map of the current implementation, see [`docs/architecture-visual-guide.md`](docs/architecture-visual-guide.md).

## Three-layer codebase index

The agent gets a structural view of the codebase at session start. Each layer is independently demoable and gracefully disables when its prerequisites aren't met.

- **L1 — static module index (always-on).** Every `strata agent` invocation injects a compact `## Codebase shape` section at the top of the agent's first prompt: every Module's top-level declarations (kind, name, exported?), plus the on-disk `tests/` listing. ~10–50 tokens per module. Disable with `--no-index`. Design: [`docs/specs/2026-05-26-three-layer-codebase-index-design.md`](docs/specs/2026-05-26-three-layer-codebase-index-design.md).
- **L2 — vector-augmented retrieval.** `sqlite-vec` virtual tables store per-declaration embeddings; a `semantic_search(query, k?)` tool returns top-K declarations with their structural metadata. Auto-embeds at session start when `STRATA_EMBED_API_KEY` is set; silently skipped otherwise. Use when the agent doesn't know the symbol name.
- **L3 — operation log as memory.** Every committed transaction captures its triggering prompt and embeds a commit pattern (prompt + ops + modules + declarations). At session start the agent's prompt is matched against past patterns; similar past tasks are injected as `## Past tasks like this one`. Cold-start (no prior commits) is silent — no section, no log noise.

All three layers preserve the canonical invariants: stable node IDs, files-not-first-class, operation log as canonical history.

## Quick start

For a hands-on walkthrough that takes you from clone to "I see L1 working" with real commands and real output, see [`docs/quickstart.md`](docs/quickstart.md). The reference commands are below.

```bash
pnpm install
pnpm -r build
pnpm -r test                                          # 255 passing, 2 key-gated skipped
```

Round-trip a single TypeScript file through the substrate (no key, no network):

```bash
node packages/cli/dist/cli.js roundtrip examples/phase0-sample.ts
```

Run the rename acceptance (programmatic, no key):

```bash
node packages/cli/dist/cli.js t03 examples/medium
```

### Run the agent on a real corpus

Needs `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`):

```bash
ANTHROPIC_API_KEY=... node packages/cli/dist/cli.js agent examples/medium \
  "Rename the exported interface User to Account everywhere it is referenced" \
  --db /tmp/strata-medium.db --print
```

- `--db <path>` persists the operation log and node graph across sessions (re-invoke against the same path to continue).
- `--reset` deletes that DB before re-ingesting.
- `--no-index` disables L1 injection (useful for paired comparisons).
- `--print` streams assistant text + tool calls to stdout.
- `--model <id>` defaults to `claude-sonnet-4-6`.

The session JSON to stdout shows token cost, tool-call count, terminal reason, and the resulting DB path.

### Enable L2 + L3 (optional)

Set `STRATA_EMBED_API_KEY` (OpenAI) alongside the model key, then re-run `strata agent`. The first run embeds the corpus (one-time cost, ~$0.04 per 10k declarations at text-embedding-3-small); subsequent runs against the same `--db` reuse the embeddings.

Explicit re-embed against a persisted store:

```bash
STRATA_EMBED_API_KEY=... node packages/cli/dist/cli.js embed examples/medium --db /tmp/strata-medium.db
```

### Paired comparison: file-tools baseline

Same prompt, same corpus, Claude Code with read/edit/grep tools on a temp clone:

```bash
ANTHROPIC_API_KEY=... node packages/cli/dist/cli.js baseline examples/medium \
  "Rename the exported interface User to Account everywhere it is referenced" \
  --print
```

### L1 paired dogfood

A keyed micro-experiment: run the same T05-style task twice on the same corpus, once with L1 off (`--no-index`) and once with L1 on. Prints a comparison table with token deltas:

```bash
ANTHROPIC_API_KEY=... pnpm --filter @strata/bench dogfood:l1 -- examples/medium
```

Honest read: N=1. Plan acceptance is `index-on tokens ≤ 80% of index-off tokens` on this single run.

## Status

Research-grade substrate, **actively iterating toward usability** (CLAUDE.md priority since 2026-05-26). TypeScript only. The end-to-end pipeline is stable: ingest → store → 17 structural tools → in-process tsc + behavioral gate → render. T03 (rename) is a clean substrate win on the bench; other tasks are mixed or losses, documented honestly in `docs/RESULTS.md`. The three-layer codebase index (L1/L2/L3) is implemented and tested but the design-level token-saving claim is unvalidated until the operator runs the L1.4 dogfood (above).

Live roadmap: [`docs/product-roadmap.md`](docs/product-roadmap.md).

Not production-grade; not multi-language; not multi-client. Out-of-scope items (multi-language, FUSE, git integration, multi-client concurrency) are listed in `strata-design.md` § Scope and not pursued.

## License

(Choose before public release.)
