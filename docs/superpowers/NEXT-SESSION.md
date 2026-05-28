# Next session handoff

> Continuation prompt for resuming Strata work in a fresh session (no memory of the prior
> conversation). Delete or overwrite this file once the work below is underway.

Continue the Strata project (greenfield research; `/Users/toddhebebrand/Strata`, branch `main`).
Read `CLAUDE.md`, `decisions.md` (top entries), and `docs/product-roadmap.md` first.

## Where we are

The prior session shipped a `find_declarations` bug-fix cluster + completed L2.5 dogfood prep,
then designed `extract_function` and discovered (via Codex xhigh review) that it sits on a
missing prerequisite. Two design specs are now queued behind Codex reviews, not yet in
implementation. HEAD should be around commit `af7d12f`.

## Immediate next action

Run the Codex xhigh independent review of the graph-materialization prerequisite spec,
per `CLAUDE.md`'s "get an independent expert review before any non-trivial design" rule.

- Spec to review: `docs/superpowers/specs/2026-05-28-graph-materialization-design.md`
- This is the PREREQUISITE for `extract_function`: a commit-time pass that re-derives
  Identifier children + reference edges for modules a transaction changed (dirty-module
  scoping). It fixes a verified gap: `create_function`/`add_import` insert nodes that render
  correctly (tsc passes) but are invisible to `find_declarations`/`get_references` because
  they emit no Identifier children (see `packages/store/src/createFunction.ts:91-99`).
- The review must adjudicate the OPEN node-ID-stability question (R1 vs R2 vs R3 in the
  spec's "primary risk" section). Strata derives identifier node IDs from position
  (`modulePath + statementIndex + identifierDFSIndex`), which collides with the "stable node
  IDs across mutations" invariant when a dirty module's identifier set/order changes. The
  tentative lean is R1 (materialize additive structure only; delete removed-span
  identifiers rather than re-derive surviving ones). Codex must confirm R1 is sufficient,
  check the shared-resolver dependency direction (store must not depend on ingest if it
  creates a cycle), and propose cheapest falsifier tests.
- Codex invocation (per the `delegating-to-codex` skill):
  ```
  codex exec --full-auto -m gpt-5.5 -c 'model_reasoning_effort="xhigh"' -C /Users/toddhebebrand/Strata "$(cat /tmp/brief.md)"
  ```
  Write a self-contained brief: the diagnosis, the R1/R2/R3 candidates, the invariant
  constraints, and point it at the pivotal code (`packages/ingest/src/batch.ts` resolver,
  `identifiers.ts`, `ids.ts`, `packages/store/src/{createFunction,transactions,nodes}.ts`,
  `packages/verify/src/validate.ts`).
- CRITICAL: verify every pivotal claim Codex makes against the actual code before
  accepting it. The review is to surface blind spots, not to be trusted on faith.

## Then, in order

1. Apply Codex's findings: pick R1/R2/R3, revise the graph-materialization spec.
2. `writing-plans` → `subagent-driven-development` to BUILD graph-materialization.
   (Use sonnet implementer + sonnet spec-reviewer + sonnet code-quality-reviewer subagents;
   stay as opus advisor/controller. That split worked well last session.)
3. Revise `docs/superpowers/specs/2026-05-27-extract-function-design.md` per its already-
   recorded Codex findings (see its "Codex review outcome" section): typed captured params
   need a TypeChecker (no-annotation params fail TS7006 under strict); use a shared internal
   insert helper not public `create_function` (avoids a spurious `CreateFunction` op); append at
   module end not after-parent (ID churn); offsets are UTF-16 code units; expand the
   rejection list (`arguments`, `new.target`, `eval`, `using`/`await using`, parent type-params
   in span, `newFunctionName` shadowed by any in-scope binding); Pass-1 capture binding needs
   a real lexical binder not a naive identifier walk.
4. `writing-plans` → build `extract_function` on the fixed foundation.

## Useful context

- **find_declarations fix** (prior session): commits `a2e19b3..16671a1`. Same bug class
  (JSDoc `@param` tag identifiers had lower offsets than the declaration name; the lowest-
  offset picker chose the tag word). Fixed via `resolveDeclarationNameIdentifier`
  (`packages/store/src/declarationName.ts`), now used by 6 call sites. 95 store tests green.
  `examples/medium/src/types/user.ts` now carries `/** @internal */` as a corpus guard; T03
  passes under it.
- **L2.5 prep**: corpus is `valibot/library` (clone at `~/code/valibot-l2.5`; was ingested to
  `/tmp/valibot.strata.db` — may be gone, re-ingest with
  `node packages/cli/dist/cli.js ingest-batch ~/code/valibot-l2.5/library /tmp/valibot.strata.db`).
  Probe scripts at `scripts/dogfood/`. Notes at `docs/dogfood-results/l2.5-prep-*.md`. The
  keyed L2.5 paired comparison still needs a `dogfood:l2` harness (parallels `dogfoodL1`/`L3`
  in `packages/bench/src/`) and must use `commitWithBehavioralGate`, not bare `commit()` —
  bare `commit()` over a real corpus surfaces non-src diagnostics (`decisions.md` top entry).
- **Prior Codex artifacts** were at `/tmp/codex-*-{brief,response}.*` — tmp, likely gone;
  regenerate as needed. The extract_function Codex findings are durably recorded in that
  spec's "Codex review outcome" section, so they survive.

Start by reading the two specs + the graph-materialization spec's risk section, then draft
and run the Codex review brief.
