# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Source of truth

This is a **greenfield research project**. Two documents govern all work and must both be read at the start of any non-trivial session:

1. `strata-design.md` — the architectural spec. Defines what Strata is, the layered architecture, the node graph model, the operation log, the tool surface for the agent, the tech stack, the build phases, and the benchmark plan. Treat it as the contract.
2. `decisions.md` — a running log of decisions made during the build. **Append to it whenever reality forces a divergence from `strata-design.md`** — a tool that didn't behave as expected, a schema change, a swapped dependency, a scope cut. Each entry should record what changed, why, and what was tried first. The design doc is not silently edited to match; the decision is logged and, only if it's a durable change, the design doc is updated and the decision entry links to the diff.

When the two disagree, `decisions.md` (newer entry wins) reflects the current state.

## Project shape

Strata is an agent-native structural substrate for TypeScript code: a SQLite-backed node graph with an operation log, fronted by structural query/mutation tools, driven by an agent built on `@anthropic-ai/claude-agent-sdk`. The agent never sees files — files exist only as transient artifacts produced by the render pipeline for `tsc` and tests.

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

Resist scope creep into multi-language, human-compat, FUSE, git integration, or multi-client concurrency. They're explicitly out of scope; if a need for them surfaces, log a decision rather than implementing.

## Tooling commands

Phase 0 uses a pnpm workspace with package-local TypeScript builds and Vitest tests.

- Install dependencies: `pnpm install`
- Build all packages: `pnpm -r build`
- Test all packages: `pnpm -r test`
- Test one package: `pnpm --filter @strata/<package> test`
- Run the Phase 0 round-trip CLI: `node packages/cli/dist/cli.js roundtrip examples/phase0-sample.ts`
- Run via the package script after building: `pnpm --filter @strata/cli roundtrip -- ../../examples/phase0-sample.ts`

The benchmark harness is not implemented in Phase 0.

## Working style for this repo

- Keep changes scoped to one package per change when possible — the packages are designed to be independently testable.
- Use a real example TypeScript codebase from `examples/` for end-to-end testing, not toy snippets. Toy examples hide the problems this project is supposed to expose.
- Tool descriptions are part of the agent's worldview. Write them like you're explaining the operation to another developer; this text ends up cached in the agent's system context and shapes behavior.
- When in doubt about tool granularity, prefer high-level operations that map to English intent ("rename this," "extract this function") over AST-manipulation primitives.
