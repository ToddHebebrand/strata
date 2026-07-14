# Strata

**A structural code substrate for AI agents**

## What Strata is

Strata is a persistent, queryable, agent-native representation of code. It replaces the file-based abstraction that AI coding agents currently work against with a structured graph that agents can read, mutate, and query at the level of language semantics rather than text.

The hypothesis: AI coding agents are bottlenecked by the file abstraction. They consume excess context loading entire files when they need single functions. They generate fragile text diffs when they want to express structural changes. They lose state when files are reformatted or moved. They can't safely operate in parallel on the same code because their unit of work (the file) is too coarse.

Strata removes that bottleneck. Agents operate on nodes (functions, classes, statements, expressions) addressed by stable IDs. Edits are structural operations, not text patches. The store is a database that happens to contain code, not a directory that happens to be queryable.

## Why this matters

Tokens are energy. The current agent loop burns tokens on:
- Reading files larger than the relevant scope
- Generating diffs that may fail to apply
- Retrying failed edits with more context
- Re-parsing what a structured store already knows

A structural substrate makes agents fundamentally more efficient. Same model, same task, less work to get to the right answer.

The bet is also that the file abstraction was an artifact of human limitations. Humans need linear text because we read sequentially. Agents don't have that constraint. They can ingest a graph as easily as a stream. Files force agents into a human-shaped interface that doesn't match how they reason.

## Scope of the MVP and Phase 6 proof

Phases 0–5 prove the single-agent architecture end-to-end with no compromises for human compatibility. Phase 6 adds the bounded multi-agent coordination proof. Specifically:

**In scope**
- TypeScript only
- A persistent store of AST nodes with stable IDs
- A structural operation API (queries and mutations)
- An agent built on the Claude Agent SDK that operates ONLY through structural operations
- On-demand rendering of stored nodes to TypeScript files for compilation and verification
- Type checking via tsc against rendered output, with errors mapped back to nodes
- A benchmark harness comparing the Strata-native agent against Claude Code on the same tasks
- A post-MVP coordination proof in which multiple agents share one canonical structural codebase through an active Strata service

**Out of scope**
- File-based editing by humans
- Bidirectional sync between files and the store
- FUSE or filesystem integration
- Unmodified file-tool agents (Claude Code, Codex, etc.) operating directly on the store
- Multi-language support
- Multi-host distributed coordination and consensus
- A UI of any kind
- Git compatibility
- Production-grade deployment

Phases 0–5 are the completed single-agent MVP. Phase 6 tests the motivating multi-agent claim directly; see the 2026-07-13 decision and approved coordination-kernel spec.

## Architecture

### Layers

```
┌─────────────────────────────────────────────┐
│  Agent clients (Claude Agent SDK + tools)   │
├─────────────────────────────────────────────┤
│  Tool layer (structural operations)         │
├─────────────────────────────────────────────┤
│  Coordination kernel (intent/ticket/event)  │
├─────────────────────────────────────────────┤
│  Memory graph + operation log (Rust/redb)   │
├─────────────────────────────────────────────┤
│  Ingest (tree-sitter or swc parsing)        │
│  Render (AST → TypeScript text)             │
│  Verify (tsc on rendered output)            │
└─────────────────────────────────────────────┘
```

### The node graph

Every meaningful unit of code becomes a node:
- Module nodes (one per source file at ingest time, after which files are irrelevant)
- Declaration nodes (functions, classes, interfaces, types, variables, exports)
- Statement nodes (if, for, while, return, expression statement, etc.)
- Expression nodes (call, binary op, identifier, literal, etc.)

Each node has:
- A stable, persistent ID
- A type discriminator
- A typed payload appropriate to the node type
- Parent and child references
- Cross-references (callsite to definition, identifier to declaration)
- Metadata (created/modified timestamps, last operation, attribution)

Granularity decision: nodes are statement-level by default, with expression-level addressing available when needed. A function body is a tree of statements, each addressable; expressions inside statements are addressable but coarser-grained operations work at the statement level.

### The operation log

Every mutation is recorded as a structured operation with:
- Operation type (e.g., `RenameSymbol`, `AddParameter`, `ReplaceBody`, `CreateFunction`)
- Affected node IDs
- Parameters of the operation
- Timestamp
- Actor identity (which agent, which session)
- Optional reasoning ("why" field for agent transparency)
- Transaction ID grouping related operations

The log is the canonical history. There is no git, no commits in the traditional sense. The log is queryable.

### Rendering

Stored nodes can be rendered back to TypeScript text on demand. Rendering is:
- Canonical (uses prettier or equivalent, one consistent style)
- Lossless for semantic content (no information lost)
- Lossy for original formatting (which doesn't exist; everything is canonical)
- Used only for compilation/verification, not as a primary representation

A render produces a directory of `.ts` files that can be fed to `tsc`. A source map maintained during rendering allows compiler errors at `file:line:col` to be mapped back to the originating node.

### Verification

The agent validates work by:
1. Triggering a render of relevant modules
2. Running `tsc --noEmit` on the rendered output
3. Receiving structured errors back, mapped to nodes
4. Optionally running tests against the rendered output

This is the only place files exist in the agent's experience, and even here they're transient build artifacts the agent doesn't see directly.

## The Agent

Built on the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). The agent has no file tools. It has only Strata tools. Its entire world is the node graph.

### Tool set

Initial tool set (subject to iteration):

**Query tools**
- `find_nodes(predicate)` — find nodes matching criteria (type, name, parent, etc.)
- `read_node(id, depth)` — read a node and optionally its descendants
- `get_callsites(function_id)` — find all callsites of a function
- `get_references(symbol_id)` — find all references to a symbol
- `get_type_info(node_id)` — get the inferred type of an expression or declaration
- `list_module_exports(module_id)` — list exported declarations from a module
- `trace_path(from_id, to_id)` — find call path between two nodes if one exists

**Mutation tools (transactional)**
- `begin_transaction()` — start a transaction; returns tx_handle
- `commit_transaction(tx)` — commit if validation passes
- `rollback_transaction(tx)` — discard the transaction

**Structural operations (require open transaction)**
- `rename_symbol(node_id, new_name)` — rename a declaration and all references
- `add_parameter(function_id, name, type, position, default)` — add param and update callsites
- `remove_parameter(function_id, param_name)` — remove param and clean callsites
- `replace_body(function_id, new_body)` — replace a function body with new structured content
- `create_function(parent_module_id, name, params, return_type, body)` — create a new function
- `delete_node(node_id)` — delete a node (errors if it has incoming references)
- `extract_function(scope_node_id, name, params)` — extract code into a new function
- `inline_function(function_id)` — inline a function at all callsites
- `add_import(module_id, source, names)` — add an import to a module
- `move_declaration(node_id, target_module_id)` — move a declaration between modules

**Verification tools**
- `validate(tx)` — type-check the current transaction state, return errors
- `run_tests(test_pattern)` — render and run tests, return results

### Tool granularity philosophy

Mix of high-level operations (like `rename_symbol`, `extract_function`) and low-level operations (like `replace_body`). High-level operations are cheaper for the agent because they encode common intent in one call. Low-level operations exist for cases not covered by the high-level set.

When in doubt, prefer high-level. Tools should map to things developers say in English ("rename this," "add a parameter," "extract this into a function"), not to AST manipulation primitives.

### System prompt

The agent's system prompt explains:
- The structural worldview (code is a graph, not files)
- How to explore before acting (queries are cheap, mutations are commitments)
- The transaction model (group related changes, validate before committing)
- The verification approach (compile after meaningful changes, before final commit)
- Common patterns with worked examples

Length target: 2000-4000 tokens. This is an investment in the agent's competence and should be prompt-cached.

## Tech stack

- **Language**: TypeScript for language semantics, tools, agent integration, render, and verify; Rust for the post-MVP memory-native coordination kernel.
- **Parser**: `tree-sitter-typescript` via `web-tree-sitter`, or `@swc/core` for parsing. Start with tree-sitter for round-trip preservation; switch to swc if performance demands.
- **Renderer**: `prettier` invoked programmatically. Canonical formatting, no preferences exposed.
- **Storage**: SQLite via `better-sqlite3` is the implemented Phase 0–5 store. Phase 6 targets an in-memory Rust graph with redb durability for operations/deltas, snapshots, intents, tickets, events, and fencing.
- **Type checking**: TypeScript Compiler API (`typescript` package) for in-process type checks. Faster than subprocess `tsc` and gives structured diagnostics.
- **Agent**: `@anthropic-ai/claude-agent-sdk` with custom tools defined in TypeScript.
- **Tests**: `vitest` for the store and tool implementations.

Rationale: TypeScript remains the correct home for TypeScript compiler integration and the already-working structural operations. Rust becomes justified at the coordination boundary, where immutable graph generations, semantic reservations, queues, fencing, and a short durable publication path are the product. The existing SQLite runtime remains supported until the Phase 6 proof passes.

## Project layout

```
strata/
├── packages/
│   ├── store/              # Core node graph + storage
│   │   ├── src/
│   │   │   ├── schema.ts   # SQLite schema and migrations
│   │   │   ├── nodes.ts    # Node types and helpers
│   │   │   ├── ops.ts      # Operation definitions and application
│   │   │   ├── query.ts    # Query implementations
│   │   │   └── log.ts      # Operation log
│   │   └── tests/
│   ├── ingest/             # Parse TypeScript into nodes
│   │   ├── src/
│   │   │   ├── parser.ts   # tree-sitter or swc wrapper
│   │   │   ├── lower.ts    # AST → node graph
│   │   │   └── resolve.ts  # Reference resolution
│   │   └── tests/
│   ├── render/             # Node graph → TypeScript text
│   │   ├── src/
│   │   │   ├── render.ts   # Main render entry point
│   │   │   ├── format.ts   # Prettier integration
│   │   │   └── sourcemap.ts # Node ↔ render location mapping
│   │   └── tests/
│   ├── verify/             # Type checking and test running
│   │   ├── src/
│   │   │   ├── typecheck.ts # TypeScript compiler API integration
│   │   │   └── runtests.ts  # Test execution
│   │   └── tests/
│   ├── agent/              # Claude Agent SDK wrapper
│   │   ├── src/
│   │   │   ├── tools/       # Tool implementations
│   │   │   ├── prompt.ts    # System prompt
│   │   │   └── session.ts   # Session orchestration
│   │   └── tests/
│   └── bench/              # Benchmark harness
│       ├── src/
│       │   ├── runner.ts    # Task execution
│       │   ├── tasks/       # Task definitions
│       │   └── metrics.ts   # Measurement
│       └── results/
├── examples/               # Example TypeScript codebases for testing
├── docs/
└── package.json
```

Monorepo via npm workspaces or pnpm. Keep packages decoupled so they can be tested independently.

## Build phases

### Phase 0: Round-trip proof (3-5 days)

Goal: prove a TypeScript file can be parsed into nodes, stored in SQLite, and rendered back to compilable TypeScript.

Deliverable: CLI that takes `input.ts`, ingests it, renders `output.ts`, and verifies `tsc --noEmit output.ts` passes for unchanged content.

If this works smoothly, the rest is engineering. If it's painful, find out before committing more time.

### Phase 1: Core store and operations (1-2 weeks)

Goal: implement the store API with a useful subset of operations.

Deliverables:
- Node graph schema in SQLite
- 5-7 query tools working
- 5-7 mutation tools working
- Transaction support with rollback
- Operation log
- Tests for each operation covering normal cases and edge cases

Don't try to implement every tool. Get the common ones working well, then expand.

### Phase 2: Verification (3-5 days)

Goal: integrate TypeScript compiler API for type-checking against rendered output.

Deliverables:
- `validate(tx)` returns structured type errors mapped to nodes
- Errors include node ID, error category, message, related nodes
- Source map from rendered output back to nodes is accurate

### Phase 3: Agent (1-2 weeks)

Goal: build the agent using the Claude Agent SDK.

Deliverables:
- Tool definitions registered with the SDK
- System prompt drafted and iterated
- Agent can complete simple tasks end-to-end (e.g., "add a parameter to function X and update all callers")
- Session logging for observability

### Phase 4: Benchmarks (1-2 weeks)

Goal: prove the substrate is better than file-based editing.

Deliverables:
- Benchmark harness with multiple tasks
- Same tasks runnable against Claude Code (baseline) and Strata agent (substrate)
- Metrics captured: tokens used, time, success/failure, retries
- Results documented

Pick 5-10 tasks of varying complexity. Run each 3-5 times per configuration for statistical signal.

### Phase 5: Write-up (3-5 days)

Goal: communicate what was built and what it proved.

Deliverables:
- Architecture doc (refined version of this)
- Results post (benchmarks, observations, limitations)
- Demo video (5-10 min walkthrough)
- Open source release with README

### Phase 6: Multi-agent coordination proof

Goal: test the original thesis — multiple agents share one canonical structural codebase without Git branches, worktrees, or manual text merges.

Deliverables:
- Rust memory-native coordination kernel with redb durability
- Typed intents with graph-inferred read/write/validation/reservation scopes
- Durable ticket/event protocol, service epochs, fencing, crash recovery, and fair all-or-ticket scheduling
- `rename_symbol` and `add_parameter` working through the kernel while Node ingest/render/verify remain authoritative
- Key-free deterministic multi-client and failure-injection acceptance on `examples/medium`
- After correctness passes, a two-agent comparison against Git worktrees plus an integration agent

The approved design is `docs/superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md`. Do not port the full tool surface or build distributed consensus before this proof answers the product question.

## Benchmark design

The benchmark is the central proof. Design carefully.

### Tasks

Each task should be:
- Realistic (drawn from actual coding work)
- Measurable (clear success criterion, ideally test-based)
- Reproducible (same starting state, same prompt)
- Diverse (mix of refactors, additions, bug fixes, cross-cutting changes)

Suggested initial task set:
1. **Add a parameter** to a frequently-called function and update all callsites correctly.
2. **Extract a function** from a long function body, with proper parameter inference.
3. **Rename a symbol** that appears in many files including type positions and string template references.
4. **Add a feature** that requires creating a new function and integrating it with existing code.
5. **Fix a bug** where a test is failing due to a logic error in a specific function.
6. **Refactor a class** from inheritance to composition.
7. **Add error handling** to a function and update callers to handle the new error case.
8. **Change a return type** of a function and update everything that uses it.
9. **Add a type guard** and apply it at multiple call sites.
10. **Inline a single-use function** and verify no behavior change.

### Configurations

For each task, run in two configurations:
- **Baseline**: Claude Code on a normal git repo, no Strata involvement.
- **Substrate**: Strata agent against the same code ingested into the store.

Both use the same underlying model (e.g., Claude Sonnet 4.6). Same task description. Same success criterion. Only the substrate differs.

### Metrics

For each run, capture:
- **Total tokens consumed** (input + output)
- **Wall clock time**
- **Number of tool/edit invocations**
- **Number of failures and retries** (failed patches, broken builds, etc.)
- **Final success** (does the test suite pass?)
- **Quality of result** (does the code look reasonable on review?)

Report distributions, not just averages. Outlier behavior is informative.

### Cost budget

Roughly $200-500 per benchmark round at Sonnet 4.6 prices. Plan for several rounds across iteration. Prompt caching reduces this significantly for the system prompt.

## Open design questions

These should be resolved during the build, not before:

1. **Node identity stability across edits**: when an expression is mutated, is it a "new node" or "the same node"? Probably "same node, mutated state" for stability, but this affects how operations are modeled.

2. **Comment handling**: comments are content but not semantic. Attach to nearest node? Inline as "comment nodes"? Strip and store separately?

3. **Optimal tool granularity**: too many fine-grained tools means more agent reasoning per task; too few coarse tools means less flexibility. Iterate based on agent behavior.

4. **Cross-module references**: how to efficiently maintain "X is referenced by Y" indexes as edits happen. Eager update vs. lazy compute.

5. **Type-level operations**: many TypeScript features are type-level (generics, conditional types, mapped types). How structural are operations on these? Probably treat as opaque text initially, structure later.

6. **Error recovery**: what does the agent do when validation fails repeatedly? Backtrack? Ask for help? Try a different approach? This is more prompt engineering than substrate design.

## What success looks like

After 6-8 weeks of focused work, success means:

1. Strata exists and works end-to-end. An agent can take a TypeScript codebase, ingest it, perform a non-trivial coding task using only structural operations, and produce correct results.

2. The benchmark shows measurable improvement. Not necessarily on every task, but on enough that the architectural argument lands.

3. The write-up explains the architecture and results clearly enough that someone reading it can understand why this matters and what's possible.

4. Reputation accrues from being the first to articulate and demonstrate this architecture. Whether anyone builds on it is a separate question.

5. The post-MVP coordination proof either demonstrates that multiple agents can safely reach one shared green codebase without worktrees/manual text merges, or records a precise falsification of that claim.

If the benchmark shows no improvement, that's also a result. It means either the substrate doesn't help as much as expected, or the implementation isn't capturing the benefit. Both are useful to know.

## Naming

"Strata" — layers of substrate beneath the surface. Code has always been layered (text, AST, bytecode, machine code); Strata is the layer where structure and intent live, made first-class. Short, memorable, available as a name, doesn't pigeonhole.

Alternative names considered:
- **Boon**: short, friendly, evokes "boon to agents"
- **Lattice**: structural, but overused
- **Substrate**: too generic
- **Codex**: taken
- **Sapling**: too cute
- **Aleph**: too pretentious
- **Origin**: too generic

Strata it is.

## Getting started checklist

When you're ready to start (with Claude Code or solo):

1. [ ] Create the monorepo skeleton (`pnpm init`, workspaces config)
2. [ ] Set up `packages/store` with the SQLite schema
3. [ ] Implement `packages/ingest` with a tree-sitter or swc parser
4. [ ] Implement `packages/render` with prettier integration
5. [ ] Verify Phase 0: ingest a TypeScript file, render it back, confirm tsc passes
6. [ ] Implement the core query tools in `packages/store`
7. [ ] Implement transactions and the first 3-5 mutation operations
8. [ ] Implement `packages/verify` with the TypeScript compiler API
9. [ ] Set up `packages/agent` with the Claude Agent SDK
10. [ ] Define the initial tool set and system prompt
11. [ ] Get the agent to complete a simple task end-to-end
12. [ ] Build the benchmark harness
13. [ ] Run initial benchmarks, iterate
14. [ ] Write up and publish

## Notes for working with Claude Code

When using Claude Code to build Strata, the following will help:

- Start each session by reading this design doc and the relevant package's README
- Keep changes scoped to one package at a time when possible
- The store schema is the foundation; get it right before building tools on top
- Test each operation in isolation before integrating into the agent
- Use a real example codebase (something from your existing work, sized 1k-5k LOC) for end-to-end testing, not toy examples
- When designing tools, write the tool description as if explaining it to another developer; that description will become part of the agent's worldview
- Resist scope creep aggressively; the human-compatibility and multi-language stuff is later

---

This is a working document. Update it as decisions are made and discoveries change the design.
