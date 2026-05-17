# Multi-step exploration sandbox — design

*Status: design, awaiting user review. Date: 2026-05-17. Author: brainstorming session.*

## Why this exists

The Strata research artifact is a deliberately **rigid, expensive, claim-grade
framework**: every keyed round is pre-registered tamper-evidently, run at N≥3
against a file baseline, and classified from transcripts ($0.79–$3.82/round).
That rigor is the project's credibility and must not change.

But that same rigor makes it slow and costly to *explore new methods* for the
one open problem — multi-step generalization (the T01 boundary). The four
falsified levers (prompt, gate, model, tool-result legibility) were genuinely
keyed-tested. The strongest remaining candidates were **only reasoned about,
never run**:

- `add_parameter` per-callsite/per-scope expressiveness (Codex's "substantive
  lever") — designed across a full multi-agent pass, then terminated on a
  *verified integrity argument*, not an experiment.
- A store-level overlap gate at `queueTextSpanEdit`.
- Removing/narrowing the `replace_body` escape hatch.
- A loop redesign forbidding re-edit of a tool-touched span.

`decisions.md` explicitly scopes "make multi-step work" as **new research, its
own spec/decision cycle** — not a T01 continuation. This sandbox is that
vehicle: a fast, cheap, **non-authoritative** place to iterate on new methods,
with a one-way graduation path back into the rigid framework once something
earns a real keyed round.

The integrity reason exploration must be sandboxed and cannot reuse T01: T01's
scorer requires the literal `"local"`, which (verified 2026-05-17 against
`packages/verify/src/t01Criteria.ts:42`, `examples/medium`, and
`packages/agent/src/session.ts:168`) appears **only in the T01 prompt** and
nowhere in the corpus. Any method "passing" T01 would be the agent transcribing
the prompt — an uninterpretable, contaminated win. The sandbox therefore
supplies its own *honest* measurement instrument.

## Non-goals

- Not a claim. No sandbox output is ever cited in `RESULTS.md`, `decisions.md`,
  or `strata-design.md`. It only decides what is worth a rigid round.
- Not a replacement for the keyed framework. The rigid pipeline (pre-reg, N≥3,
  baseline, transcript classification, T03 regression guard) is unchanged and
  remains the only source of claims.
- Not multi-language, not multi-client, not a productization. Same out-of-scope
  fences as `strata-design.md`.
- Not prompt re-exploration. BS-P-B already falsified prompt tuning; the
  sandbox exists to test *tool-surface and loop* changes.

## Architecture

```
packages/lab/                     # new pnpm workspace package, @strata/lab
  README.md                       # loud NON-AUTHORITATIVE header (see below)
  corpus/                         # lab-owned copy derived from examples/medium
                                  #   (authoritative examples/medium left byte-identical)
  src/
    tasks/
      honestDerivable.ts          # HD task: prompt + code-derived oracle scorer
      trappedControl.ts           # T01-clone: prompt-only literal, structurally unsatisfiable
    experiments/                  # one file per experiment (variant + which task)
    registry.ts                   # id -> experiment
    run.ts                        # `lab run <experiment>` cheap N=1 live runner
    seam.ts                       # re-exports the canonical session injection point
  test/                           # deterministic key-free mechanics tests (model-free)
  LAB-NOTES.md                    # append-only freeform journal (NOT decisions.md)
```

`@strata/lab` depends on canonical `@strata/store`, `@strata/agent`,
`@strata/render`, `@strata/verify` and exercises them through the seam below.
It never edits them.

### Isolation / non-authoritative guarantees (all mechanically checkable)

1. **Excluded from the claim-grade aggregate.** The "N passing /
   `pnpm -r test`" story stays defined over the canonical packages. `@strata/lab`
   has its own `pnpm --filter @strata/lab test` and is not counted toward the
   published number. (Mechanism: a workspace test-scope exclusion; the exact
   wiring is an implementation detail for the plan, but the invariant — lab
   tests never inflate/deflate the canonical count — is normative here.)
2. **Canonical byte-identical during exploration.** All variant code lives in
   `packages/lab`. After the one-time seam lands (below), a `git diff` over
   `packages/{store,agent,render,verify}` is empty for the duration of any
   exploration. This is the proof, not a promise.
3. **Authoritative docs untouched.** `decisions.md` / `RESULTS.md` /
   `strata-design.md` are not edited by sandbox work. Journaling goes to
   `packages/lab/LAB-NOTES.md`. Only a *graduated* method opens a real
   `decisions.md` entry, through the existing rigid process.
4. **Scratch gitignored.** Lab run artifacts/logs are gitignored like
   `packages/bench/results/`.

`packages/lab/README.md` opens with, verbatim intent:
> **NON-AUTHORITATIVE SANDBOX.** Nothing here is a claim. Results do not feed
> RESULTS.md / decisions.md / strata-design.md. A method leaves here only by
> graduating into the rigid keyed framework (see § Graduation).

## The measurement instrument

### Honest-derivable (HD) task

A multi-step refactor over `packages/lab/corpus/` (the derived copy) whose
correct per-site behavior is a **pure function of the code, not the prompt**.

Concrete design (final wording fixed during implementation, but these
properties are normative):

- The corpus copy gains a per-scope constant that already exists in the tree —
  e.g. `src/server/config.ts` exports `ZONE = "UTC"`, `src/ui/config.ts`
  exports `ZONE = "local"`; some scopes export no `ZONE`.
- Task prompt (shape): *"Add a `timezone: string` parameter to
  `formatTimestamp` after `ts`. At each callsite, pass that module-scope's
  exported `ZONE` constant by reference. Callsites in a scope that exports no
  `ZONE` take the default. The corpus tests must pass."*
- The agent must (1) add the parameter (structural callsite fan-out) **and**
  (2) at each callsite resolve its scope and reference *that scope's existing
  symbol*. Multi-step and decision-bearing — but **every decision is derivable
  from the graph**, the `rename_symbol`-class property the substrate provably
  helps with. The differentiating value is structurally present, unlike T01
  where it lived only in the prompt.
- The task is constructed so the oracle (below) is a **deterministic, unique
  function of the corpus** — there is exactly one correct rendered result.

### Derivable scorer

The HD scorer contains **no expected literal**. It:

1. Renders the post-change store to text via canonical `@strata/render`.
2. Independently computes the oracle by walking the corpus: for each
   `formatTimestamp` callsite → its module scope → does that scope export
   `ZONE` → therefore the correct argument (a reference to that `ZONE`, or
   absent ⇒ default).
3. Asserts every callsite matches the code-derived oracle, plus the parameter
   was added once with the right signature, plus corpus `tsc` + tests pass.

A pass therefore means *the agent produced what the code implies*, provably not
what the prompt dictated. This is the integrity core of the whole sandbox.

### Trapped control (graduation-only)

A T01-clone on the same corpus: the per-scope value is stated **only in the
prompt**, and its scorer requires that prompt-only literal — i.e. structurally
unsatisfiable by any honest method, *by construction* (the verified 2026-05-17
finding, reproduced deliberately).

A real method must **pass HD and still fail the trap**. This is the same
inverted-control logic that made the original T03/T05 result credible (the
inverted T05 control was "the strongest possible evidence the gap is the
substrate, not a rigged comparison"). It is the mechanical answer to "did the
method work, or did you rig the task?" The cheap inner loop runs HD only; the
trap runs at graduation, so the inner loop stays cheap.

## Experiment interface & the seam

### Experiment

One file in `src/experiments/`, exporting:

```
interface LabExperiment {
  id: string;                 // kebab id, also the registry key
  hypothesis: string;         // one line: what this tests and the expected tell
  task: "HD" | "trap";        // HD for the inner loop; trap only at graduation
  overrides: {
    toolServerOverride?: …;   // a variant SDK MCP tool server (compose canonical + variant)
    preToolUseHook?: …;       // e.g. a store/overlap gate
    loopWrapper?: …;          // e.g. detect/forbid re-edit of a tool-touched span
    prompt?: string;          // only if the experiment varies the prompt
  };
}
```

Overrides are **composed**, never an edit to canonical code. `registry.ts` maps
`id → LabExperiment`.

### The seam (one sanctioned, prerequisite canonical touch — then frozen)

The lab must drive the *real* agent loop (a duplicate loop would make graduated
results non-comparable — itself an integrity risk). So `@strata/agent`'s
session gains **one additive, optional, default-preserving** injection point:
optional `toolServerOverride?` / `preToolUseHook?` / `loopWrapper?` params,
defaulting to exactly today's behavior.

Ordering (explicit, to avoid contradicting the byte-identical fence):

1. The seam lands **once, before exploration**, as reviewed infrastructure with
   its own `decisions.md` entry. It is gated on: params optional; default ⇒
   byte-identical behavior; **all existing canonical tests unchanged and
   green**; no scoring path altered (the gate/replay keying off
   `replayTranscript` is untouched). This is the *only* sanctioned canonical
   change for this whole effort.
2. From that point, the Section-1 "canonical byte-identical during exploration"
   fence holds and is `git diff`-checkable.

`src/seam.ts` is a thin re-export so experiments import the injection point
from one place.

### The runner

`lab run <experiment> [--model <m>] [--max-turns <n>]`:

- Builds canonical substrate over `packages/lab/corpus/` + the experiment's
  composed overrides.
- Runs the experiment's task **N=1, cheap model (default `claude-sonnet-4-6`,
  overridable down), short turn budget**.
- Prints to stdout: an annotated tool-call transcript (each call + result
  summary) and the derivable-scorer verdict (pass/fail + per-callsite oracle
  diff on fail).
- No baseline, no pre-registration, no distribution, no results JSON that
  anything else consumes.
- Target cost ~$0.05–0.30/run. The point is: change a variant, re-run, read the
  transcript, tweak — in minutes, for cents.

## Initial experiment backlog

The untested levers, now cheaply runnable against an honest task:

1. **`add_parameter` per-scope expressiveness** — variant tool accepting a
   code-derived per-scope value/reference policy so the per-site
   differentiation is expressible as one structural op (Codex's "substantive
   lever"). Hypothesis: removes the need for the colliding `replace_body`.
2. **Store-level overlap gate at `queueTextSpanEdit`** — reject an edit
   overlapping a span a tool already queued. Now testable *honestly*: on HD the
   legitimate per-site edit is expressible via lever 1, so the gate is no
   longer "honest-negative-by-construction" as it would have been on T01.
3. **`replace_body` escape-hatch removal/narrowing** — toolset variant without
   the general body hatch (or a narrowed body-op surface).
4. **Loop wrapper forbidding re-edit of a tool-touched span** — detect the
   diagnosed thrash mechanically and force the structural path.

Combinations are allowed; each experiment is one file with its own hypothesis.
The backlog is a starting point, not a fixed protocol — the sandbox exists for
open iteration.

## Graduation

A method leaves the sandbox only when **all** hold:

- (a) It passes HD reproducibly on the cheap loop (a few hand-runs, not a
  single lucky transcript).
- (b) It **still fails the trapped control** (integrity discriminator).
- (c) It is portable into canonical as an *additive* change.

Graduation then enters the **existing rigid pipeline unchanged**: brainstorm
(if the canonical change is non-trivial) → spec → TDD into the canonical
package → independent expert (Codex) review per `CLAUDE.md` → pre-registered
keyed N≥3 with **T03 as the regression guard** → newest-first `decisions.md`
entry whatever the outcome. Only that round produces a claim. The sandbox
result is cited only as "what motivated spending the round," never as evidence.

## Testing

- **Lab mechanics tests** (`packages/lab/test/`): deterministic, key-free,
  model-free unit tests for each variant tool's mechanics (e.g. the per-scope
  `add_parameter` produces the right overlay; the overlap gate rejects exactly
  overlapping spans and allows disjoint same-statement edits — the T08
  regression hazard called out in `decisions.md` 2026-05-17). These run under
  `pnpm --filter @strata/lab test`, isolated from the canonical count.
- **The cheap live run is the exploration signal, not a test.** It is never in
  CI and never key-free-replayed into the canonical suite.
- **Seam regression**: the one-time seam PR must show all pre-existing canonical
  tests unchanged and green (its gate).

## Risks & honest caveats

- **A duplicate-loop temptation.** If the seam proves awkward, the wrong fix is
  a hand-rolled lab loop — it would make graduated numbers non-comparable.
  Mitigation: the seam is a first-class, reviewed deliverable, not an
  afterthought.
- **HD task could itself be subtly trappable.** Mitigation: the derivable
  scorer computes its oracle from the corpus with zero expected literals, and
  the trapped control must fail under any method that passes HD — a built-in
  contamination alarm. If a method ever passes *both*, that is a STOP and a
  signal the HD task or scorer is flawed, not a win.
- **Sandbox success ≠ result.** Stated everywhere (README, this spec,
  graduation §). The discipline that made the project credible — pre-reg, N≥3,
  baseline, transcript classification — is applied only at graduation, never
  relaxed.
- **Corpus drift.** The lab corpus is a *derived copy*; `examples/medium` stays
  byte-identical so canonical T01/T03/T05/T08 scorers are unaffected.

## What this changes in the authoritative docs

Nothing, until graduation. `strata-design.md` is not amended (per `CLAUDE.md`
the contract is not silently rewritten). This spec lives under
`docs/superpowers/specs/` like the others. The one-time seam is the sole
canonical code touch and gets its own `decisions.md` infra entry when it lands.
