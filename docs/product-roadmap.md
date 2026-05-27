# Strata product roadmap

Living document. Update as iterations land. Source of truth for "what we're building next."

## Orientation

Strata's MVP success, per `strata-design.md` § "What success looks like":

1. End-to-end working substrate ✓
2. Benchmark shows measurable improvement on enough tasks that the architectural argument lands — T03 (rename) clearly wins; T01/T05/T08 are mixed or losses, and that's the honest current surface.
3. Write-up — not started.
4. Open source release with README — not started.

We have #1 in the bench-task sense. We don't have it in the "can we actually use this thing" sense — the agent can only run the four hardcoded bench prompts (T01/T03/T05/T08) on the bench corpora, and every session re-ingests into `:memory:` so the operation log dies with the process. **That's the next gap.** Polish for outside users (CLI surface, README, demo) is later.

## Stable signal (don't re-litigate)

- **T03 (rename across the corpus):** substrate wins materially on tokens, same quality. By design — this is the task the rename tool was built for.
- **T05 (debug a failing test):** substrate costs ~5× tokens for identical quality. The task is local; graph navigation is dead weight.
- **T08 (narrow return type):** substrate costs ~2× tokens for same quality. Mixed task; half structural, half creative caller refactor.
- **T01 (add parameter with per-callsite logic):** the per-callsite expressiveness gap is unresolved — value-channel is strings (decisions.md 2026-05-17 TERMINAL + 2026-05-26 forward-looking constraint).

## Iterations

Each iteration ships a thing. "Ships" means: it works end-to-end, the code is committed, and it has at least one real use.

### Iteration 1 — Works end-to-end on something real (current)

Goal: we can point the substrate at an arbitrary TypeScript codebase, give the agent an arbitrary task in plain English, and have it actually do it — with the operation log persisting so the next session sees the history.

- [ ] **Arbitrary prompts.** A new agent entry point that takes `{corpusRoot, prompt}` (not a hardcoded task id) and runs the substrate agent end-to-end. The existing commit gate (tsc + optional vitest) stays; there's no task-specific scoring because the user is the scorer now.
- [ ] **Persistence.** The store can open against a disk-backed SQLite path instead of `:memory:`. The agent run reads the persisted store, mutates it through the operation log, and the next session sees both. Re-ingesting an already-ingested corpus is idempotent (skip-if-unchanged at the module level; full re-parse is acceptable for v0).
- [ ] **One real dogfood.** Use the above to do one real refactor — on the Strata codebase itself, or on a real project. Record what worked, what didn't, and what the next thing to fix is.

Out of scope for iteration 1: CLI polish beyond what dogfooding needs, README aimed at outside users, render-back utility (unless dogfooding forces it), watch-mode, schema migrations.

### Iteration 2 — Broaden the rename-class win

Goal: more tasks that exercise graph-traceable bulk operations have a tool that wins on them.

Triggered when iteration 1 has surfaced what's missing from the current tool surface. Likely candidates from `strata-design.md` § Tool set: `extract_function`, `inline_function`, `move_declaration`, `add_import`, `list_module_exports`. Each new tool needs at least one task it visibly wins on (the bench is the right tool for *that* question).

### Iteration 3 — Make it usable by someone else

Goal: someone who isn't us can clone the repo, follow a README, and use Strata.

Only after iterations 1 and 2 have landed. This is the iteration where the CLI surface, README, demo, and OSS-release prep happen — not before. Premature polish on an empty product is what we're trying to avoid.

### Iteration 4 — Write-up

Goal: the architectural argument is publishable.

Architecture write-up, results post (T03 win + honest gaps + what the rename-class win implies), demo capture.

## What not to do

These are off-roadmap until something forces them on:

- **Re-running benches to see if a number moved.** The numbers we have are the numbers; new bench task only when a new tool needs scoring.
- **Trying to close T01's per-callsite gap before shipping iteration 1.** The gap is documented; ship around it.
- **Building a UI.** Out of scope per `strata-design.md` § Scope of MVP.
- **Multi-language support, git integration, FUSE, multi-client concurrency.** Out of scope.
- **Sandbox experiments (`packages/lab`) without a falsifiable product question.** The lab has served its purpose; new lab work needs an explicit product justification.
