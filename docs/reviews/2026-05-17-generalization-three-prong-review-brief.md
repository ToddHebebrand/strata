# Independent review brief — does a *generalizing* version of Strata exist?

**Audience:** an independent reviewer model (Codex CLI, `gpt-5.4`, reasoning `xhigh`,
read-only, repo-grounded). You are NOT being asked to implement anything. You are
being asked to attack a framing *before* any spec is written or any keyed budget
is spent. Prior independent review caught a decision-grade error this way; do the
same here.

## How to use this brief

- This is self-contained, but the authoritative sources in the repo are
  `README.md`, `strata-design.md`, `docs/RESULTS.md`, and especially
  `decisions.md` (append-only, newest first — read the top ~10 entries).
- **Verify every pivotal empirical claim in this brief against the actual code /
  criteria before relying on it.** The pivotal code: `packages/store/src/{ingest
  is in packages/ingest/src/index.ts, transactions.ts, rename.ts, replaceBody.ts,
  addParameter.ts}`, `packages/render/src/{index.ts,splice.ts}`,
  `packages/verify/src/{validate.ts,t01Criteria.ts}`, `packages/agent/src/
  {tools.ts,prompt.ts,session.ts}`, `packages/bench/src/configs/
  {substrate.ts,baseline.ts}`. If a claim here does not match the code, say so —
  that is the highest-value thing you can return.
- **Do not re-propose any lever listed under "Falsified levers."** They are
  closed with pre-registered, transcript-classified evidence. Re-proposing them
  wastes the review.

## What Strata is (one paragraph)

Strata replaces the file abstraction with a SQLite node graph + an append-only
operation log. A Claude agent (`@anthropic-ai/claude-agent-sdk`) is given ONLY
in-process structural MCP tools and no filesystem (enforced at runtime by
`assertOnlyStrataTools` at the SDK `init` message, not just by config). Files
exist only as transient in-memory strings produced by the render pipeline so an
in-process `tsc` (and, behind the commit gate, `vitest`) can check the work;
diagnostics are mapped back to node IDs via a source map. A benchmark harness
runs the *same model, same task, same prompt, same scoring core* against this
substrate vs. a file-tools Claude Code baseline on a copied corpus; the only
controlled-variable difference is the substrate.

## The proven win and its exact shape (do not re-litigate this; characterize it)

On a reference-aware **rename** across a real multi-module TS corpus
(`examples/medium`, task T03), `claude-sonnet-4-6`, N=3: substrate ≈ 1201–1473
total tokens / 24–30 s / 7–11 tool calls vs. baseline ≈ 4450–4682 / 57–59 s /
25–27, disjoint distributions, both 3/3, identical output quality. It held under
a stronger model (`claude-opus-4-7`) and a prompt change; under Opus the baseline
*blew its turn budget on the same rename* while the substrate finished in ~6
tools. Observed separation at N=3, explicitly not a significance claim.

The *shape* of every robust case: (a) the substrate owns 100% of semantic
resolution (the reference graph), (b) the change is a **single structural
commitment** over that graph, (c) the agent supplies one scalar (the new name).
The losing cases have the opposite shape: the agent must orchestrate a *sequence*
of edits the substrate cannot express as one graph operation.

## The diagnosed boundary — TWO independent causes, kept separate

1. **Task-integrity wall (T01-specific, OUT OF SCOPE for your review).**
   `uiCallsitesLocalOrDefault` in `packages/verify/src/t01Criteria.ts` requires
   the literal `"local"` at one specific UI callsite. `"local"` appears **only in
   `T01_PROMPT`**, nowhere in `examples/medium`. Therefore *any* mechanism that
   passes T01 is either scripting or prompt-transcription. T01 is un-closeable by
   any honest structural lever **by scorer construction**. Do not propose fixing
   T01. Redesigning a failing task until the substrate passes it is itself
   integrity-fraught and is explicitly not in honest scope.

2. **Architectural wall (general, IN SCOPE).** Statement bodies are stored as
   *verbatim text payloads* (`ingest/src/index.ts` stores `statement.getFullText()`;
   identifiers are `{text,offset}` children). Multi-step edits that touch the same
   statement region become **overlapping text splices into one string** →
   `splice.ts` / `commitWithoutValidate` throw `oldText mismatch at [start,end)`.
   This is the mechanism behind the `add_parameter` + manual-`replace_body`
   collision thrash. It is a property of *this implementation*, not of the idea.

## Falsified levers (pre-registered, transcript-classified — DO NOT re-propose)

- Prompt / tool-description tuning — terminal (`decisions.md` BS-P-B 2026-05-15).
- The behavioral commit gate — built, found invalid as first built (BG-4), fixed,
  keyed-validated; it rescues T05 correctness and closes T08 but is provably
  **not** T01's lever.
- Model capability — single-variable Opus probe at the strongest available model
  (MP-2 = L2): failure is tool-design, not model.
- Tool-**result** legibility — an audit-proof itemized manifest of the tool's own
  edits was delivered and the agent **ignored it and hand-patched anyway**
  (AP-2 negative / AP-3 unchanged). The deepest finding: this is *a deeper
  agent-behavioral failure, not a communication problem.*
- The per-callsite/per-scope `add_parameter` expressiveness extension — fully
  multi-agent designed, then withdrawn as integrity-un-closeable *for T01
  specifically* (relocates the decision surface; legibility-falsification echo;
  files-not-first-class violated in substance).

## The candidate to attack: a three-prong NEW research project

Not a lever on the current build. A new, separately pre-registered project whose
claim is "the substrate advantage *generalizes* beyond atomic operations." The
evidence pattern (four necessary-not-sufficient levers) predicts you need all
three prongs simultaneously:

- **P1 — Substrate: real subtree bodies.** Statements/expressions become actual
  nodes with stable IDs, not text payloads. Then a callsite insertion and any
  further edit are *disjoint node mutations*, not competing splices into one
  blob. Claim: this removes the collision class **by construction**. This is the
  deep-AST design the original `strata-design.md` hedged on and the build cut for
  speed; reinstating it changes the substrate, not the benchmark (integrity-clean).

- **P2 — Affordance: remove/replace the `replace_body` escape hatch.** Rationale:
  the sharpest finding is that the agent *compulsively* hand-patches even given
  proof the work is done. That predicts P1 alone is necessary-not-sufficient: a
  text-patch escape hatch will still be reached for. P2 tests whether the
  hand-patch is a *capability limit* or an *affordance artifact*. This is the
  untried different-class lever `decisions.md` explicitly defers.

- **P3 — An honest multi-step benchmark task.** Its per-scope behavior must be
  *structurally derivable from the codebase*, NOT stated only in the prompt — so
  a pass means "substrate capability," not "agent transcribed the prompt." This
  is `decisions.md`'s own "Revisit when." Without P3 you rebuild the T01 trap.

## The questions I want you to attack (sharpest first)

1. **Is P1 necessary-but-not-sufficient — and is P2 the true binding
   constraint?** Steelman the position that even with subtree bodies and an
   honest task, the agent's body-edit prior makes it fail unless `replace_body`
   is *structurally impossible*. If P2 is the binding constraint, P1 may be a
   large engineering cost for little marginal generalization. Is there a cheaper
   experiment that isolates P2 *first* on the current text-span substrate (e.g.
   a tool-surface change that forbids re-editing a tool-touched span) to decide
   whether P1 is even worth building?
2. **Falsification design.** State the precise outcome that would *falsify the
   whole Strata thesis* (not just this project). I claim it is: "with subtree
   bodies + no escape hatch + a structurally-derivable multi-step task, the agent
   still fails." Is that the right falsifier? Is there a sharper, cheaper one?
3. **Is the contracted claim the honest terminal result?** Argue for/against:
   the project is *already done* and its honest result is the narrowed claim
   ("removing the file abstraction is a large, model-independent win for
   reference-global *atomic* operations"), making the three-prong project
   optional scope expansion rather than a debt. The user concluded the research
   on 2026-05-17; is reopening it justified or motivated reasoning?
4. **Blind spots.** What is the strongest objection to this entire framing that
   neither the brief nor `decisions.md` has voiced? (e.g. is the rename win
   itself narrower than claimed? is "structurally derivable" actually definable
   without smuggling the answer in? does P1's stable-ID requirement for
   expression nodes reintroduce ID churn the whole op-log story depends on?)

## Hard constraints

- Read-only, repo-grounded. No code. This is pre-spec analysis.
- Invariants that must survive any proposal: files-not-first-class; stable node
  IDs across mutations (no ID churn — interrogate whether P1 violates this);
  operation log is canonical; rendering is canonical/lossy on formatting; no
  benchmark-redesign-until-it-passes; no multi-language/FUSE/git scope.
- Prefer "this claim in the brief is wrong, here is the code that shows it" over
  agreement. The review exists to surface blind spots, not to ratify.

## Deliverable

A prioritized list: (i) any pivotal claim here you verified false against the
code; (ii) your answer to Q1–Q4 with the single highest-leverage
recommendation (including "don't do this project, the contracted claim is the
result" if that is your honest read); (iii) the cheapest experiment that would
most change the decision.
