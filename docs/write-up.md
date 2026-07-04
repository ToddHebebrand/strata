# When does a structural substrate beat files? Measuring an agent-native alternative to the file abstraction

*Todd Hebebrand · July 2026 · [github.com/ToddHebebrand/strata](https://github.com/ToddHebebrand/strata) · MIT. Every number below is sourced from [`RESULTS.md`](RESULTS.md) and the append-only decision log ([`decisions.md`](../decisions.md)); N is stated everywhere because most of it is small.*

## The bet

AI coding agents inherit an interface designed for humans: files. To change one function, an agent reads a whole file. To express a structural change — rename this symbol, add this parameter everywhere — it emits text diffs and hopes they apply. To find every use of a declaration, it greps and reasons about false positives. The file abstraction exists because humans read linearly; agents don't have that constraint.

Strata is the experiment: replace files entirely. A TypeScript codebase becomes a SQLite-backed graph of nodes — modules, declarations, statements, identifiers — with stable IDs and resolved reference edges. An agent (Claude Agent SDK, **no filesystem tools at all**) queries and mutates that graph through ~20 structural tools inside transactions. A commit gate renders the pending graph to text, type-checks it in-process, and optionally runs the task's tests; commits that fail are refused. Files exist only as transient compiler artifacts the agent never sees.

The hypothesis was simple: same model, same task, same success bar — the structural substrate should reach the right answer with materially less work.

The answer turned out to be more interesting than yes or no. **The substrate wins big on exactly one class of task, loses on its complement, and the boundary between them is sharp enough to state as a rule.**

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

## Why you can believe these numbers

The methodology is the credibility, so it gets its own section:

- **The harness was attacked, not flattered.** It caught its own scorer contamination (a shared fixture made the gate unsatisfiable and silently coupled tasks), its own scorer artifact (a criterion that failed a valid answer and passed a wrong-reason one — root-caused, corrected, independently audited), and three installed-SDK-vs-docs gaps, including ambient MCP tools leaking into the "no tools" agent. Each was stopped on and fixed, never papered over.
- **Keyed rounds were pre-registered.** Bail-signal criteria were written down tamper-evidently *before* spending, and outcomes were classified from full transcripts, not aggregate metrics.
- **Negatives were published with the same rigor as positives.** The decision log records every falsified hypothesis, including the ones that would have made a better story.

## Where this sits in prior art

"Code as a database" is not a new idea; measuring what it does for an *agent* is. Four lineages are adjacent, and the differences position the contribution:

**Code as the store, not files.** Smalltalk images did this in the 1970s — code lives in a live image, browsed and edited at method granularity; files were never the unit of work. Unison is the modern flagbearer: every definition is content-addressed by the hash of its AST, names are metadata, and the "codebase" is literally a database — which makes rename a free metadata edit. Projectional editors (JetBrains MPS commercially; Hazel in research) store the AST and merely *project* text; Dark and Dion Systems explored the same inversion. All of these are **human-facing**, and Unison achieves its properties by being a **new language**. Strata borrows the inversion — graph canonical, text derived — but applies it to stock TypeScript with an agent as the only client, and measures the economics. It is telling that the operation Unison gets for free (rename) is exactly the one where we measure the largest agent win: independent evidence that this task class is substrate-shaped.

**Code graphs as derived indexes.** Kythe (Google), Glean (Meta), SCIP/Sourcegraph, GitHub's stack graphs, CodeQL, and Joern all build precise, queryable reference graphs over large codebases. But they are **read-only derivatives**: files remain canonical, and the graph is rebuilt from them. Strata inverts the arrow — the graph is the source of truth and the *mutation* surface, with transactions, a validating commit gate, and an operation log as history. The read-side query vocabulary (find declarations, list references) is deliberately familiar from these systems.

**Structural transformation over files.** The refactoring operations themselves are old: IDE engines (IntelliJ's PSI, Roslyn workspaces, the TypeScript language service) implement rename/extract/move behind APIs, and LSP exposes some of them to any client. Batch tools — codemods (jscodeshift, ts-morph), comby, ast-grep, GritQL, OpenRewrite's lossless semantic trees — do structural rewrites at scale, human- or CI-driven. Strata's tool vocabulary is intentionally the same one developers already say in English; what's different is agent-native addressing (stable node IDs as the join key across every tool call), transactionality with a validation gate the agent cannot bypass, and no file fallback to leak text edits through.

**Agent–code interfaces.** The closest empirical prior art: SWE-agent's "agent-computer interface" work showed that interface design materially changes agent outcomes — for *file* tools. Since then the field has converged on hybrid reads: repo maps (Aider), embedding indexes (Cursor-class tools), LSP/MCP bridges, and graph-database navigation for LLM agents (e.g., CodexGraph) — all of which give agents structural *reads* while text edits stay canonical. Strata runs the limit case — no files at all — as a controlled experiment, and contributes the piece the hybrid systems can act on: a measured boundary for *which* operations belong behind structural tools (bulk propagation) and which don't (single-site synthesis).

## Limitations

N is small everywhere (1–3 per configuration); everything above is reported as observed separation, not significance. One corpus family (~3–5k LOC) plus two external dogfoods; one language (TypeScript, leaning on the TS compiler API); primarily one model family. The substrate is research-grade: persistence works, incremental re-ingest doesn't yet; the tool surface is 20 operations, not 200.

## What this implies (the part we'd want builders to take away)

The evidence does **not** say "abandon files." It says the optimal coding agent is **hybrid**: text tools for synthesis and local edits (where they're already cheap), plus structural operations for bulk propagation (where text agents burn 3–5× the work reconstructing what a graph already knows). The pure no-filesystem agent was the right *experimental control* — it isolated the interface variable — but the product-shaped conclusion is that rename/move/param-fan-out belong behind structural tools backed by a resolved reference graph, even inside an otherwise file-based agent.

For tool builders, three transferable findings:

1. **Give the agent operations that own their blast radius.** `rename_symbol` wins because the tool, not the model, resolves every affected site. Tools that leave resolution to the model forfeit the advantage.
2. **A validating commit gate turns "confidently wrong" into "blocked with a reason."** Gating commits on type-check plus the task's own tests converted one failing task class into a 3/3 pass — as a correctness mechanism, not an efficiency one.
3. **Agents distrust tools whose effects they can't see — and evidence alone doesn't fix it.** Our agent repeatedly hand-patched call sites a tool had already updated, even when handed an itemized manifest of the tool's edits. Interface legibility is necessary but not sufficient; this looks like a training-distribution prior, and it bounds what tool design alone can achieve today.

## Try it

```bash
git clone <repo> && cd strata && pnpm install && pnpm -r build && pnpm -r test   # no key needed
node packages/cli/dist/cli.js modules examples/medium        # explore the graph
node packages/cli/dist/cli.js find examples/medium User
node packages/cli/dist/cli.js refs examples/medium <nodeId>  # the thing files can't do
# with ANTHROPIC_API_KEY — run the no-filesystem agent on any TS corpus:
node packages/cli/dist/cli.js agent examples/medium "Rename the exported interface User to Account everywhere it is referenced" --print
```

The full design ([`strata-design.md`](../strata-design.md)), the complete decision trail including every falsified lever ([`decisions.md`](../decisions.md)), and the detailed results ([`RESULTS.md`](RESULTS.md)) are in the repo.
