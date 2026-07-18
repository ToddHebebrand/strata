# When does a structural substrate beat files? Measuring an agent-native alternative to the file abstraction

*Todd Hebebrand · July 2026 · [github.com/ToddHebebrand/strata](https://github.com/ToddHebebrand/strata) · MIT. Every number below is sourced from [`RESULTS.md`](RESULTS.md), the append-only decision log ([`decisions.md`](../decisions.md)), and the Phase-6 evidence docs under [`docs/spikes/`](spikes/); N is stated everywhere because most of it is small.*

## The bet

AI coding agents inherit an interface designed for humans: files. To change one function, an agent reads a whole file. To express a structural change — rename this symbol, add this parameter everywhere — it emits text diffs and hopes they apply. To find every use of a declaration, it greps and reasons about false positives. The file abstraction exists because humans read linearly; agents don't have that constraint.

And the cost compounds the moment there is more than one agent. Because files are opaque text, concurrent work on them means branches, worktrees, and merge conflicts — coordination by diff, resolved after the fact by whoever (or whatever) does the merge. That multi-agent problem is what Strata was built to attack: if the codebase is a canonical graph and every change is a typed operation, the substrate itself can see what each change touches — and many agents should be able to share one codebase directly, with no merge step to exist.

Strata is the experiment: replace files entirely. A TypeScript codebase becomes a SQLite-backed graph of nodes — modules, declarations, statements, identifiers — with stable IDs and resolved reference edges. An agent (Claude Agent SDK, **no filesystem tools at all**) queries and mutates that graph through ~20 structural tools inside transactions. A commit gate renders the pending graph to text, type-checks it in-process, and optionally runs the task's tests; commits that fail are refused. Files exist only as transient compiler artifacts the agent never sees.

The investigation ran in two stages, deliberately. First the single-agent question — same model, same task, same success bar, does the substrate reach the right answer with materially less work? — because it isolates the interface variable and proves the substrate is real before any coordination claim can mean anything. Then the question the project was pointed at from the start: multiple agents, one shared, always-green codebase.

The single-agent answer turned out to be more interesting than yes or no. **The substrate wins big on exactly one class of task, loses on its complement, and the boundary between them is sharp enough to state as a rule.** And the multi-agent answer is where the largest margins in this write-up live.

## The headline win: bulk propagation

The flagship task is a reference-aware rename across a real multi-module corpus: rename `User` → `Account` through imports, type positions, generics, JSDoc type tags, namespace uses, and a type-only re-export — while leaving a same-spelling string literal untouched. Same model (`claude-sonnet-4-6`), same prompt, same scoring core for both arms.

| Metric (N=3 per arm) | Strata agent | File-tools baseline | Separation |
|---|---|---|---|
| Total tokens | 1,201–1,473 | 4,450–4,682 | disjoint, ~3.5× fewer |
| Wall time | 24.6–30.3 s | 57.4–59.4 s | disjoint, ~2.2× faster |
| Tool/edit calls | 7–11 | 25–27 | disjoint, ~3× fewer |
| Cost per run | ~$0.038 | ~$0.184 | ~4.9× cheaper |

Both arms succeeded 3/3 with identical output quality (tsc plus the corpus tests pass). The distributions do not overlap. This is an observed separation at N=3, not a significance claim — but it replicated across every harness iteration, including after an adversarial remediation of the harness itself, and after a system-prompt change.

Two follow-on results say the win is not an artifact of one task or one model:

- **Cross-module move** (`move_declaration`: relocate a declaration, rewrite every importer): substrate at **51.7% of baseline cost**, half the tool calls, 2.4× faster (N=1).
- **Stronger model, same shape.** Under `claude-opus-4-7`, the *file* baseline thrashed the rename into a 25-tool turn-limit failure where the substrate finished in 6 calls (N=2). The win is, if anything, amplified — a stronger model doesn't rescue the weaker interface.
- **Real external code.** On `unjs/defu` (a real published library, not our corpus), the same rename shape: substrate 6 tools / 32 s / $0.05 vs. baseline 12 tools / 60 s / $0.16.

Why it works is not mysterious. In a rename-class task the substrate owns 100% of the resolution problem: the reference graph already knows every use site, one tool call expresses the whole intent, and the agent contributes exactly one scalar (the new name). The file agent must reconstruct that reference graph with grep and judgment, then express it as N fragile text edits.

## The honest complement: where files win

Here is the part most write-ups would bury. We ran the same paired harness on tasks *outside* the bulk-propagation class, and the substrate **lost**:

- **Single extraction** (pull a loop into a helper): baseline $0.097 vs. substrate $0.117 — file tools cheaper, fewer calls, faster (N=1). Both correct.
- **Compound task** (extract, then rename the helper, then add a parameter to it): baseline $0.100 vs. substrate $0.209 — the substrate did *worse* on the compound than on the simple task (N=1).

The compound result is the diagnostic one. We had hypothesized chained graph ops would favor the substrate. Wrong — and the transcript shows why: a freshly extracted helper has exactly **one** caller, so no follow-on operation is bulk. The file agent folds the whole compound into ~3 text edits; the substrate pays transaction + validate + commit ceremony per operation with no fan-out to amortize it against.

That yields the rule:

> **The structural substrate's cost advantage is specific to bulk propagation over many existing references. When the hard part of a task is propagating one decision through a reference graph (rename, move, parameter fan-out), structure wins by 2–5×. When the hard part is synthesizing new code at a single site, text wins, because text is a perfectly good interface for one site.**

Structural tools for the synthesis class (`extract_function`, `create_function`) still earn their place — but on **correctness** (inferred parameters/returns, hazard rejection, the commit gate) and on making new code a graph citizen for *future* bulk ops. Not on cost. We say so in the product copy.

## The sharpest boundary: tasks the substrate cannot honestly win

One benchmark task (add a parameter whose *value differs per call site*) failed 0/3 — and we spent more effort characterizing that negative than celebrating the positive. Four independent, pre-registered, transcript-classified levers were tried and falsified: prompt/description tuning, a behavioral commit gate, model capability (the strongest available model failed identically), and tool-result legibility (an audit-proof manifest of exactly what the tool did, which the agent received and ignored — it hand-patched call sites the tool had already updated, collided with its own edits, and never converged).

A fifth lever (per-call-site expressiveness in the tool signature) was designed and then terminated on integrity grounds: the task's success criterion requires a literal that exists *only in the prompt*, so any "win" would be the agent transcribing a prompt-supplied map into a tool slot — scripting, not structure. That termination sharpened the taxonomy rather than weakening it: the substrate wins when it owns the resolution and the agent owns one decision. It structurally cannot win when the task embeds a per-site decision that lives nowhere in the graph.

## The original question: many agents, one shared green codebase

Everything above was staging — necessary, but staging. Strata was never primarily a bet about making one agent cheaper; the reason to make the codebase a canonical graph with typed operations was always **coordination**: multiple agents working in one codebase *simultaneously* — no branches, no worktrees, no integration agent merging text — because the substrate can infer what each operation touches and schedule around conflicts. The single-agent rounds had to come first: they proved the substrate works end-to-end and mapped where structure actually pays. With that established, Phase 6 asked the original question directly.

The mechanism is a Rust coordination kernel (redb-backed, memory-native, a sealed single-owner daemon) in front of the existing TypeScript ingest/render/verify pipeline, which stays authoritative. Agents submit **typed operations** (rename, add-parameter, …); the kernel infers each operation's reservation scope from the reference graph — agents never enumerate lock keys — grants deterministic leases, validates candidates against a fresh view, and publishes with fencing. Grouped changes commit only-green-together. If a concurrent publication invalidates the scope an agent decided under, the agent gets a `needs_decision` naming every renamed symbol and re-decides against the fresh view rather than merging text.

Before any model spend, the whole thing passed a **deterministic, key-free acceptance gate**: twelve pre-named rows covering independent clients, inferred overlap and dynamic scope expansion, logical-tick fairness, restart/fencing/event resumption, only-green-together publication, real process-crash joins, and byte-exact replay. Only then came the live comparison: two concurrent agents, same model, same orchestrator, same corpus, same final tsc + test acceptance, against the strongest practical baseline — **git worktrees plus an integration agent**, with the integration agent's time and tokens counted in the baseline arm. Six pre-registered scenarios: disjoint modules (D), grouped only-green-together (G), same-module (M), reference-mediated overlap (R), same-node overlap (S), and dynamic scope expansion (X). The pre-registered falsification criterion: any silent overwrite, dirty read, partial commit, or rollback that changes another session's committed state falsifies the proof regardless of speed.

Across a pilot, a retry round, and an N=3 directional round (total scored spend ≈ USD 24), none of those falsifiers ever occurred, and the direction never wavered. In the N=3 round, **all five evaluable scenarios came out `+++` on both cost and makespan** — every one of the 30 evaluable scenario×metric×trial cells favored Strata strictly, no reversal, no tie — with Strata arms 18/18 green:

| Scenario (N=3) | Cost margin (baseline/Strata) | Makespan margin |
|---|---|---|
| D — disjoint modules | 6.5–10.6× | 9.6–9.7× |
| G — grouped, only-green-together | 4.7–7.1× | 17.3–25.6× |
| M — same module, concurrent publish | 2.5–8.1× | 7.6–22.9× |
| R — reference-mediated overlap | 3.8–10.7× | 5.2–14.5× |
| S — same-node overlap | 4.7–6.1× | 4.6–5.4× |

The sixth scenario, X (dynamic scope expansion), produced the round's most interesting asymmetry: the Strata arm completed it live 4 times out of 4 attempts under the final protocol — including the fresh-decision content rewrite after a concurrent rename invalidated its scope — while the worktree baseline **never completed it once** (seven failures across all rounds, every one the same class: the integration-side agent over-delivering beyond the registered spec). X therefore contributes zero paired comparisons by design; the baseline's failure mode is itself the registered observation.

Why the margins are larger than the single-agent ones: the worktree baseline pays twice. Each worker still does the file-agent's reconstruct-references-with-grep work, *and then* an integration agent (budgeted at up to 40 turns / 420 s per round in the registered bounds) re-derives both changes to merge them. The kernel arm has no integration step at all — the graph already knows the overlap, so conflicting work serializes behind an inferred lease instead of being merged after the fact. The makespan margins on G (17–26×) are the purest expression: a grouped change that must land atomically is one fenced kernel publication, versus a worktree merge-and-revalidate cycle.

The claims are deliberately narrow: **directional consistency at N=3** under one model, one corpus, one seed, one machine — no effect sizes, no significance, no generality claim. One provenance caveat is disclosed in the evidence doc: the scored round was the third launch, after two byte-identical attempts were killed mid-round by the operator's terminal supervisor (~USD 13, disclosed); the killed partials' 13 evaluable pairs were all `+`/`+` too, so the aborted attempts corroborate rather than complicate the direction. Full chain: [design](superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md) → [deterministic acceptance](spikes/2026-07-15-deterministic-full-key-free-acceptance.md) → [pilot](spikes/2026-07-17-phase-6-live-pilot-results.md) → [retry](spikes/2026-07-18-phase-6-live-xm-retry-results.md) → [N=3 round](spikes/2026-07-18-phase-6-n3-directional-results.md).

## Why you can believe these numbers

The methodology is the credibility, so it gets its own section:

- **The harness was attacked, not flattered.** It caught its own scorer contamination (a shared fixture made the gate unsatisfiable and silently coupled tasks), its own scorer artifact (a criterion that failed a valid answer and passed a wrong-reason one — root-caused, corrected, independently audited), and three installed-SDK-vs-docs gaps, including ambient MCP tools leaking into the "no tools" agent. Each was stopped on and fixed, never papered over.
- **Keyed rounds were pre-registered.** Bail-signal criteria were written down tamper-evidently *before* spending, and outcomes were classified from full transcripts, not aggregate metrics.
- **Negatives were published with the same rigor as positives.** The decision log records every falsified hypothesis, including the ones that would have made a better story.
- **The multi-agent proof was gated before it was measured.** Deterministic, key-free acceptance (twelve named rows, including crash-recovery and byte-exact replay) had to pass before any live spend; the live rounds ran under a frozen task manifest, a seeded counterbalanced schedule, a pre-registered sign taxonomy and failure accounting, and an approval-locked budget guard. Deviations (two environmentally killed relaunches) are disclosed in the evidence doc rather than absorbed.

## Where this sits in prior art

"Code as a database" is not a new idea; measuring what it does for an *agent* is. Four lineages are adjacent, and the differences position the contribution:

**Code as the store, not files.** Smalltalk images did this in the 1970s — code lives in a live image, browsed and edited at method granularity; files were never the unit of work. Unison is the modern flagbearer: every definition is content-addressed by the hash of its AST, names are metadata, and the "codebase" is literally a database — which makes rename a free metadata edit. Projectional editors (JetBrains MPS commercially; Hazel in research) store the AST and merely *project* text; Dark and Dion Systems explored the same inversion. All of these are **human-facing**, and Unison achieves its properties by being a **new language**. Strata borrows the inversion — graph canonical, text derived — but applies it to stock TypeScript with an agent as the only client, and measures the economics. It is telling that the operation Unison gets for free (rename) is exactly the one where we measure the largest agent win: independent evidence that this task class is substrate-shaped.

**Code graphs as derived indexes.** Kythe (Google), Glean (Meta), SCIP/Sourcegraph, GitHub's stack graphs, CodeQL, and Joern all build precise, queryable reference graphs over large codebases. But they are **read-only derivatives**: files remain canonical, and the graph is rebuilt from them. Strata inverts the arrow — the graph is the source of truth and the *mutation* surface, with transactions, a validating commit gate, and an operation log as history. The read-side query vocabulary (find declarations, list references) is deliberately familiar from these systems.

**Structural transformation over files.** The refactoring operations themselves are old: IDE engines (IntelliJ's PSI, Roslyn workspaces, the TypeScript language service) implement rename/extract/move behind APIs, and LSP exposes some of them to any client. Batch tools — codemods (jscodeshift, ts-morph), comby, ast-grep, GritQL, OpenRewrite's lossless semantic trees — do structural rewrites at scale, human- or CI-driven. Strata's tool vocabulary is intentionally the same one developers already say in English; what's different is agent-native addressing (stable node IDs as the join key across every tool call), transactionality with a validation gate the agent cannot bypass, and no file fallback to leak text edits through.

**Agent–code interfaces.** The closest empirical prior art: SWE-agent's "agent-computer interface" work showed that interface design materially changes agent outcomes — for *file* tools. Since then the field has converged on hybrid reads: repo maps (Aider), embedding indexes (Cursor-class tools), LSP/MCP bridges, and graph-database navigation for LLM agents (e.g., CodexGraph) — all of which give agents structural *reads* while text edits stay canonical. Strata runs the limit case — no files at all — as a controlled experiment, and contributes the piece the hybrid systems can act on: a measured boundary for *which* operations belong behind structural tools (bulk propagation) and which don't (single-site synthesis).

## Limitations

N is small everywhere (1–3 per configuration); everything above is reported as observed separation or directional consistency, not significance. One corpus family (~3–5k LOC) plus two external dogfoods; one language (TypeScript, leaning on the TS compiler API); primarily one model family. The multi-agent result is additionally bounded to two concurrent agents, six scenario shapes, one seed, and one machine, with candidate validation scoped to the corpus's `src/**` projection. The substrate is research-grade: persistence works, incremental re-ingest doesn't yet; the tool surface is 20 operations, not 200.

## What this implies (the part we'd want builders to take away)

The evidence does **not** say "abandon files." It says the optimal coding agent is **hybrid**: text tools for synthesis and local edits (where they're already cheap), plus structural operations for bulk propagation (where text agents burn 3–5× the work reconstructing what a graph already knows). The pure no-filesystem agent was the right *experimental control* — it isolated the interface variable — but the product-shaped conclusion is that rename/move/param-fan-out belong behind structural tools backed by a resolved reference graph, even inside an otherwise file-based agent.

For tool builders, three transferable findings:

1. **Give the agent operations that own their blast radius.** `rename_symbol` wins because the tool, not the model, resolves every affected site. Tools that leave resolution to the model forfeit the advantage.
2. **A validating commit gate turns "confidently wrong" into "blocked with a reason."** Gating commits on type-check plus the task's own tests converted one failing task class into a 3/3 pass — as a correctness mechanism, not an efficiency one.
3. **Agents distrust tools whose effects they can't see — and evidence alone doesn't fix it.** Our agent repeatedly hand-patched call sites a tool had already updated, even when handed an itemized manifest of the tool's edits. Interface legibility is necessary but not sufficient; this looks like a training-distribution prior, and it bounds what tool design alone can achieve today.
4. **Concurrency belongs in the substrate, not in git.** When operations are typed, their blast radius is inferable — which means conflict handling can move from *merge-after-the-fact* (worktrees plus an integration agent re-deriving both changes) to *schedule-before-the-fact* (leases inferred from the reference graph, fresh-decision on invalidation). In our rounds that eliminated the entire integration step, and it eliminated the merge-conflict failure class by construction rather than by model skill.

## Try it

```bash
npm i -g @strata-code/cli                    # published packages, no key needed
strata modules ./your-ts-project             # explore the graph
strata find ./your-ts-project User
strata refs ./your-ts-project <nodeId>       # the thing files can't do
# with ANTHROPIC_API_KEY — run the no-filesystem agent on any TS corpus:
strata agent ./your-ts-project "Rename the exported interface User to Account everywhere it is referenced" --print
```

Or from source: `git clone https://github.com/ToddHebebrand/strata && cd strata && pnpm install && pnpm -r build && pnpm -r test` — the full suite runs without a key.

The full design ([`strata-design.md`](../strata-design.md)), the complete decision trail including every falsified lever ([`decisions.md`](../decisions.md)), and the detailed results ([`RESULTS.md`](RESULTS.md)) are in the repo.
