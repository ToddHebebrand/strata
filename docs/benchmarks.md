# Strata Benchmark Suite (Phase 4)

## Preamble

This document specifies the Phase 4 benchmark suite that compares the Strata
agent against Claude Code on identical TypeScript coding tasks. The point is to
test whether a structural substrate measurably outperforms file-based editing
when the underlying model and prompt are held constant.

Two configurations are run for every task:

- **Baseline** — Claude Code on a normal git checkout of the seed codebase. No
  Strata involvement; standard file tools.
- **Substrate** — the Strata agent (packages/agent) against the same code
  ingested into the store. No file tools available to the agent.

Both run the same model and receive the same prompt verbatim. Per-run metrics
follow `strata-design.md` § "Benchmark design": total tokens (in + out), wall
time, tool/edit invocation count, failure-and-retry count, final success
(test-based), and a coarse human quality rating of the resulting code. See
that section for cost budget and run-count guidance — this document only
specifies what the tasks are and how to score them.

## Task list

| ID  | Title                          | Category       | Difficulty | Primary signal                                                                 |
|-----|--------------------------------|----------------|------------|--------------------------------------------------------------------------------|
| T01 | Add a parameter                | refactor       | easy       | Does substrate fan out cleanly to many callsites without text patching?        |
| T02 | Extract a function             | refactor       | medium     | Cost of selecting a contiguous statement range and inferring its free vars.    |
| T03 | Rename a symbol                | refactor       | medium     | Reference-aware rename vs. grep-and-replace (template literals, JSDoc, types). |
| T04 | Add a feature                  | addition       | medium     | Cross-file integration: new code that wires into existing exports + types.     |
| T05 | Fix a bug                      | bugfix         | medium     | Localised semantic edit; mostly diagnostic. Substrate may show no win here.    |
| T06 | Refactor a class               | cross-cutting  | hard       | Large structural rewrite where stable node IDs across mutations should pay off.|
| T07 | Add error handling             | cross-cutting  | medium     | Mutating a function signature + flowing changes to all callers' control flow.  |
| T08 | Change a return type           | cross-cutting  | medium     | Type-driven cascade through callers; tests catch silent breakage.              |
| T09 | Add a type guard               | addition       | medium     | Multi-site narrowing application; whether the agent finds all candidate sites. |
| T10 | Inline a single-use function   | inline         | easy       | One-shot structural op vs. read-locate-splice in text.                         |

All tasks operate on a single shared seed codebase (see Open Questions for the
alternative). The seed must be large enough that no single file fits trivially
in context (target: ~3–5k LOC across ~20–30 modules), and exposes a small
"public API" plus a "library internals" layer to give cross-module work a
target. The `examples/medium` tree is the intended host; specific module/
function names below are placeholders that the runner setup will pin to actual
identifiers in the seed.

---

## T01 — Add a parameter

**Description.** Add a new parameter to an internal helper function and update
every callsite. The function is called frequently from several modules.
Stresses fan-out correctness: did every callsite get the argument, in the
right position, with the right default semantics? File-based editing tends to
miss a callsite when the function name is generic ("format", "build").

**Starting state.** A utility module `src/lib/format.ts` exporting
`formatTimestamp(ts: number): string` (~15 LOC). It is called from 8–12
callsites spread across at least 4 other modules, including one call inside a
template literal and one call inside an array `.map(formatTimestamp)`
higher-order use.

**Prompt to agent.**
> Add a `timezone: string` parameter to `formatTimestamp` (after the existing
> `ts` parameter). It should default to `"UTC"`. Update every callsite to pass
> the appropriate timezone: callsites inside modules under `src/server/` should
> pass `"UTC"`; callsites under `src/ui/` should pass `"local"`. All other
> callsites should be left to take the default. The tests in
> `tests/format.test.ts` must pass.

**Success criterion.** `pnpm vitest run tests/format.test.ts` exits 0 and
`tsc --noEmit` over the rendered/checked-out tree has zero errors. Tests
assert the new signature, default behavior, and the per-directory wiring.

**Failure modes.**
- The `.map(formatTimestamp)` callsite silently becomes wrong-arity in TS
  strict mode (or worse, silently typechecks if the signature allows it).
- A callsite inside a string template literal (`` `${formatTimestamp(t)}` ``)
  is missed by grep because of escaping.
- Parameter inserted in wrong position when an overload-style call already
  passes options.
- Default value applied as `string | undefined` instead of `string`.

**Hypothesised Strata advantage.** `add_parameter(function_id, …)` is a single
structural op that enumerates callsites from the reference index and rewrites
them transactionally. The per-directory `"UTC"`/`"local"` rule still requires
agent decisions per callsite, so the win is in correctness/fan-out coverage,
not in collapsing the task to one tool call.

**Estimated baseline difficulty.** Easy-to-moderate. Claude Code handles this
well in repos with unique names; the template-literal and HOF callsites are
the realistic failure surface.

---

## T02 — Extract a function

**Description.** Pull a coherent block of statements out of a long function
into a new helper, with parameters inferred from the block's free variables
and a return type inferred from what the caller uses after the block. Stresses
both range selection and variable-scope analysis.

**Starting state.** A function `processOrder(order: Order): Receipt` in
`src/server/orders.ts` (~80–120 LOC, single function body). Inside it, a
contiguous ~25-line block computes line-item totals, tax, and discounts; the
results (`subtotal`, `tax`, `discountedTotal`) are used afterwards to build
the receipt. The block reads `order.items`, `order.couponCode`, and a
module-level `TAX_RATE` constant.

**Prompt to agent.**
> In `processOrder`, extract the block that computes `subtotal`, `tax`, and
> `discountedTotal` into a new exported function `computeTotals` in the same
> module. Infer the parameters and return type from usage. Replace the block
> with a call to `computeTotals` and destructure the result. The tests in
> `tests/orders.test.ts` must continue to pass.

**Success criterion.** `pnpm vitest run tests/orders.test.ts` exits 0; `tsc`
clean; `computeTotals` is exported from `src/server/orders.ts`; the original
`processOrder` no longer references `TAX_RATE` directly.

**Failure modes.**
- Free-variable miss: the extracted function references `TAX_RATE` without
  importing it (works only because they're in the same module — fragile).
- Parameter list includes variables that aren't actually read by the block.
- Return type inferred too loosely (`any` or `object`) and downstream code
  silently degrades.
- Block boundaries chosen one statement too short, leaving a dangling
  computation in the caller.

**Hypothesised Strata advantage.** `extract_function(scope_node_id, name,
params)` operates on a statement-range subgraph with known reads/writes; free
variables are computed from the resolved reference index rather than
re-inferred from text. The agent picks the range, the tool handles the
mechanical correctness.

**Estimated baseline difficulty.** Moderate. Claude Code can do this but
often misses one free variable or picks an awkward boundary, and the
typecheck round-trip surfaces the mistake only after one or two retries.

---

## T03 — Rename a symbol

**Description.** Rename an exported type that is referenced widely, including
in positions that text search handles poorly: JSDoc `@param` tags, template
literal interpolations of `name`-like properties, and a type-only re-export.
The canonical test of "does the substrate know about references?".

**Starting state.** An exported interface `User` in `src/types/user.ts`. It
is imported in ~15 modules, used in ~40 type positions, ~5 JSDoc tags, and is
re-exported (`export type { User } from "./types/user"`) from
`src/index.ts`. There is also a string literal `"User"` used as an unrelated
discriminator value in `src/server/audit.ts` — this must **not** be renamed.

**Prompt to agent.**
> Rename the exported interface `User` (defined in `src/types/user.ts`) to
> `Account` everywhere it is referenced as a type, including type-only
> re-exports and JSDoc. Leave unrelated string literals with the value
> `"User"` (such as audit log discriminators) untouched. The full test suite
> must pass.

**Success criterion.** `pnpm vitest run` exits 0; `tsc` clean; `grep -rn
"\\bUser\\b" src/` returns only the audit-log string-literal occurrence(s).

**Failure modes.**
- The audit-log string `"User"` is renamed because of literal text matching.
- The JSDoc `@param {User} …` is left as-is and silently rots.
- The re-export in `src/index.ts` is missed because it uses `export type
  { User }` (a position some grep-based renamers skip).
- A nested generic position like `Promise<User[]>` is rewritten incorrectly.

**Hypothesised Strata advantage.** `rename_symbol(node_id, new_name)`
operates on the declaration node and walks its reference edges. Unrelated
string literals are not references, so they're never candidates; this is the
clearest illustration of the substrate's worldview.

**Estimated baseline difficulty.** Moderate-to-hard. Rename through template
literals, JSDoc, and "don't touch the lookalike string" is a known weak spot
for grep+edit workflows. Claude Code typically gets this with retries after
type errors surface; the question is how many retries.

---

## T04 — Add a feature

**Description.** Implement a small end-to-end feature: a new utility
function, its export from the module barrel, integration into one consumer,
and tests passing. Stresses cross-file wiring rather than single-site edits.

**Starting state.** `src/lib/strings.ts` exports a handful of string
helpers. `src/index.ts` re-exports them. A consumer `src/server/slugify.ts`
currently lower-cases-and-hyphenates manually inline.

**Prompt to agent.**
> Add a `slugify(input: string): string` helper to `src/lib/strings.ts` that
> lower-cases the input, replaces runs of non-alphanumeric characters with a
> single `-`, and trims leading/trailing `-`. Re-export it from
> `src/index.ts`. Replace the inline slugification logic in
> `src/server/slugify.ts` with a call to the new helper. The tests in
> `tests/slugify.test.ts` (added as part of this task seed) must pass.

**Success criterion.** `pnpm vitest run tests/slugify.test.ts` exits 0; `tsc`
clean; `slugify` appears in the export list of both `src/lib/strings.ts` and
`src/index.ts`; the inline regex in `src/server/slugify.ts` is gone.

**Failure modes.**
- Helper added but barrel re-export forgotten — consumer files outside the
  module can't import it.
- Inline logic deleted but call to the helper not wired up correctly (e.g.,
  arguments swapped).
- Edge cases in the regex (Unicode, empty input) handled differently than the
  tests expect.

**Hypothesised Strata advantage.** Mild. `create_function` + `add_import` +
`replace_body` are individually cheap, but most of the work here is
reasoning, not mechanics. May actually be a small *disadvantage* for Strata
if the substrate forces more tool calls than a single multi-file edit would
in Claude Code. Useful as a control — if Strata wins here, it's winning on
overhead reduction in general, not just structural ops.

**Estimated baseline difficulty.** Moderate. Easy in mechanics, but
multi-file wiring is exactly the kind of thing baseline agents sometimes
half-finish.

---

## T05 — Fix a bug

**Description.** A failing test points to a logic error in a specific
function. The agent must diagnose and fix it. Mostly a reasoning task; both
configurations have access to the same diagnostic signal (test output).

**Starting state.** `src/lib/dateRange.ts` exports `isWithinRange(date: Date,
start: Date, end: Date): boolean` (~12 LOC). It currently returns `date >=
start && date <= end`, but the test fixture `tests/dateRange.test.ts`
includes a "half-open interval" case that expects `date >= start && date <
end`. One test fails.

**Prompt to agent.**
> The test `tests/dateRange.test.ts` is failing. Investigate, fix the
> underlying bug, and make the test suite pass without weakening any
> assertion. Do not modify the test file.

**Success criterion.** `pnpm vitest run tests/dateRange.test.ts` exits 0;
`tsc` clean; `tests/dateRange.test.ts` is byte-identical to the seed.

**Failure modes.**
- Agent modifies the test to make it pass.
- Agent changes the comparison in the wrong direction.
- Agent edits a different function with a similar name.
- Agent over-fixes and breaks a different test that relied on the closed
  interval semantics.

**Hypothesised Strata advantage.** Probably none — or a small disadvantage,
since the diagnostic loop is the same and the edit is a single-statement
change. Including this task is deliberate: if Strata shows wins on T01–T04
and parity on T05, that's evidence the wins are real and substrate-specific,
not a measurement artifact.

**Estimated baseline difficulty.** Easy. Claude Code handles single-function
bug fixes with a failing test in one or two iterations.

---

## T06 — Refactor a class

**Description.** Convert a class from inheritance to composition. A
`MarkdownReport` subclass extends `Report`; the task is to replace
inheritance with a `report: Report` field and delegate. Stresses large
structural rewrite with many internal references that must survive the
restructure.

**Starting state.** `src/reporting/report.ts` defines `class Report` (~50
LOC, ~6 methods, 2 protected fields). `src/reporting/markdown.ts` defines
`class MarkdownReport extends Report` (~40 LOC, overrides 2 methods, adds 2
new ones, uses `super.render()` and `this.title` from the parent). Tests in
`tests/reporting.test.ts` cover behavior through the `MarkdownReport`
constructor and public API.

**Prompt to agent.**
> Refactor `MarkdownReport` in `src/reporting/markdown.ts` to use composition
> instead of inheritance: it should hold a private `report: Report` field
> initialized in its constructor, expose the same public API as before, and
> delegate to `this.report` instead of `super`. The constructor signature
> must remain unchanged from the caller's perspective. The tests in
> `tests/reporting.test.ts` must pass without modification.

**Success criterion.** `pnpm vitest run tests/reporting.test.ts` exits 0;
`tsc` clean; `MarkdownReport` no longer has `extends Report`;
`tests/reporting.test.ts` byte-identical to the seed; no `super.` calls
remain in `src/reporting/markdown.ts`.

**Failure modes.**
- `super.render()` calls partially replaced; some left dangling and the file
  no longer compiles.
- Protected field access (`this.title` where `title` was on the parent)
  silently breaks because the agent forgets the field moved out of `this`.
- Public method ordering or visibility changes inadvertently and a test that
  checks `instanceof` or duck-types the API breaks.
- Constructor signature drifts and callers stop compiling.

**Hypothesised Strata advantage.** Strong on paper: stable node IDs across
the rewrite mean references between methods and fields don't get
desynchronised the way they would across many text edits, and `replace_body`
on each method is a focused op. In practice the value depends on how good
the substrate is at expressing "every `super.X()` becomes `this.report.X()`".
A genuine stress test of whether the operation set is at the right
granularity.

**Estimated baseline difficulty.** Hard. This is exactly the kind of edit
where Claude Code burns context on re-reading the parent and child class
repeatedly and produces partial diffs.

---

## T07 — Add error handling

**Description.** Change a function from throwing on failure to returning a
`Result<T, E>` (or `T | Error`) and update every caller to handle the error
branch. Stresses signature-driven cascade across callers' control flow,
where each callsite needs a different handling decision.

**Starting state.** `src/lib/parseConfig.ts` exports `parseConfig(text:
string): Config` which currently `throw new Error(...)` on invalid JSON. It
has ~6 callers across `src/server/` and `src/cli/`. Some callers currently
have surrounding `try/catch`, some don't.

**Prompt to agent.**
> Change `parseConfig` so it returns `{ ok: true; value: Config } | { ok:
> false; error: string }` instead of throwing. Update every caller: callers
> under `src/cli/` should print the error and `process.exit(1)`; callers
> under `src/server/` should propagate by returning their own error result
> (extending their signatures if needed). Remove now-redundant `try/catch`
> blocks. Tests in `tests/parseConfig.test.ts` must pass.

**Success criterion.** `pnpm vitest run tests/parseConfig.test.ts` exits 0;
`tsc` clean; `parseConfig` no longer contains `throw`; no caller wraps it in
`try/catch`.

**Failure modes.**
- A caller's signature change is missed and the discriminated union leaks
  upward as `any`.
- One `try/catch` is left behind, catching nothing now and silently
  no-op'ing.
- The `process.exit` calls are added in the wrong branch (or unconditionally).
- The propagation path skips one intermediate function, breaking the type at
  the boundary.

**Hypothesised Strata advantage.** Moderate. Strata can locate every caller
deterministically via the reference index, and the agent can apply a per-
directory policy to each. The actual control-flow rewrite at each callsite
is still reasoning-heavy; the substrate wins on coverage, not on collapsing
the work.

**Estimated baseline difficulty.** Hard. Signature changes that fan out into
control flow are where Claude Code's "edit and retry on type error" loop
gets expensive — it often needs several validation passes.

---

## T08 — Change a return type

**Description.** Narrow the return type of a function from `string` to a
string-literal union, and propagate the narrowing through every consumer.
Stresses type-driven cascade where the compiler is the primary signal.

**Starting state.** `src/lib/permissions.ts` exports `getRole(userId: string):
string`. It in fact only ever returns one of `"admin" | "editor" | "viewer"`
(today as a free-form string). ~8 callers, several of which compare the
return with `===` against one of those literals.

**Prompt to agent.**
> Change the return type of `getRole` to `"admin" | "editor" | "viewer"`.
> Update the function body so the literal type is preserved (use `as const`
> or explicit annotation, not `as` casts that erase information). Update
> every caller that benefits from the narrower type — for example, replace
> any `if (role === "admin" || role === "editor" || role === "viewer")`
> exhaustive guards with `switch` statements where appropriate, and remove
> any `as` casts that are now redundant. The test suite must pass.

**Success criterion.** `pnpm vitest run` exits 0; `tsc` clean; `getRole`'s
return type is the literal union (verified via a type-level test); no `as
string` casts on the result of `getRole` remain anywhere in `src/`.

**Failure modes.**
- Return type narrowed but body uses `as` to coerce a `string` upward,
  defeating the point.
- A caller's `switch` is rewritten to be non-exhaustive and the compiler now
  complains about `undefined`.
- A redundant `as` cast on a different `getRole`-shaped function is removed
  by mistake.

**Hypothesised Strata advantage.** Moderate. The reference index identifies
callers cheaply; the substrate can show which `as` casts are downstream of a
given return value. Still a reasoning-heavy task per call site.

**Estimated baseline difficulty.** Moderate. Single signature change is
easy; the "find all the now-redundant casts" sub-task is where baseline
agents either over- or under-edit.

---

## T09 — Add a type guard

**Description.** Introduce a user-defined type guard (`function isFoo(x):
x is Foo`) and apply it at multiple sites that currently do unsafe casting
or repeated property checks. Stresses both creating the guard and finding
the candidate application sites.

**Starting state.** `src/lib/events.ts` defines a union `type Event =
ClickEvent | KeyEvent | ScrollEvent`. In ~5 modules, code currently does
`(event as ClickEvent).button` after an `event.type === "click"` check.
There is no existing guard function.

**Prompt to agent.**
> Add a type guard `isClickEvent(event: Event): event is ClickEvent` to
> `src/lib/events.ts`. Find every site where `event` is being treated as a
> `ClickEvent` after a `type === "click"` check and replace the unsafe cast
> with a call to `isClickEvent`. The test suite must pass and no `as
> ClickEvent` casts should remain on `Event`-typed variables.

**Success criterion.** `pnpm vitest run` exits 0; `tsc` clean; `isClickEvent`
is exported; `grep -rn "as ClickEvent" src/` returns no results in
contexts where the input is typed `Event`.

**Failure modes.**
- Guard written incorrectly (returns `boolean` without the `event is
  ClickEvent` predicate) — the casts get replaced and the narrowing breaks.
- One application site that uses a slightly different pattern (e.g.,
  `event["type"] === "click"`) is missed.
- An `as ClickEvent` cast on a `ClickEvent`-typed (not `Event`-typed)
  variable is removed and breaks compilation.

**Hypothesised Strata advantage.** Moderate. Finding `as ClickEvent`
expressions is straightforward in both substrates; what Strata can do
better is filter to "casts on `Event`-typed expressions" using the
inferred-type index. Whether the agent actually uses that filter is a
prompt-engineering question.

**Estimated baseline difficulty.** Moderate. Easy to write the guard; the
risk is in selecting the right cast-replacement sites.

---

## T10 — Inline a single-use function

**Description.** Find a function that is called from exactly one place and
inline it at the callsite, removing the definition. Verify behavior is
unchanged. The reverse of T02.

**Starting state.** `src/lib/format.ts` exports `formatCents(cents: number):
string` (~6 LOC) which is called from exactly one place, inside
`src/server/receipt.ts`. The function is not re-exported from any barrel
and has no other references.

**Prompt to agent.**
> Inline `formatCents` at its single callsite in `src/server/receipt.ts`,
> then delete the `formatCents` declaration and its export from
> `src/lib/format.ts`. Verify nothing else in the codebase referenced it.
> The full test suite must pass.

**Success criterion.** `pnpm vitest run` exits 0; `tsc` clean; `grep -rn
"formatCents" src/` returns no results; `formatCents` is gone from the
exports of `src/lib/format.ts`.

**Failure modes.**
- A reference in a JSDoc `@see` link is missed and rots.
- The function body is inlined verbatim without substituting the parameter
  for the actual argument.
- A re-export in a barrel file is missed and `tsc` fails on the dangling
  export.
- A second callsite exists (a tooling test, a snapshot, a `.d.ts`) and the
  function is deleted anyway, breaking the build.

**Hypothesised Strata advantage.** Strong. `inline_function(function_id)` is
a single op: it knows all callsites from the reference index (so the "is
this really single-use?" check is free and correct), substitutes parameters,
and deletes the declaration in one transaction. In the file substrate this
is a multi-step grep / read / edit / delete dance.

**Estimated baseline difficulty.** Easy-to-moderate. Single-callsite inline
is mechanically easy, but the "really single-use?" check is what baseline
agents skip or do poorly.

---

## Open questions

- **Trials per task.** strata-design.md suggests 3–5 runs per configuration.
  Need to confirm the count and decide whether to use the same model
  temperature for all runs or vary it. Outliers matter; budget will dominate
  the choice.
- **Quality rating rubric.** "Does the code look reasonable on review?" is
  too vague. Need a 1–5 rubric with concrete anchors (e.g., "5 = idiomatic,
  no dead code; 3 = correct but awkward; 1 = passes tests by accident").
  Probably a single human rater for consistency, ideally blind to which
  configuration produced the output.
- **Shared seed vs. per-task fixtures.** This spec assumes a single shared
  seed codebase (the `examples/medium` tree) into which all 10 tasks are
  pre-staged. Alternative: per-task fixtures so tasks can be added/removed
  without disturbing each other. Shared-seed is cheaper to maintain and
  more realistic (tasks see incidental complexity), but harder to make
  hermetic; per-task is the opposite. Recommend shared seed, revisit if
  tasks start interfering.
- **Seed-code provenance.** The seed needs to be plausibly real (not a toy)
  but stable across runs. Options: vendored from an existing OSS project, or
  hand-written specifically for the benchmark. Vendored is more realistic
  but introduces licensing and update churn; bespoke is more controlled.
  Recommend bespoke, ~3–5k LOC, modeled after a small server-side TypeScript
  app.
- **Baseline tool surface.** Claude Code has many tools (Read, Edit, Bash,
  Grep, Glob, etc.). Should the baseline be allowed to run `tsc` and
  `vitest` between edits? If yes, the comparison is fairer; if no, Strata's
  built-in `validate(tx)` is an unfair structural advantage. Default
  position: yes, both configurations can run typecheck/tests freely; the
  comparison is on substrate, not on tooling deprivation.
- **What counts as a "retry" for the baseline.** Strata's notion of a
  failed transaction is well-defined (commit blocked by `validate`). Claude
  Code's equivalent is fuzzier — a failed `Edit` tool call? A test run that
  exits non-zero followed by another edit? Need a concrete counting rule
  before running, or the metric is meaningless.
