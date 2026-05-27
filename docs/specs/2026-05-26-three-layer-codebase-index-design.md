# Three-layer codebase index — design

**Status:** plan-of-record (operator-approved 2026-05-26). Implementation plan in the companion doc.

## Problem this solves

Evidence from three kept T05 substrate session logs (2026-05-16):

| Trial | Turns | Tokens | Query calls | Mutation calls |
|-------|-------|--------|-------------|----------------|
| 1 | 23 | 7,612 | 15 | 1 |
| 2 | 31 | 4,207 | 23 | 1 |
| 3 | 13 | 7,786 | 6 | 1 |

The actual mutation is one tool call per trial. Everything else is **discovery overhead**: the agent fishes for relevant symbols via `find_declarations` with guessed names because (a) it has no upfront view of the codebase shape, (b) it can't read the failing test directly (tests live on disk, not in the graph), and (c) it has no semantic search — name-fishing is the only path it has.

Iteration-3 already shipped two of three pieces of the analysis:
- `read_test_file` — direct test-file access, removes the gate-as-oracle workaround.
- `list_module_exports` / `find_declarations_in_module` — module-scoped discovery primitives, cut speculative codebase-wide finding.

This document specifies the third piece — the codebase index — but lifts it beyond "static dump of declarations." The index is the place where Strata can do something a generic file-based agent cannot: leverage the structural graph and the persistent operation log as accumulated agent-task data.

## Three layers

Each layer is independently demoable. Build in order; later layers depend on earlier infrastructure but each ships value on its own.

### Layer 1 — Static module index (always-on)

What: at the start of every `runAgent` invocation, compute a one-time summary from the store. For every Module, list its top-level declarations with name, kind, and export status. Inject as a synthetic first message the agent sees on turn 1.

Format (compact, parseable by the model):
```
Codebase shape (auto-generated at session start):
src/lib/dateRange.ts: function isWithinRange [exported]
src/lib/format.ts:    function formatTimestamp [exported]
src/types/user.ts:    interface User [exported], type UserRole [exported]
...
tests/ (not in graph, use read_test_file):
  tests/dateRange.test.ts
  tests/format.test.ts
```

Cost: ~10-50 tokens per module. defu (3 modules) ≈ 150 tokens; examples/medium (22 modules) ≈ 1,000 tokens. Lands in the prompt cache after turn 1 so all subsequent turns amortize.

Limits: token cost grows linearly with module count. Useful up to ~100 modules; breaks down at scale.

Wins:
- T05-class name-fishing collapses (`find_declarations({name: 'isWithinRange'})` is no longer needed — the agent already sees it in the index).
- T05's secondary failure mode (gate-as-oracle commits) also collapses once read_test_file plus the index show the agent both the test and the relevant src symbol.

### Layer 2 — Vector-augmented retrieval (scales)

What: at ingest, embed each declaration **with structural context attached** (signature + module path + ref counts + body excerpt), not naked text chunks. Store vectors in the same SQLite file via `sqlite-vec`. A new tool `semantic_search(query, k?)` returns top-K declarations with their structural metadata.

Specialization angles (what makes this Strata's vector DB and not a generic one):
1. **Embed declarations with graph context.** Vector retrieval returns a graph anchor, not a text chunk. The agent can then traverse via existing tools (`get_references`, `find_declarations_in_module`) from the anchor.
2. **Embed test files in the same space.** Test-file embedding lives alongside declaration embedding. A failing test embeds to find probable target symbols — direct fix for T05's name-fishing in larger codebases where the static index is too big to inject in full.
3. **Hybrid retrieval.** Vector finds the anchor; the existing structural tools expand it. Pure vector retrieval would return text chunks; Strata's combines semantic similarity with structural neighborhood.

Replaces (at scale) the always-inject pattern of Layer 1: when the codebase is too large to dump, the agent's session-start context becomes "summary stats" plus an instruction to call `semantic_search` for specific concepts.

Cost: per-query embedding (~$0.001/query at OpenAI text-embedding-3-small or voyage-3 prices). Storage: ~1.5 KB per declaration vector. Ingest-time embedding is the one-time cost.

Limits: requires an embedding-API dependency. Adds a code path that needs cache management when declarations mutate.

### Layer 3 — Operation-log as memory (the "learning" piece)

What: every committed transaction has a prompt-that-triggered-it (we'll capture this; today only the actor + reasoning are stored), the operation kind(s), affected nodes, and timestamp. Embed each commit as a **task pattern**:

```
[CommitPattern <commit-id>]
  prompt: "Rename the exported type Merger to MergerFn..."
  ops: [RenameSymbol]
  modules: [src/types.ts, src/defu.ts]
  affected_declarations: [Merger]
```

At session start, embed the user's NEW prompt and retrieve top-K **similar past patterns** with their affected nodes. The agent's context becomes "tasks like this one previously touched these modules and used these tools." Recursive: as the substrate is used, it accumulates the index that makes the next session cheaper.

This is the layer no generic vector-on-code system can replicate:
- Cursor/Continue can't see structured operation history across users or within a project.
- The operation log captures *what the agent intended* (via the reasoning field) not just *what changed in git*.
- The data is naturally privacy-scoped to one corpus's store file.

Cost: per-commit embedding (one-time at commit), per-session retrieval (one query). Storage: ~2 KB per commit.

Limits: cold-start problem. With zero prior commits, this layer is empty. Value compounds with use.

## Why all three, not just one

- **Layer 1 alone** works for small codebases but breaks at scale and adds nothing semantic.
- **Layer 2 alone** is what generic agentic IDEs already do; nothing Strata-specific. Also loses the cheap always-on context Layer 1 provides for small codebases.
- **Layer 3 alone** has nothing to retrieve against without a baseline index of the codebase shape.

Together: Layer 1 gives the agent a cheap structural baseline. Layer 2 gives it semantic discovery and scales. Layer 3 makes the substrate compound — each agent session improves the next.

## Open design decisions (locked at this version)

1. **Inject point for Layer 1:** synthetic first user/assistant message. Keeps the system prompt cleanly cacheable (per-binary, not per-corpus).
2. **Scope of Layer 1's content:** all top-level declarations with name + kind + isExported. No signatures (cheapest useful form; agent can read_node for detail).
3. **Layer 3 lookback:** last 20 commits, regardless of age. Bounded; shows recency by position.
4. **Tech stack:** `sqlite-vec` for vectors (same SQLite file, no new infrastructure). Embeddings via voyage-3 or OpenAI text-embedding-3-small.

## Out of scope (deferred)

- **Agent-authored notes** (`note(text)` tool persisting per-corpus). Considered as a "v2 learning" piece. Deferred until L1+L2+L3 reveal whether notes add value beyond what op-log mining already provides.
- **Cross-corpus embedding sharing.** Each corpus's store is self-contained; embeddings stay local.
- **Re-embedding on every mutation.** v1 re-embeds at next ingest only; incremental re-embed on commit is a polish item.
