# AGENTS.md

This file provides guidance to coding agents (e.g. Codex CLI) working with code in this repository. It mirrors `CLAUDE.md` — when editing one, keep the other in sync.

## Source of truth

This is a **greenfield research project**. Two documents govern all work and must both be read at the start of any non-trivial session:

1. `strata-design.md` — the architectural spec. Defines what Strata is, the layered architecture, the node graph model, the operation log, the tool surface for the agent, the tech stack, the build phases, and the benchmark plan. Treat it as the contract.
2. `decisions.md` — a running log of decisions made during the build. **Append to it whenever reality forces a divergence from `strata-design.md`** — a tool that didn't behave as expected, a schema change, a swapped dependency, a scope cut. Each entry should record what changed, why, and what was tried first. The design doc is not silently edited to match; the decision is logged and, only if it's a durable change, the design doc is updated and the decision entry links to the diff.

When the two disagree, `decisions.md` (newer entry wins) reflects the current state.

## Project shape

Strata is an agent-native structural substrate for TypeScript code. The implemented product is a SQLite-backed node graph with an operation log, fronted by structural query/mutation tools and driven by an agent built on `@anthropic-ai/claude-agent-sdk`. The approved next research iteration adds a Rust memory-native multi-agent coordination kernel with redb durability; see `docs/superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md`. Agents never see files — files exist only as transient artifacts produced by the render pipeline for `tsc` and tests.

The big-picture layering (top to bottom):
- **Agent** (`packages/agent`) — Claude Agent SDK session with a system prompt and Strata-only tools, no filesystem tools.
- **Tools** — structural operations exposed to the agent (query, transaction, mutation, verify).
- **Store** (`packages/store`) — node graph, edges, operation log, transactions; the canonical state of the codebase.
- **Ingest** (`packages/ingest`) — TypeScript source → nodes (initially `tree-sitter-typescript`; `@swc/core` is the fallback if perf demands it).
- **Render** (`packages/render`) — nodes → canonical TypeScript text via Prettier, with a source map back to node IDs.
- **Verify** (`packages/verify`) — runs the TypeScript Compiler API against rendered output; diagnostics are mapped back to nodes via the source map.
- **Bench** (`packages/bench`) — task harness that runs the same task against Claude Code (baseline) and the Strata agent (substrate) and captures tokens, time, retries, success.

Key invariants to preserve when implementing:
- **Stable node IDs across mutations.** A mutated expression is the same node with new state, not a new node. The whole operation-log + reference-tracking story depends on this; do not introduce ID churn without logging a decision.
- **Files are not first-class.** Nothing in `store`, `agent`, or the tool layer should accept a file path as the unit of work. Module nodes exist; file paths exist only inside `render` and `verify`.
- **The operation log is canonical history.** No git-style commits. Every mutation goes through a transaction and produces operation-log entries with actor + reasoning.
- **Transactions wrap related mutations.** Mutation tools require an open transaction; `validate(tx)` runs against the transaction's view; `commit_transaction` blocks if validation fails (current intent — confirm during Phase 2).
- **Rendering is canonical and lossy on formatting.** There is no "preserve original style." If you find yourself trying to round-trip formatting, stop and log a decision.

## Build phasing

`strata-design.md` defines Phases 0–5 with concrete deliverables. **Phase 0 (round-trip proof) is the gating phase** — do not build store/operation infrastructure on top of an ingest+render that can't round-trip a real TypeScript file through `tsc --noEmit`. If round-trip is painful, that's a finding to surface and log before continuing.

Multi-client code coordination is now the approved Phase-6 research direction. Resist scope creep beyond its spec into multi-language, human-compat, FUSE, git integration, task orchestration, multi-host consensus, or production distributed deployment. If a need for them surfaces, log a decision rather than implementing.

## Tooling commands

The monorepo uses pnpm workspaces with package-local TypeScript builds and Vitest tests.

- Install dependencies: `pnpm install`
- Build all packages: `pnpm -r build`
- Test all packages: `pnpm -r test`
- Test one package: `pnpm --filter @strata/<package> test`

Phase 0 round-trip CLI:
```bash
pnpm --filter @strata/cli build
node packages/cli/dist/cli.js roundtrip examples/phase0-sample.ts
```

Phase 1 batch ingest, which populates a Strata DB from a directory tree:
```bash
node packages/cli/dist/cli.js ingest-batch <rootDir> <dbPath>
```

Phase 1 rename smoke, which validates and commits through `@strata/verify`:
```bash
node packages/cli/dist/cli.js rename <dbPath> <declarationId> <newName>
```

Phase 1 T03 acceptance, the hero rename benchmark:
```bash
node packages/cli/dist/cli.js t03 examples/medium
```

BS4 SDK schema smoke:
```bash
node packages/cli/dist/cli.js sdk-smoke
```

**Phase 3 agent (key-free deterministic replay of T03):**
```bash
pnpm --filter @strata/agent test -- replay
```

**Phase 3 agent (live T03 run — requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN):**
```bash
ANTHROPIC_API_KEY=... pnpm --filter @strata/agent test -- agentT03
```

**Phase 3 agent (regenerate replay fixture from a keyed live run):**
```bash
pnpm --filter @strata/agent build
ANTHROPIC_API_KEY=... pnpm --filter @strata/agent record:t03-fixture
```

**Phase 4 T03 benchmark (operator-only, key-gated, NOT a CI test):**
```bash
ANTHROPIC_API_KEY=... pnpm --filter @strata/bench bench:t03 -- --trials=3
```

Defaults: N=3, model `claude-sonnet-4-6`, maxTurns 25, wall-time 240s. A round is `2 * N` live model runs and writes JSON + Markdown under `packages/bench/results/`. Use `--trials=0` for a dry-run that prints projected spend and writes nothing; use `--trials=5` only as an explicit budgeted operator choice; use `--keep-artifacts` to keep baseline temp trees for post-mortem. `pnpm -r test` never runs this and needs no key.

**Phase 1.5R four-task re-validation (operator-only, key-gated, per-task budget form):**
```bash
ANTHROPIC_API_KEY=... pnpm --filter @strata/bench bench -- --trials=1 --task-budget=T01:maxTurns=40,wallMs=420000;T05:maxTurns=40,wallMs=300000
```

Omit `--task-budget` to use the artifact-derived defaults (`T01` 40t/420000ms, `T05` 40t/300000ms); `T03` and `T08` stay at the global 25t/240000ms unless explicitly overridden.

The agent has no filesystem/bash tools (`tools: []`); its only callable
tools are the twenty `mcp__strata__*` structural tools. Replay mode currently
uses a clearly labeled synthetic placeholder fixture until the operator
replaces it with a successful keyed live recording.

The benchmark harness lives in `packages/bench` as a leaf package. It compares
the existing Strata substrate (`runAgentT03`, reused as-is) against a
file-tools Claude Code baseline on a temp copy of `examples/medium`, scores
both through the shared `@strata/verify` T03 text criteria, and reports
distributions rather than bare means.

## Current orientation: product, not measurement

As of 2026-05-26 this project has shifted from "characterize the substrate with more bench rounds" to "iteratively develop the product the design doc set out to build." The bench is now context, not the goal.

**What is stable and shippable:**
- The substrate runs end-to-end: ingest → store → mutate via tools → validate → commit gate with tsc+vitest → render. All twenty `mcp__strata__*` tools work; the agent runs on `claude-sonnet-4-6` with `tools: []`.
- T03 (rename) is a clear substrate win on the bench. The other tasks are mixed or losses — that's documented and accepted, not something to chase by re-running the bench.

**What "product iteration" means here, in priority order:**
1. **Make the substrate usable by someone other than us.** README, quickstart, demo, a `strata` CLI surface that maps to the agent's worldview, not just bench harnesses. The design-doc MVP success criterion is "Strata exists and works end-to-end" + "the architectural argument lands" + a write-up + an open-source release — not "every bench task wins."
2. **Broaden the tool surface where it cheaply extends the rename-class win.** Done as of iteration 2: `extract_function`, `inline_function`, `move_declaration`, `add_import`, `list_module_exports` have all landed (20 tools total). Keyed dogfoods established the taxonomy: bulk propagation over many existing references (rename/move/param — T03-class) is the cost win; single-site synthesis (extract, new code) is not and is not expected to be (decisions.md 2026-05-29). Don't pitch non-bulk tools as cost wins.
3. **Persistence and incremental ingest.** Persistence landed in iteration 1 (`strata agent --db <path>` keeps the store + operation log across sessions). Incremental re-ingest of only changed modules is still open — today a fresh corpus ingest is all-or-nothing.
4. **Acknowledge the gaps in product copy.** T01-class per-callsite expressiveness is a known limitation (decisions.md 2026-05-17 TERMINAL + 2026-05-26 forward-looking constraint). Ship the product saying so; don't pretend the surface is broader than it is.

**Hard rules for this orientation:**
- **Do not propose new bench rounds unless they answer a specific, falsifiable product question.** "Another N=2 round to see if the number changed" is not a product question. "Does the new `extract_function` tool actually save tokens on a task that exercises it" is.
- **Do not chase N=2 noise into product claims.** If a finding swings between rounds, it's noise; ship the conservative read.
- **Default move when stuck: ship a smaller piece of the product surface, not run more measurements.** Bench rounds are a tool, not the work.
- **The roadmap lives in `docs/product-roadmap.md`.** Iteration scope, deliverables, and what "done" means for each iteration are tracked there.

## Current orientation: recover the multi-agent thesis

As of 2026-07-13, the next research iteration is the approved Rust/redb coordination kernel in `docs/superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md`. The single-agent product and bulk-propagation findings remain valid; this iteration asks the original, previously deferred question: can multiple agents reach one shared green codebase without branches, worktrees, or manual text merges?

Hard boundaries:
- Strata coordinates code activity; it does not decompose or assign tasks.
- Clients never open canonical storage directly.
- Typed operations infer reservation scope from the graph; agents do not enumerate lock keys.
- Deterministic, key-free concurrency and crash-recovery gates must pass before live model comparisons.
- The existing SQLite path remains supported until the Rust/redb proof passes.
- Structural insert/delete/move concurrency waits for stable logical IDs independent of sibling position.

## Working style for this repo

- Keep changes scoped to one package per change when possible — the packages are designed to be independently testable.
- Use a real example TypeScript codebase from `examples/` for end-to-end testing, not toy snippets. Toy examples hide the problems this project is supposed to expose.
- Tool descriptions are part of the agent's worldview. Write them like you're explaining the operation to another developer; this text ends up cached in the agent's system context and shapes behavior.
- When in doubt about tool granularity, prefer high-level operations that map to English intent ("rename this," "extract this function") over AST-manipulation primitives.
- Before committing to a different-class lever or any non-trivial design, get an independent expert review from another model (Codex CLI, `gpt-5.5` — or the strongest the account supports, e.g. `gpt-5.4` — reasoning `xhigh`, read-only, repo-grounded; see the `delegating-to-codex` skill). Hand it a self-contained brief: the diagnosis, the *falsified* levers (so it doesn't re-propose them), the candidates, and the hard constraints. **Verify any pivotal empirical claim it makes against the actual code/criteria before accepting it** — the outside review is to surface blind spots, not to be trusted on faith. This caught the decision-grade T01 finding (2026-05-17 entry: `add_parameter` per-callsite expressiveness gap) before any keyed spend.
