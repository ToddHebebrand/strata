# Decisions

A running log of build-time decisions for Strata. Append-only. Newest at the top.

Log an entry whenever:
- A choice diverges from `strata-design.md` (swapped library, changed schema, dropped/added scope, different tool shape).
- A spec-level question from § "Open design questions" gets resolved.
- A non-obvious trade-off is made that a future reader would otherwise have to re-derive.

## 2026-05-27 — Fix-C: JSDoc corpus guard added to examples/medium; T03 substrate-win claim corrected

**What changed:** Added a real JSDoc block above `export interface User` in `examples/medium/src/types/user.ts`:

```typescript
/**
 * Represents a user of the system.
 * @internal
 */
export interface User { … }
```

Prior to this change, `User` had no JSDoc above it. That meant every prior T03 run — including all bench rounds that produced the "T03 is a substrate win" headline — ran on a corpus where `find_declarations` and its five sibling functions (`find_references`, `find_callers`, `find_incoming_refs`, `find_outgoing_refs`, `query_nodes`) never exercised the JSDoc-offset bug fixed in commits `a2e19b3`/`f752671`/`90961fc`/`d4f3fcf`.

**The bug (Fix-A/B, summarized):** `find_declarations` selected the lowest-offset tree-sitter `Identifier` node inside an `InterfaceDeclaration` (or any declaration kind). When a JSDoc block appears above the declaration, tree-sitter emits `Identifier` nodes for each JSDoc tag word (e.g. `internal` from `@internal`) at lower source offsets than the actual declaration name. The lowest-offset picker returned a JSDoc tag word instead of the interface name — wrong identifier, wrong rename target.

**The fix shape:** A `pickDeclName` parser-offset helper was introduced that locates the declared name by walking children of the declaration node and finding the first `Identifier` that is at or after the declaration's own start offset, not just globally minimal. Six sibling call sites in `packages/store/src/store.ts` were updated to use this helper. The store test suite reached 95 tests green.

**Codex review:** An independent xhigh Codex review was conducted in-session on 2026-05-27. Brief at `/tmp/codex-brief-find-declarations.md`. The review recommended adding the JSDoc guard to the bench corpus before closing Fix-C, specifically noting that the prior T03 success was silently conditioned on the corpus being JSDoc-free above the renamed declaration.

**T03 substrate-claim correction:** The "T03 is a substrate win" claim (multi-trial bench results recorded in earlier decisions.md entries and in `docs/product-roadmap.md`) remains directionally correct, but it had an unspoken caveat: the corpus happened to be JSDoc-free above `User`. The claim should now be read as: "T03 is a substrate win, and now verified against a JSDoc-annotated corpus." With the Fix-A/B patch applied, T03 passes on the JSDoc-guarded corpus with all 11 criteria true (`commitReturnedOk`, `validateAfterCommitClean`, `importRenamed`, `typeAnnotationRenamed`, `genericPromiseRenamed`, `namespaceImportRenamed`, `auditLiteralUntouched`, `auditLiteralOnlyRemainingUser`, `indexReExportRenamed`, `jsdocReferencesRenamed`, `operationRowAppended`).

**Why no prior test caught this:** The 95 store tests added in Fix-A/B were synthetic; none used `examples/medium` directly. The T03 acceptance test in `packages/cli/tests/t03.test.ts` ingests the real corpus but the corpus was JSDoc-free, so the broken path was never executed.

**Tried first:** Considered adding JSDoc to a second declaration (not `User`) to stress a non-rename path. Rejected — the scope of Fix-C is the corpus guard for the established T03 benchmark target, not broad corpus enrichment. Drive-by JSDoc additions to other declarations are deferred.

**What was decided:**
1. `examples/medium/src/types/user.ts` now carries a real `/** ... @internal */` block above `User`. This is the only corpus change in Fix-C; no other declarations in `examples/medium` were JSDoc-annotated.
2. T03 passes on the new corpus state; all 68 tests across `packages/cli` (7) and `packages/bench` (62) remain green; no fixture updates were needed.
3. **Forward-looking:** future bench corpora should include JSDoc-prefixed declaration targets by default. A corpus without JSDoc above any target can silently mask the JSDoc-offset class of bugs. The guard is now established; any corpus regression that removes the JSDoc block will be immediately visible in T03.

**Design-doc impact:** none on `strata-design.md`. Bench-corpus shape is an implementation detail, not a design contract.

**Pointer to change:** `examples/medium/src/types/user.ts`, commits for this entry.

---

## 2026-05-27 — L3.4 paired dogfood (N=1, two rename-class tasks on examples/medium): the substrate compounds — all four acceptance criteria PASS

**Context:** First operator run of the L3 "operation-log as memory" dogfood after building L1+L2+L3. Two rename-class tasks on the same persistent SQLite DB:
- Arm A (cold DB): rename `User` → `Account` (the T03 prompt).
- Arm B (same DB, after A): rename `Clock` → `TimeSource` (similar shape, different module).

Both keyed: `ANTHROPIC_API_KEY` for the agent, `STRATA_EMBED_API_KEY` (OpenAI text-embedding-3-small) for L3 commit-pattern embedding. Same model (`claude-sonnet-4-6`), same bounds, same corpus.

**Numbers (N=1 paired):**

| Metric | Arm A (cold) | Arm B (post-A) | B / A |
|---|---:|---:|---:|
| Cost USD | $0.0757 | $0.0411 | **54.3%** |
| Cache read input | 62,796 | 59,051 | 94.0% |
| Cache creation input | 9,856 | 2,658 | 27.0% |
| Tool calls | 8 | 6 | 75.0% |
| Turns | 9 | 7 | 77.8% |
| Wall ms | 26,263 | 19,033 | 72.5% |
| Total tokens (non-cached) | 1,262 | 814 | 64.5% |

**Telemetry verified the L3 path activated end-to-end:**
- `commit_pattern_embed` fired with `ok=true` in Arm A → the pattern (prompt + ops + modules + declarations) was JSON-stringified, embedded via OpenAI, and persisted to `commit_pattern_embeddings` (vec0) + `commit_pattern_meta`.
- `past_tasks_injected` fired with `count=1` in Arm B → `retrieveSimilarPastTasks` matched A's pattern against B's prompt and injected a "Past tasks like this one" section between L1's codebase shape and the user prompt.

Both arms succeeded with one operation committed each.

**Finding:** The substrate compounds. Arm B was cheaper than Arm A on every metric the harness tracks, and the L3 telemetry confirms the design's intended path executed. The plan L3.4 acceptance ("B's cost < A's cost") clearly holds.

**Two confounds in the N=1 reading (honest scope, not enough to retract the finding):**
1. **Task-size confound.** `Clock` has fewer references in `examples/medium` than `User`, so Arm B is structurally a smaller task. Some fraction of the 46% cost drop is "B is easier," not L3.
2. **Cache-warmth confound.** Arm B ran ~10 seconds after Arm A — within Anthropic's 5-minute prompt-cache TTL, so B benefits from cached system-prompt tokens that a cold B-run wouldn't have. Note the cache-creation drop (9,856 → 2,658) is too large to be cache warmth alone, but some of the cache-read symmetry (62,796 → 59,051) is.

To isolate L3's contribution from both confounds, a third arm would help: rename `Clock` → `TimeSource` on a fresh DB (no L3 memory) and compare its cost to Arm B's. Not run today — N=2 paired data points are enough for a first PASS, and per CLAUDE.md "do not chase N=2 noise into product claims" the conservative read is "L3 mechanism works and the cost direction is right." A control arm is filed as a follow-up when a specific falsifiable question demands it.

**Decided:**
1. L3 stays in. The mechanism is verified, the cost direction is right, and the design's "compounding" claim is supported at N=1 with explicit confound caveats.
2. The L3.4 harness reports four independent acceptance lines (both commits ok, L3 wrote, L3 retrieved, cost compounded). All four passing simultaneously is the strict signal; a future regression that breaks one but not the others is now diagnosable.
3. The harness's "honest read" note already documents both confounds in every emitted markdown, so future readings won't accidentally over-claim.

**Tried first:** considered running the same task twice (rename User → Account, reset corpus state between runs). Rejected because L3 retrieves on exact prompt match — that tests retrieval-by-prompt but not "similar shape generalization." The parallel-but-different design (User-rename then Clock-rename) is closer to the design doc's claim.

**Honest scope:**
- N=1, one paired trial.
- One corpus (`examples/medium`).
- One model (`claude-sonnet-4-6`) on one calendar day's pricing.
- The two confounds above. Most likely interpretation: L3 contributes a real but not-entirely-isolable fraction of the 46% drop; the rest is task-size + cache warmth.

**Design-doc impact:** none. The design's compounding claim is supported.

**Revisit when:** (a) the L2.5 dogfood lands on a corpus where semantic_search is active — the three layers stack and we can see whether L2+L3 compounds further; (b) someone outside the project tries it and the compounding question becomes a real product question rather than a research one.

### Same-day control arm (2026-05-27, same model + bounds + corpus)

Ran `Clock → TimeSource` on a fresh DB with `STRATA_EMBED_API_KEY` unset (L3 disabled — no commit-pattern writes, no retrieval). L1 still on. Result: `success`, lastCommitOk=true, 1 op.

| Run | DB state | L3 | Cost USD | Tool calls | Turns | Wall ms |
|---|---|---|---:|---:|---:|---:|
| Arm A (cold) | fresh | n/a (User rename) | $0.0757 | 8 | 9 | 26,263 |
| Arm B (post-A) | populated | retrieved 1 pattern | $0.0411 | 6 | 7 | 19,033 |
| Control (B-cold) | fresh | disabled | **$0.0423** | 7 | 8 | 17,975 |

**Decomposition of the A → B 46% cost drop:**

| Component | Cost saved | Share |
|---|---:|---:|
| Task-size (Clock < User), measured as Control vs A | $0.0334 | 96% |
| L3 retrieval, measured as B vs Control | $0.0012 | 4% |

**Revised honest reading at N=1:**
- The L3 mechanism activates end-to-end (telemetry confirmed in Arm B). That is a real positive signal.
- Once task-size is controlled for, the isolated L3 effect on this corpus is ~3% cost savings, 1 fewer tool call, 1 fewer turn vs L1-alone. Small. Not nothing, but small.
- The "B is 54% of A" headline in the harness markdown was overwhelmingly task-size, not L3. The harness's "honest read" note already flagged both confounds, but the headline number is misleading without this decomposition.
- L3's compounding value almost certainly scales with corpus size (where L1 can't dump everything), pattern count (more retrievable history), and task novelty (where past patterns reveal non-obvious target modules). None of those are stressed in this dogfood — examples/medium is 22 modules, one past pattern, two highly-parallel rename tasks. So the modest isolated L3 effect here is consistent with the design *and* with the design having a much weaker N=1 signal on small corpora than the unconfounded number suggested.

**Updated decision:** L3 stays in (mechanism works, direction is correct), but the dogfood-result interpretation in the harness's emitted markdown should NOT be quoted as "L3 saves 46% on the second task" — that's wrong. The correct N=1 quote is "L3 mechanism works end-to-end; isolated L3 contribution at N=1 on this small corpus is ~3% cost." The harness's existing "honest read" note prevents the wrong quote in any future markdown we emit, but anyone reading the existing 2026-05-27 dogfood markdown should also read this decisions.md entry.

**Revisit when:** L2.5 dogfood lands on a corpus where L1 alone is too expensive to inject fully — that's where L3's "where did past tasks touch" should genuinely save discovery overhead, not just slightly nudge it. If L3 still only saves ~3% there, the design's "substrate compounds" claim is weaker than the design doc suggests and worth re-scoping.

---

## 2026-05-27 — T05 substrate-vs-file-baseline (N=1): substrate+L1 at ~51% baseline cost; "5× tokens" claim in roadmap is stale

**Context:** Followup to the same-day L1.4 dogfood (entry below). Question: is Strata+L1 still more expensive than a plain file-tools Claude Code baseline on T05 — the task the 2026-05-26 roadmap pinned as "substrate ~5× tokens, graph navigation is dead weight"?

**Method:** Ran `strata baseline examples/medium "<T05 prompt>"` once. Same model (`claude-sonnet-4-6`), same prompt, same corpus, same day, file-tools agent on a temp clone. Result: `success` + `tscClean` + `vitestPassed`. Compared against the two arms of the same-day L1.4 dogfood.

**Three-way comparison (all three N=1, all three succeeded):**

| Metric | baseline (file tools) | Strata index-off | Strata index-on |
|---|---:|---:|---:|
| Cost USD | $0.0795 | $0.0652 | **$0.0409** |
| Total tokens (non-cached) | 783 | 1,123 | 1,012 |
| Output tokens | 776 | 1,114 | 1,004 |
| Cache read input | 52,057 | 49,315 | 50,072 |
| Cache creation input | 13,774 | 8,855 | 2,622 |
| Tool calls | 5 | 7 | 6 |
| Turns | 6 | 8 | 7 |
| Wall ms | 35,930 | 24,916 | 20,871 |

**Finding:**
- **Strata+L1 is ~51% the cost of the file-tools baseline** on T05 ($0.0409 vs $0.0795), ~42% faster on wall time.
- Strata uses ~29% MORE non-cached tokens than baseline (1,012 vs 783) but creates 81% LESS cache (2,622 vs 13,774). Cache-creation pricing (~3.75× cache-read) dominates the total. The structural tools return compact payloads; file tools dump whole file bodies into context which then has to be cache-created.
- Baseline uses the fewest tool calls (5). T05 is genuinely local ("open one file, fix one line"), so file tools have a structural advantage on tool count. Strata loses on tool count but wins on cost-per-tool-call.
- Even Strata index-off ($0.0652) is ~18% cheaper than baseline. So the substrate beats baseline on T05 even before the L1 layer.

**Decided:**
1. **Roadmap update:** the "T05 substrate costs ~5× tokens, dead weight" framing in `docs/product-roadmap.md` § "Stable signal" is stale and now marked as such. The 5× number was 2026-05-16, pre-iteration-3 tools (`read_test_file`, `list_module_exports`, `find_declarations_in_module`). Token ratio is now 1.29×, not 5×, and cost ratio is 0.51×. The line is reframed as "stale signal under review" rather than overwritten — N=1 is not enough to claim "substrate beats baseline on T05 generally."
2. **No claim escalation in README.** The README's headline result stays the T03 multi-trial finding. This T05 result is N=1 paired and is not strong enough evidence to put in the README.
3. **Not running more T05 trials right now.** N=2 would still be noise per CLAUDE.md. If a real product question (e.g. "does this hold across models?", "does Anthropic's cache pricing change the calculus?") creates a falsifiable hypothesis, then a 3-trial paired round is justified. Until then, N=1 is N=1.

**Tried first:** I had assumed the prior roadmap claim was still accurate. The L1.4 dogfood's cost number ($0.0409 for L1-on) made me question that, but the L1.4 dogfood doesn't include a baseline arm. Adding one was a single CLI invocation away.

**Honest scope:**
- One task (T05). T03/T08/T01 not re-measured today; their roadmap claims may also be stale.
- One corpus (`examples/medium`, ~22 modules). Different corpora can shift the cache/non-cache split.
- One model + one calendar day's cache pricing.
- Strata index-off ran first in the L1.4 pair; baseline ran later. Cache warmth between arms isn't directly comparable across the three runs since they were separate processes — but the prompt-cache TTL is 5 minutes, and the three runs were within that window, so similar warmth is a defensible read.

**Design-doc impact:** none on `strata-design.md`. Roadmap claim about T05 reframed in-place.

**Revisit when:** (a) another tool surface change lands that should affect T05 cost shape; (b) Anthropic's cache pricing ratio changes materially; (c) an explicit hypothesis about T05 substrate behavior demands a multi-trial paired round.

---

## 2026-05-27 — L1.4 paired dogfood (N=1, T05 on examples/medium): L1 wins on every metric except the one I picked as acceptance

**Context:** First operator run of the L1.4 paired dogfood after building the L1/L2/L3 codebase index (specs `docs/specs/2026-05-26-three-layer-codebase-index-*.md`). Harness: `pnpm --filter @strata/bench dogfood:l1 -- examples/medium`. Both arms used `claude-sonnet-4-6`, the T05 prompt, the T05 behavioral fixture as commit gate. Index-off ran first to give index-on the conservative read on cache warmth.

**Raw numbers (single paired trial, both arms `success` + `lastCommitOk=true` + 1 op committed):**

| Metric | index-off | index-on | on / off |
|---|---:|---:|---:|
| Total tokens (input+output, non-cached) | 1,123 | 1,012 | **90.1%** |
| Output tokens | 1,114 | 1,004 | 90.1% |
| Cache read input | 49,315 | 50,072 | 101.5% |
| Cache creation input | 8,855 | 2,622 | **29.6%** |
| Tool calls | 7 | 6 | 85.7% |
| Turns | 8 | 7 | 87.5% |
| Wall ms | 24,916 | 20,871 | 83.8% |
| Cost USD | $0.0652 | $0.0409 | **62.8%** |

Module index size: 1,971 chars / 28 lines. Both arms succeeded with identical operation counts.

**Finding:** the design's central claim ("L1 collapses speculative discovery") is supported on every metric — tool calls, turns, wall time, cache creation, and total cost all dropped. The only metric where the index-on win is small (10%) is "total tokens" (input+output, non-cached), and that's because essentially all input was cached (9 and 8 non-cached input tokens respectively across the two arms). Output is model-reasoning weight and doesn't shrink as dramatically as raw input fetches. So "total tokens" is the wrong acceptance metric on this kind of task — it's dominated by the component the index can't move.

**Decided:**
1. Harness now reports a richer table (already does) and uses **cost USD ≤ 80% of off** as the primary acceptance threshold (which would have PASSED at 62.8%) instead of total tokens (which FAILED at 90.1%). Cost USD correctly blends input + output + cache-creation + cache-read pricing in the proportions Anthropic actually charges; total tokens is a noisy proxy that ignores the cache axis entirely.
2. The L1.4 plan acceptance bullet (`Index-on cost ≤ 80% of index-off cost on this single comparison`) is preserved verbatim — "cost" was already the right word in the plan; my harness implementation chose the wrong column to threshold on.
3. **Not** retrying for a different number. N=1 with a one-op success on both sides is the read. Per CLAUDE.md "do not chase N=2 noise into product claims."

**Tried first:** ran the harness with total-tokens-as-acceptance. It FAILed (90.1% vs 80% threshold) even though every other metric showed a clean win. Reading the columns revealed the cache-vs-non-cached split that made "total tokens" the wrong threshold.

**Honest scope of this finding:**
- One task (T05, single-test fix on examples/medium). The L1 win shape on a rename-heavy task (T03) or a multi-module discovery task could look quite different.
- One corpus (examples/medium, ~22 modules). On corpora where the L1 index becomes itself expensive (>100 modules), the calculus changes — that's L2's domain (semantic_search), not L1's.
- One model (claude-sonnet-4-6) on one calendar day. Cache pricing changed in the past and may change again; an acceptance threshold pinned to USD is more pricing-stable than one pinned to tokens.
- Index-off ran first; index-on benefited from prompt-cache warmth on the shared system prompt. The 70% drop in cache creation tokens is partly the L1 win and partly index-on being run second. The 16% wall-time drop survives this caveat (both arms were below the cache TTL).

**Design-doc impact:** none. The design's "L1 reduces discovery overhead" claim is supported. The plan's "≤80% cost" acceptance is unchanged.

**Revisit when:** (a) L2.5 dogfood on a corpus where L1 alone is too expensive — that's where cost USD will be more diagnostic; (b) prompt-cache pricing changes; (c) a multi-rename task (T03-style) on examples/medium gets a paired dogfood, which should show a larger relative L1 win since rename involves more declaration-fishing than test-fixing.
- An attempt fails and shapes the next attempt (record the failure too — silent retries lose information).

If the decision is durable, also update `strata-design.md` and reference the diff or commit from the entry.

## Entry format

```
## YYYY-MM-DD — <short title>

**Context:** what triggered this decision (phase, package, problem encountered).

**Considered:** the alternatives weighed (briefly).

**Decided:** what we're doing now.

**Why:** the reasoning, especially anything not obvious from the alternatives.

**Design-doc impact:** "none" / "updated § X" / "supersedes § X paragraph N".

**Revisit when:** the condition that should make us reopen this (e.g., "if Phase 4 benchmarks show ingest is the bottleneck").
```

---

<!-- New entries go below this line, newest first. -->

## 2026-05-26 — Pivot from "characterize the substrate" to "iteratively develop the product"

**Context:** Across the day's bench rounds, I (Claude) flip-flopped on substrate claims because I kept reading product-level conclusions off N=2 trials and a few measurement bugs I had introduced. The operator named the pattern directly ("it wasn't working, it was working, it wasn't working — flip-flopping — I don't get what we're doing here") and asked the project to be reoriented toward iterative product development. The bench has answered its central question: T03 wins, T01/T05/T08 are mixed-or-lose, and re-running it at low N produces noisy claims, not new insight.

**Considered:**
- (a) Keep iterating on bench measurement until T01/T05/T08 also separate. Falsified by ~$20 of keyed exploration today + the prior May-17 TERMINAL: the integrity-preserving structural levers that could close T01 don't exist, and T05/T08 are local-content tasks where graph navigation is dead weight by design.
- (b) Quietly drop the bench and start shipping. Loses the discipline of "tools win on tasks" and risks shipping unmeasured claims.
- (c) Reorient explicitly: bench is now context (one task wins, the limits are documented), product development is the goal, and any new bench task must be justified by the tool it scores.

**Decided:** (c). Updated CLAUDE.md with a "Current orientation: product, not measurement" section and added `docs/product-roadmap.md` with concrete iterations (usable CLI surface → broaden the tool set with tasks → persistence/incremental ingest → write-up and OSS release). Hard rule encoded in CLAUDE.md: no new bench rounds without a falsifiable product question; default move when stuck is to ship a smaller piece of the surface, not measure again.

**Why:** The MVP success criterion in `strata-design.md` § "What success looks like" is "Strata exists and works end-to-end + the architectural argument lands + a write-up + an OSS release," not "every bench task separates." We have a defensible piece of the second criterion (T03 + honest gap docs) and zero of the third and fourth. Continuing to chase noisy bench rounds spends time and trust without moving any of the four bars. Memory entry `feedback-reproduce-before-rerunning.md` was added separately to encode the "reproduce before re-running" discipline so this specific failure mode doesn't recur.

**Design-doc impact:** none yet — `strata-design.md` § Build phases already names Phase 5 (write-up + OSS release) as the terminal phase; the roadmap is the operational version of that. If iteration 2 lands new tools, update § Tool set to mark them implemented.

**Revisit when:** an iteration deliverable shifts the picture (e.g., `extract_function` lands and bench evidence shows it wins a different-class task), or a write-up reviewer surfaces something the bench would need to re-examine.

---



**Context:** A non-authoritative `packages/lab` arc (probes 6-9, Codex xhigh review, N=5 honest + N=6 trap keyed trials at ~$2.5 sandbox spend; full record in `packages/lab/LAB-NOTES.md` entry of the same date) tested whether a structurally-different per-callsite-expressiveness lever shape could close the contamination channel the 2026-05-17 TERMINAL entry identified. The sandbox arc isn't authoritative and isn't being graduated; the one durable design principle that fell out of it is.

**Considered:**
- (a) bare-string per_scope value slot (the original `applyPerScopeAddParameter` shape) — probe6 + the prior 2026-05-17 keyed evidence: scripting vector. Agent types prompt literals straight into the slot.
- (b) `{expr, importFrom}` object shape — probe6: NOT a structural close. Attacker passes `{expr:'"UTC"', importFrom:"./config.ts"}`; IDENT_PATTERN refuses to inject an import for a non-identifier expr, but the renderer still splices the literal verbatim.
- (c) corpus-grep post-hoc contamination scorer — probe7: structural hole. Trap's prompt-only literals "UTC"/"local" are also corpus ZONE values, so `foundInCorpus=true` for both honest and scripting renders. Can't distinguish source-of-value when corpus and prompt happen to share literals.
- (d) `{nodeRef: NodeId}` shape (probe8 + the extracted lab experiment): op resolves the nodeRef to its bound IDENTIFIER NAME via the graph and uses that name as the callsite arg. The agent cannot pass a string. Exhaustive graph scan finds zero nodes whose identifier-name is "UTC" or "local" — those are string values inside declarations, not identifier names. Structurally trap-resistant.

**Decided (forward-looking design constraint, not a code change):** If a future authoritative Strata tool adds per-callsite expressiveness to `add_parameter` (or to any structural mutation that fans out distinct values to multiple callsites), the value channel must accept graph-node references, not strings or string-bearing object variants. The agent must POINT AT a declaration the substrate can resolve; the substrate must extract the value from the graph; the agent must never get to TYPE the value.

**Why:** Any string-bearing slot is a prompt-scripting vector by construction — the contamination integrity rule cannot distinguish "agent derived this from code" from "agent transcribed this from the prompt" once the substrate accepts a string. The 2026-05-17 TERMINAL entry's NARROW claim — "per-scope tools accepting arbitrary strings are scripting vectors" — stands. Its broader generalization ("any per-callsite expressiveness tool is integrity-un-closeable") was overshot; nodeRef-only is the existence proof that the lever class admits an honest shape. The principle "structural value channels take graph-node references" is the precise design constraint that distinguishes them.

**Design-doc impact:** none yet. `strata-design.md` does not currently propose any per-callsite-expressiveness tools; this entry is the constraint to apply if/when one is proposed. The corresponding sandbox bundle (`packages/lab/src/experiments/nodeRefAddParameter.ts`) is non-authoritative scaffolding that demonstrates the principle but does not graduate as-is — the discipline gate that complements it (op-log: exactly one AddParameter; ReplaceBody only on the param-target) is a task-specific sandbox sledgehammer and would need redesign for any other task before graduation.

**Revisit when:** an authoritative tool design proposes per-callsite expressiveness, OR the sandbox bundle is taken into the rigid pre-registered keyed pipeline for graduation, OR the sandbox arc is extended to a different multi-step task and the principle is tested for generality.

: one additive, default-preserving session injection point (`toolServerFactory`/`canUseTool`/`runAgentLab`); `SessionStartEvent.task` widened to `string`; sole sanctioned canonical touch for the exploration-sandbox effort

**Context:** `docs/superpowers/specs/2026-05-17-multi-step-exploration-sandbox-design.md` calls for a non-authoritative sandbox (`packages/lab`, forthcoming) to iterate on new multi-step methods without polluting the rigid, pre-registered, keyed framework. Landing any sandbox infrastructure required a minimal injection point in the canonical `@strata/agent` package. The seam work spans four commits: acceptance lift (`9477302`), review polish (`e616525`), seam + log widening (`a744b7f`), test nit (`97dcc8a`).

**Considered:** (a) duplicate the agent loop in `packages/lab` — rejected on integrity grounds (a duplicated loop makes any graduated lab result non-comparable to the canonical path; even a one-line drift could silently change behavior); (b) add optional params to `RunAgentT03Params` and re-use the same private `runAgentForPrompt` — the only option that keeps the comparison honest.

**Decided:**
- Two optional params added to `RunAgentT03Params`: `toolServerFactory` (overrides the default single-MCP-server construction) and `canUseTool` (per-turn tool filter). Absent both, `server`/`options`/`ctx` construction is byte-identical to before — zero behavioral change on the existing call sites.
- `acceptance` computation (criteria scoring) lifted from inside `runAgentForPrompt` into its two callers (`runAgentT03`, `runAgentLab`) — behavior-preserving refactor required to give each caller ownership of its own scorer.
- New exported `runAgentLab` delegates to the same private `runAgentForPrompt` loop. No duplication of the loop; the two entry points share a single code path.
- `SessionStartEvent.task` in `packages/agent/src/log.ts` widened from `"T01" | "T03" | "T05" | "T08"` to `string`. This removes a cast that would otherwise lie when a `lab:*` label is written to the operation log. `task` consumers verified: `report.ts` already typed it `string`; `runner.ts` writes a `BenchTaskId` constant — neither regresses.

**Gate passed:** additive + default-preserving (verified: absent the optional fields the generated `server`/`options`/`ctx` values are byte-identical). `@strata/agent` tests: **33 passed | 2 skipped** (35 total) — up from 31 passed | 2 skipped before the seam; the two new tests are the `labSeam` guard tests that assert the injection point works and that the pre-existing T03 replay still scores all criteria correctly. All other canonical test counts unchanged. `pnpm -r build` and `pnpm -r test` green. Spec-compliance and code-quality subagent reviews passed (approved-with-minor; minors fixed in the review-polish commit).

**Why:** The sandbox's entire value proposition depends on results being comparable to the canonical substrate runs. A duplicate loop would undermine that; a byte-identical default path provably does not. The `task` widening is honest hygiene — a narrow union that must be cast to accept `lab:*` labels would silently mis-record the operation log and confuse any future reader.

**Design-doc impact:** none to `strata-design.md` (per CLAUDE.md the contract is not silently rewritten; the sandbox's purpose and limits are documented in the spec). This entry is the authoritative record of the infra change. The sandbox itself (`packages/lab`) and its results are explicitly **non-authoritative** and never feed `RESULTS.md` or `decisions.md` unless a method graduates through the existing rigid pre-registered keyed pipeline.

**Revisit when:** a graduated lab method needs net-new tool *names* visible to the hermetic `assertOnlyStrataTools` guard (its own decision/entry); or a `SessionStartEvent.task` consumer needs the old narrow type (none today — verified above).

## 2026-05-17 — Full multi-agent design of the expressiveness lever → STOP: T01 is a scripting trap *by scorer construction*; the deferred different-class lever is integrity-un-closeable. Terminal.

**Context:** Per the user's "go all out with multiple agents," the `add_parameter` per-callsite-expressiveness lever was taken into a full parallel design: four independent Opus design agents (Facet 1 API/semantics; Facet 2 store/tx + overlap gate; Facet 3 scorer-integrity + single-variable pre-registration; Facet 4 adversarial/blind-spot), on top of the prior independent Codex (gpt-5.5 xhigh) review. Facets 1–3 produced concrete, internally-sound designs (a node-id-keyed `callsite_value_overrides`; the `queueTextSpanEdit` chokepoint gate with a verified T08 two-`replace_body` regression risk; a clean DA-1..DA-5 single-variable pre-registration). The adversarial pass + a direct re-verification overrode them.

**Integrity-dispositive finding (verified against code, not taken on faith — per the codified review discipline):** `uiCallsitesLocalOrDefault` in `packages/verify/src/t01Criteria.ts` is `/formatTimestamp\(\s*0\s*,\s*"local"\s*\)/`. The literal `"local"` **appears nowhere in `examples/medium`** — `ui/timeline.ts` is `return timelineRows(times)[0] ?? formatTimestamp(0);`; nothing in the codebase implies it. `"local"` exists **only in `T01_PROMPT`** ("callsites under `src/ui/` should pass `"local"`"). Therefore any mechanism that makes T01 pass must route a prompt-only literal to one specific callsite — i.e. the agent transcribes the prompt's `(path-prefix → literal)` policy into the tool (an **uninterpretable / contaminated win** — cannot distinguish "substrate capability worked" from "agent typed the prompt's answer into a slot," the AP-4 contamination concern realized structurally), or the tool hardcodes it (overt scripting). **T01 is not honestly satisfiable by any non-scripting structural lever — by scorer construction, not by lever shape.**

**Why the specific lever also fails independently of the above:** (1) **Decision-surface relocation, not removal.** `rename_symbol` wins because the substrate owns 100% of scoping and the agent owns one scalar (zero residual decisions). `callsite_value_overrides` requires ~6 discrete agent decisions plus an N-fold `get_references`→`read_node` ancestor-walk to build the module partition — the failure-inducing surface is moved from "hand-patch the callsite" to "construct a correct scoped policy," not eliminated. Necessary-but-insufficient by the unifying theory's own logic. (2) **Legibility-falsification echo.** AP-2/AP-3 proved the agent ignores a delivered audit-proof manifest and hand-patches anyway; an optional param the agent must *discover, elect, and self-construct correctly first try* is the same "choose the structural path over the body-edit prior" the four levers falsified — predicted-ignored, ~50% mass on reproducing the exact `oldText mismatch at [52,110)` thrash. (3) **files-not-first-class violated in substance.** Module-node payloads *are* the POSIX path strings (`nodes.ts`); correct use requires the agent to read those payloads and cognitively prefix-partition `src/server/`/`src/ui/` — the invariant honored only in the type signature. (4) **Failure-legibility regression.** A mis-partition is type-clean, so `validate`(tsc) passes; the loud diagnosable `oldText` thrash becomes a silent confident-wrong commit only the behavioral gate catches.

**Independent probability estimate (adversarial agent, consistent with the four-falsified-levers prior): ~10–15% that the lever moves T01 to ≥2/3 — and even that tail is integrity-contaminated** (no observable distinguishes a real capability win from prompt transcription). Spending a keyed round would, at best, reproduce AP-2 with a new silent-wrong flail mode.

**Decision:** Do **not** spec or build the expressiveness lever (or the escape-hatch removal, or the gate-as-T01-fix). The deferred different-class lever for T01 is **closed as integrity-un-closeable**. The expressiveness gap (2026-05-17 prior entry) is real and correctly diagnosed, but closing it for T01 specifically requires either scripting or a *benchmark/task redesign* (e.g. a T01 variant whose per-scope value is structurally derivable from the codebase rather than stated only in the prompt — a genuine `rename_symbol`-class task). Redesigning a failing benchmark task until the substrate passes is itself integrity-fraught and is **not** in honest scope for closing T01; it is, at most, a *future* research direction for measuring multi-step generalization with a non-scripting task — new research, not this result.

**Net effect on the thesis — this STRENGTHENS the terminal conclusion.** The bounded negative is now even more precisely characterized: not merely "four falsified levers," but "the obvious fifth (per-callsite expressiveness) is, for T01, un-closeable by any honest structural lever because T01's scorer requires a prompt-only literal at a specific site — the multi-step task as specified is a scripting trap, and `rename_symbol`'s robust win is precisely the class of task (substrate owns 100% of resolution; agent owns one scalar; value structurally derivable) that the file-abstraction removal helps, while T01 is structurally the opposite class." This is the deepest, cleanest statement of where the substrate advantage does and does not hold.

**Design-doc impact:** none to `strata-design.md`. RESULTS.md updated to fold this sharpening into the bounded-negative section. The methodology functioned exactly as intended: a full multi-agent design + independent review + adversarial pass + direct verification refused to manufacture a spec for an integrity-disqualified lever and produced a sharper honest result instead.

**Revisit when:** someone deliberately designs a *new* multi-step benchmark task whose per-scope behavior is structurally derivable (no prompt-only literals), to test multi-step generalization honestly — its own spec/decision cycle, explicitly NOT a continuation of T01.

## 2026-05-17 — Deferred-lever design analysis: T01 is unsatisfiable by `add_parameter` alone *by construction* — the real lever is per-callsite argument expressiveness, not the escape hatch (independent Codex review)

**Context:** Re-opening the deferred different-class lever (per the "Research concluded" entry's "Revisit when"). Brainstorming explored: (A) a deterministic pre-tool-use overlap gate; (B) client-side programmatic/atomic orchestration; and a new idea — replace the general `replace_body` escape hatch with a minimal narrow body-op surface. An independent expert review was commissioned: **Codex CLI, `gpt-5.5`, reasoning `xhigh`, read-only, repo-grounded** (it independently explored beyond the seeded files and ran a live `tsc` probe). Its verdict was then **verified against the actual criteria/code before being accepted** (the discipline: do not take a pivotal empirical claim on faith).

**Verified finding (decision-grade, changes the framing of the whole arc):** T01 cannot be satisfied by `add_parameter` alone.
- `T01_PROMPT` requires `src/server/` callsites to pass `"UTC"` and `src/ui/` callsites to pass `"local"`.
- `evaluateT01TextCriteria` (`packages/verify/src/t01Criteria.ts`) is authoritative: `serverCallsitesUtc` (both `server/events.ts` calls get `, "UTC"`), `uiCallsitesLocalOrDefault` = `/formatTimestamp\(\s*0\s*,\s*"local"\s*\)/` (the UI callsite MUST become `formatTimestamp(0, "local")`, explicitly **not** `"UTC"`/default), `hofCallsiteNotMisedited` (`times.map(formatTimestamp)` untouched).
- `add_parameter` (`packages/store/src/addParameter.ts`): `const slotValue = defaultValue ?? "undefined"` is inserted at **every** resolved direct callsite — a single uniform value. No invocation can emit `"UTC"` at server and `"local"` at UI.

**Reframing:** the agent's post-`add_parameter` `replace_body` on the UI callsite is **not (purely) compulsive misbehavior — it is the agent correctly attempting the per-callsite differentiation T01 requires**, with the only available tool, colliding with `add_parameter`'s own queued overlay edit on that statement. Therefore:
1. The deterministic overlap gate (A), **alone, is an honest-negative-by-construction for T01**: it would stop the corruption but block the *legitimately required* UI-callsite edit → T01 still fails (cleanly, not via thrash). Established *before* any keyed spend — the purpose of the verification.
2. The substantive T01-passing lever is an **expressiveness extension to `add_parameter`** (per-callsite / per-scope argument values as a structural operation), so the differentiation T01 demands is expressible without a second overlapping edit. The gate is **necessary-not-sufficient**: still valuable as the single-variable *mechanism probe* and a legibility/safety net, but not the lever that makes T01 pass.
3. The deepest root cause of the entire four-falsified-levers arc is an **`add_parameter` expressiveness gap** (uniform single default; no per-scope value policy) intersecting the corruptible escape hatch. The prior four levers all attacked "the agent shouldn't redo callsites," but the agent *had* to touch the UI callsite and no structural op could express it.

**Codex-grounded design constraints adopted (verified plausible):** (a) a deterministic gate must live at/under `queueTextSpanEdit` in `packages/store/src/transactions.ts` — the single chokepoint both the live and replay (`session.ts:runStep`) paths traverse — not in SDK `canUseTool` (live-only) → replay-deterministic by construction; (b) composition rule: reject **overlapping** base-coordinate spans but **allow disjoint same-statement edits** (T08's `change_return_type` + body edits on the same function are disjoint and must stay allowed — a naive "any second edit on a touched statement" gate would regress T08); (c) scorer-staleness trap: `evaluateT05Criteria` checks for the `ReplaceBody` operation-row kind, so replacing the body-op kind would falsely fail T05 (currently 3/3) — body-op-replacement carries materially higher regression risk (Codex est. T05 20–35%, T08 35–60%; gate-only <10%) and is *not* the right primary lever.

**Decision:** do **not** pursue "replace `replace_body`" as the primary lever (insufficient — still a foot-gun via arbitrary expression text — and dangerous to the T05 scorer). The honest next design is: **extend `add_parameter` with per-callsite/per-scope argument expressiveness** (the substantive lever), with the store-level overlap gate as a complementary, independently-pre-registerable mechanism probe. Each remains its own single-variable, pre-registered, keyed-validated cycle; not bundled (attribution discipline). No code written; no keyed round run — this is pre-design analysis that the verification materially redirected.

**Design-doc impact:** none to `strata-design.md`. This is the authoritative record of why the obvious lever (gate / escape-hatch removal) is necessary-not-sufficient and what the real lever is. RESULTS.md left unchanged (no measured result; mid-exploration of a deferred lever).

**Revisit when:** the `add_parameter` per-callsite-expressiveness lever is taken into a full brainstorm→spec→plan→TDD→pre-registered-keyed-validation cycle (its own entry), or the gate is pre-registered as a standalone mechanism probe.

## 2026-05-17 — Research concluded (deliberate terminal point, not abandonment)

**Context:** After the AP round (entry below) the T01 boundary is exhaustively characterized by four independent, pre-registered, transcript-classified, falsified levers (prompt/description tuning, the commit gate, model capability, tool-result legibility), with the atomic-edit win (T03) robust, replicated and model-independent throughout. The operator elected to conclude the research here rather than open a new, different-class arc.

**Considered:** (a) take on a deeper different-class lever (remove the `replace_body` escape hatch / agent-loop redesign forbidding re-edit of a tool-touched span) — a new research project, not a continuation; (b) cheap loose ends (optional fresh N=3 confirming T08 beyond the 3 audited transcripts; retiring brittle text-criteria proxies); (c) declare the research complete and close out the write-up.

**Decided:** (c). The research question is answered with claim-grade rigor and the negative is precisely bounded, not vague — that *is* the result. Continuing would be scope expansion into a new arc the bounded negative does not require; the four falsified levers are terminal for the legibility/prompt/model/gate class. RESULTS.md, README, and this decision trail brought into coherence with the terminal state (status → "research concluded 2026-05-17"; bottom line rewritten to the proven-win / partial-gate-enabled-generalization / four-falsified-levers synthesis; stale "pending keyed measurement" framing removed). `strata-design.md` deliberately NOT edited (per CLAUDE.md the contract is not silently rewritten to match; the conclusion lives in RESULTS.md/decisions.md).

**Why:** The project set out to produce "a proven win, a precisely-bounded scope, a boundary diagnosed to a named cause, and falsified easy answers, under adversarial self-scrutiny." All four exist and are honestly recorded. A clean terminal point reached deliberately is itself a result; manufacturing further iteration would dilute, not strengthen, it.

**Design-doc impact:** none. Closes the build/measure arc; `decisions.md` remains the authoritative trail.

**Revisit when:** someone takes up the deferred different-class lever (a) or loose ends (b) as a new effort — each its own spec/decision cycle. The one artifact not producible here — the 5–10 min demo video (`strata-design.md` § Phase 5) — is left for a human; that is the sole outstanding Phase-5 deliverable.

## 2026-05-17 — `add_parameter` legibility keyed validation: AP-2 NEGATIVE, AP-3 mechanism unchanged — tool-RESULT legibility is insufficient; the T01 boundary is now exhaustively characterized (4 falsified levers)

**Context:** The frozen pre-registered keyed round (`docs/superpowers/specs/2026-05-17-add-parameter-legibility-probe-prereg.md`, commit `70a07eb`, AP-1..AP-4), run from a branch whose code == `main` @ `643e953` (the merged manifest implementation): `pnpm --filter @strata/bench bench -- --trials=3 --tasks=T01,T03 --keep-artifacts`, `claude-sonnet-4-6`, N=3, **round cost $2.86**. Single changed variable vs. all prior T01 rounds: `add_parameter` now returns/surfaces the itemized `AddParameterManifest`; the tool description was held byte-identical (control). Classified from the 6 persisted substrate transcripts per the frozen pre-reg. Artifact: `packages/bench/results/phase15-four-task-2026-05-17T04-48-01-533Z.{json,md}`.

**Classification against the frozen AP-1..AP-4:**
- **AP-1 (T03 regression guard) — PASS, 3/3.** Every T03 substrate trial is the canonical single clean rename (`find_declarations → get_references → begin_transaction → rename_symbol → validate → commit_transaction`, 6–7 tools, 998–1065 tok, 0 retries, success+opRow 3/3), disjoint from baseline (≤1065 vs ≥4154 tok; 6–7 vs 22–24 tools). The `add_parameter`-return-only change did not couple into the proven rename (T03 never calls `add_parameter`). The T01 read is valid; no STOP.
- **AP-2 (does the manifest move T01) — the pre-committed NEGATIVE.** T01 substrate **0/3**, **operationRowAppended 0/3** — never a correct committed change. Per the frozen AP-2 rule this is the honest, valid logged negative: a believable itemized manifest of the tool's own edits did **not** move T01. Not a retry trigger.
- **AP-3 (mechanism — the real readout regardless of AP-2) — UNCHANGED.** Every T01 trial reproduces the *identical* diagnosed thrash: ~16 `read_node` exploration → `begin_transaction → add_parameter → replace_body ×3 → validate✗ → rollback_transaction → begin_transaction → add_parameter → replace_body …`, every `validate✗` the exact `oldText mismatch at [52,110): expected "{ return timelineRows(times)[0] ?? formatTimestamp(0); }"` collision (the agent hand-patches the very callsite `add_parameter` already queued). The manifest **was delivered** — the `add_parameter` `result_summary` carries the full `{declaration:{beforeSignature,afterSignature}, callsitesRewritten:…}` — and the agent **ignored the verifiable evidence and hand-patched callsites with `replace_body` regardless**, byte-same mechanism as pre-manifest sonnet (2026-05-16 N=3) and Opus (2026-05-17 probe). Each trial then terminated **confident-wrong** ("Both transactions committed and tests pass") while the bar shows 0/3 (the `tsc/vitest 3/3` is the known scorer-on-non-converged-run artifact; `success`/`operationRowAppended` 0/3 are the truthful signals).
- **AP-4 (no scripting / contamination) — clean.** The `result_summary` is exactly the itemized manifest (declaration + the tool's own callsite edits + arity-risk sites): no task hints, no directive prose. The description was byte-constant (verified: code == 643e953, the merged control). The negative is honest — the agent had concrete, verifiable proof the callsites were already done and chose to re-edit them anyway.

**Conclusion:** Tool-**result** legibility (a faithful, itemized, audit-proof manifest of exactly what `add_parameter` did) is **insufficient** to stop the agent hand-patching callsites — exactly as tool-**description** legibility was falsified (2026-05-15 BS-P-B). The T01 multi-step failure is therefore **not a communication/legibility problem**: given concrete evidence the callsites are complete, the agent compulsively re-does them with `replace_body` and corrupts the transaction. The boundary is now **exhaustively characterized by four independent, pre-registered, transcript-classified, falsified levers**: (1) prompt/description tuning (BS-P-B terminal), (2) the commit gate (built, validated, not T01's lever), (3) model capability (Opus single-variable probe, MP-2=L2), (4) tool-result legibility (this round, AP-2 negative / AP-3 unchanged). Across all four, the atomic-edit win (T03 rename) stayed robust, replicated, and model-independent. This is a precisely-bounded negative, not a vague one — a strong result for the write-up: removing the file abstraction is a real, robust efficiency win for atomic structural edits and does **not** generalize to this multi-step refactor, and the gap is now shown un-closeable by prompt, gate, model, or tool legibility.

**Design-doc impact:** none to architecture. Sharpens `strata-design.md`'s thesis boundary: the substrate efficiency claim is demonstrated for atomic operations and the multi-step generalization gap is now exhaustively bounded (four falsified levers), not merely observed. RESULTS.md updated.

**Revisit when:** a fundamentally different lever is proposed (e.g. removing/!replacing the `replace_body` escape hatch so the agent *cannot* hand-patch — a tool-surface/affordance change, not a legibility one; or an agent-loop redesign that detects and forbids re-editing a tool-touched span). Not by another legibility/prompt/model pass — those four are terminal. Most honestly: this is a clean point to write up the precisely-bounded result rather than continue iterating.

## 2026-05-17 — T01 stronger-model probe: L2 confirmed — `add_parameter` tool-illegibility, NOT a model-capability ceiling (MP-1 PASS, MP-2 = L2, MP-3 same mechanism)

**Context:** The frozen pre-registered probe (`docs/superpowers/specs/2026-05-16-t01-stronger-model-probe-prereg.md`, commit `704c035`, MP-1..MP-3) re-run on the harness-fixed `main` (`39f28ee`): `--trials=2 --tasks=T01,T03 --model=claude-opus-4-7 --keep-artifacts`, N=2, **round cost $3.70** (the first attempt crashed on the now-fixed SDK max-turns gap and produced no data; this run completed and wrote `packages/bench/results/phase15-four-task-2026-05-17T00-29-06-119Z.{json,md}`). Only the model changed (sonnet-4-6 → opus-4-7); tools/prompt/harness/budgets held fixed. Classified from the persisted transcripts per the frozen pre-reg.

**Classification against the frozen MP-1..MP-3:**
- **MP-1 (T03 guard under the swapped model) — PASS.** Both T03 substrate trials are the canonical single clean rename (`find_declarations → get_references → begin_transaction → rename_symbol → validate → commit_transaction`, 6 tools, 879/907 tok, 0 retries, success 2/2, opRow 2/2). The model swap does not distort T03 → the T01 read is **valid, not confounded**.
- **MP-2 (L1 vs L2) — L2.** T01 substrate **0/2**, **operationRowAppended 0/2** (JSON authoritative: trial1 `error_max_turns`/opRow false; trial2 `success` terminal but opRow false, two `commit{ok:true}` on non-correct/partial transactions — never a correct T01 change). Per the pre-committed MP-2 rule, a stronger model failing both by never reaching a correct committed change ⇒ **the failure is tool-design (`add_parameter` illegibility, L2), not a model-capability ceiling**. Both MP-2 outcomes were pre-registered, so this is not post-hoc.
- **MP-3 (mechanism) — SAME mechanism, conclusively.** Every Opus T01 trial reproduces the *identical* diagnosed thrash: heavy `read_node` exploration → `begin_transaction → add_parameter → … → replace_body → replace_body → validate✗ → rollback_transaction → begin_transaction → …`, with every `validate✗` the exact `oldText mismatch at [52,110): expected "{ return timelineRows(times)[0] ?? formatTimestamp(0); }"` collision — the agent hand-patches a callsite `add_parameter` already rewrote, so the overlay text no longer matches. 3–4 `validate✗` and multiple rollback→begin cycles per trial, never converging. Not a new failure mode (MP-3's "different mechanism" branch did not fire). Opus explores *more* (14–16 `read_node`) but mis-uses `add_parameter` exactly as sonnet did.

**Conclusion:** With prompt-tuning falsified (2026-05-15 BS-P-B terminal), the commit gate closed (gate-scope validation), and now **model-capability ruled out** by a fair single-variable probe at the strongest available model, T01's failure is decisively isolated to **`add_parameter` tool-illegibility**. The one remaining lever is unambiguously a **`add_parameter` tool-legibility redesign** (its own brainstorm→spec→plan→TDD→pre-registered-keyed-validation cycle). Not a stronger model, not prompt, not the gate.

**Bonus observation (not a pre-registered signal — recorded as observational, not a claim):** the Opus *file-tools baseline* hit `error_max_turns` on **T03** (the rename; 2/2, 25 tools) where the substrate completed it in **6 tools / ~893 tok**. On the atomic structural edit the substrate advantage is, if anything, *amplified* under a stronger model, while T01 fails for both configs. Sharpens the thesis: the file-abstraction win on atomic edits is robust and model-independent (plausibly larger with stronger models); the T01 gap is a specific tool-design defect, not the substrate concept and not model capability. (N=2, indicative, not a significance claim.)

**Design-doc impact:** none to architecture. Resolves the roadmap fork: the deferred T01 lever is now positively identified (tool-design, L2). RESULTS.md updated.

**Revisit when:** the `add_parameter` legibility redesign is taken up as its own spec/decision cycle; or a future model materially beyond opus-4-7 is evaluated (the probe bounds capability at the strongest model available 2026-05-17, not for all time).

## 2026-05-16 — Third installed-SDK gap: agent SDK THROWS `maxTurns` (doesn't yield a result subtype) → harness now classifies it gracefully on both session paths

**Context:** The T01 stronger-model probe (pre-reg `704c035`, MP-1..MP-3) was launched with `--model=claude-opus-4-7`. It **crashed** (exit 1, no artifact, all trials incl. the T03 guard lost) on `Error: Claude Code returned an error result: Reached maximum number of turns (40)`. systematic-debugging (root-cause first, no blind retry) was applied; the probe produced **no L1/L2 data** — MP-1..MP-3 remain frozen and unexercised for a later valid run.

**Root cause:** `@anthropic-ai/claude-agent-sdk@0.2.118` signals the `maxTurns` budget by **throwing** `Reached maximum number of turns (N)`, NOT by yielding a `result` message with `subtype:"error_max_turns"`. The harness *defines* `error_max_turns` as a `TerminalReason` and `terminalFromResultSubtype`/`terminalFromSubtype` map that subtype — i.e. it only handled the *yielded-result* path, which the installed SDK never takes for max-turns. The substrate live loop's catch (`session.ts`) re-threw any non-abort error; the baseline collector (`collectBaselineSession`) had no catch at all. `claude-sonnet-4-6` never exposed this because T01 always tripped the 420 s wall-time abort (gracefully → `error_wall_time`) *before* the 40-turn ceiling; `claude-opus-4-7` reached 40 turns first. This is the **third documented installed-SDK-vs-expected gap** (cf. the two Phase-3 gaps) — a latent harness-robustness defect the model swap surfaced, not a T01 result.

**Decision:** Added one shared, exported, pure classifier `classifySessionError(caught, aborted) → { terminal, rethrow }` in `@strata/agent` (return type narrowed to its true codomain `error_max_turns | error_wall_time | error_other`, so it is assignable to both packages' `TerminalReason`). Both session paths now use it: substrate `runLiveSession`'s catch, and `collectBaselineSession` (new try/catch, abort signal threaded from `baseline.ts`). Semantics: a wall-time abort → `error_wall_time` (unchanged); the SDK max-turns throw → `error_max_turns` (now graceful, recorded, **not re-thrown**); anything else → `error_other` + **rethrow (still fails loud)**. 9 new key-free TDD tests (6 `sessionError`, 3 `collectBaselineSession` throw/abort/genuine), independent review of the substrate change ("Approved; regression-safety holds; no scoring impact") which also flagged the symmetric baseline gap — now closed here.

**Integrity / scope:** Pure harness-robustness; cannot bias scoring (`success` is criteria-driven; this only converts a process-crash into a pre-existing non-success `TerminalReason`). Prior results unaffected: sonnet rounds trip wall-time first (still `error_wall_time`); the merged gate/T08 work never touches this path. BG-3 intact: only `@strata/agent` (24→30) and `@strata/bench` (48→51) gained tests, all other packages byte-identical, 0 failures, 8/8 build clean.

**Design-doc impact:** none to architecture; records a third installed-SDK behavior gap and the harness hardening. The probe's L1/L2 question is **still open** — to be answered by a valid Opus re-run against the frozen MP-1..MP-3, logged as its own newest-first entry.

**Revisit when:** a future SDK version changes the max-turns signaling (re-confirm the message match), or another caller consumes a live `query()` loop without routing its catch through `classifySessionError`.

## 2026-05-16 — T08 HN-2 root-caused: scorer artifact, not behavioral variance — `callersTypecheckUnderNarrowType` corrected (T08 N=3 = 3/3 on the same data)

**Context:** Investigation #1 from the N=3 entry's "Revisit when" — characterize the T08 HN-2 = 2/3. Systematic-debugging (read-only root-cause first, no result-chasing). The anomaly: all three T08 N=3 substrate trials were process-identical (single transaction `change_return_type → replace_body ×2 → validate → commit{ok:true}`, tsc-clean, vitest-passing, committed, contamination-free) yet trial-1 scored `success=false`, trials 2/3 `true`.

**Root cause (transcript- + code-verified):** `evaluateT08TextCriteria.callersTypecheckUnderNarrowType` scanned the **whole `permissions.ts`** for the substrings `role === "admin"` / `role === "editor"` as a proxy for "the caller (`describeRole`) consumes the narrowed return type type-safely." All three agents legitimately rewrote `describeRole` as an exhaustive `switch (role) { case "admin": … }` (valid, tsc-clean, arguably better than the seed's `if`-chain). That form contains no `role === "x"` substring, so the criterion was **simultaneously**: (i) **over-strict** — it rejected the valid `switch` caller (false negative → trial-1 spuriously failed); and (ii) **unsound** — trials 2/3 passed only because their `getRole` *body* coincidentally contained `role === "admin"`/`"editor"`, i.e. it scored an unrelated function, not the caller (false positive → passed for the wrong reason). Hypothesis (b) (agent subtly wrong) was refuted: the gate already proved all three tsc-clean + vitest-passing + committed + uncontaminated.

**Decision:** Corrected `callersTypecheckUnderNarrowType` to express its stated intent: scope it to the `describeRole` region (declaration→EOF, the structural caller location — the corpus has exactly one caller, last in module) and accept any type-safe discrimination form — `role === "x"` **or** `case "x":` — keeping the no-`as`-cast clean-bind requirement, scoped to that region. New `describeRoleRegion` helper + 2 TDD tests (switch-form accepted; coincidental-cross-function match rejected). `evaluateT08Criteria` already delegates to `evaluateT08TextCriteria`, so the rendered-store path and BS15-C consistency invariant flow through unchanged.

**Integrity safeguards (this changes a published benchmark number — 2/3→3/3):**
- **Justified by measurement-correctness independent of outcome:** the corrected criterion is *stricter* where it was unsound (rejects a clean-bind-but-no-discrimination caller, and the decisive false-positive class where `role === "x"` lives only in `getRole`) and *more lenient* where it was over-strict (accepts `switch`). Proven by the 2 new unit tests + an adversarial battery (7 cases) in an independent opus audit.
- **Deterministic re-score (zero API spend, criterion is the only changed variable):** reconstructing the 3 N=3 trial renders from their transcripts, the OLD criterion reproduces the recorded **2/3 exactly** (faithful), the NEW yields **3/3** — and trials 2/3 now pass via the describeRole `switch` (the legitimate reason), not the coincidental `getRole` substring (verified by dumping the scanned region).
- **Independent integrity audit (opus subagent):** verdict "LEGITIMATE measurement-correctness fix, sound, not gerrymandered" — scoping is a generic structural location not a transcript fingerprint; rejects every genuinely-wrong caller tested.
- BG-3 intact: `pnpm -r test` = `@strata/verify` 40→42 (+2 new T08 tests), every other package byte-identical, 0 failures, 8/8 build clean.

**Honest caveats (recorded; pre-existing text-scanner limits, not introduced or worsened, not triggered by any trial):** (1) a comment containing `if (role === "admin")`/`case "admin":` inside `describeRole` would false-positive — identical under old and new code; (2) the criterion scores *type-safe consumption*, not behavioral label-correctness (a label-swapped switch would pass `callersTypecheckUnderNarrowType`) — consistent with its stated intent; behavioral correctness is scored separately by the vitest gate.

**Net:** T08's true behavioral pass rate at N=3 is **3/3**, not 2/3; the recorded 2/3 was a scorer artifact, now corrected. This supersedes the HN-2 = "2/3 noted variance" classification in the entry below: with the corrected, audited criterion the N=3 hardening is **T03 3/3, T05 3/3, T08 3/3, T01 0/3 (isolated non-gate lever)**.

**Design-doc impact:** none to architecture; corrects a Phase-1.5 text-criterion proxy. RESULTS.md updated.

**Revisit when:** a fresh keyed N=3 (new agent samples) is run to confirm T08 3/3 generalizes beyond these three transcripts (the deterministic re-score settles the *criterion*, not new-sample variance); or the broader "retire brittle text proxies in favor of the validated behavioral-gate signal" question (option C, deferred) is taken up as its own spec.

## 2026-05-16 — N=3 hardening: HN-1 PASS (T03 flagship replicates on valid harness), HN-3/HN-4 PASS, HN-2 = 2/3 (honest noted variance); no bail STOP

**Context:** The N=3 hardening round, pre-registered tamper-evidently in `docs/superpowers/specs/2026-05-16-n3-hardening-prereg.md` (commit `a40f9c1`) BEFORE launch, run on `feat/gate-scope-redesign`, `pnpm --filter @strata/bench bench -- --trials=3 --tasks=T01,T05,T08,T03 --keep-artifacts`, `claude-sonnet-4-6`, N=3, 24 live runs, **round cost $3.82**. Classified from the 12 persisted substrate transcripts (`*-2026-05-16T21-1[4-9]/2[0-9]/3[0-9]/4[0-9]/5[0-9]*.jsonl`), per the frozen pre-reg. Artifact: `packages/bench/results/phase15-four-task-2026-05-16T21-54-44-125Z.{json,md}`.

**Classification against the frozen HN-1..HN-4:**

- **HN-1 (T03 regression guard — HARD STOP): PASS, 3/3.** Every T03 trial is the canonical single clean rename transaction (`find_declarations → get_references [→ read_node] → begin_transaction → rename_symbol → validate → commit_transaction`), **1 transaction, 0 `replace_body`, commit `{ok:true}` first try**, raw tokens `[1066,1020,1054]`, **7 tools every trial**, 22–25 s, **0 retries every trial** — disjoint from baseline (substrate max 1066 tok ≪ baseline min 3825; 7 tools ≪ baseline 23–35). The hard STOP does **not** trigger. **The project's flagship proven win is replicated again, at N=3, on the now-valid (BG-4-fixed) harness** — the strongest evidence yet that the gate-scope fix preserved it.
- **HN-3 (T05 gate-driven success replicates): PASS, 3/3.** Every T05 trial shows the designed mechanism: an initial empty/no-op `begin_transaction → … → commit_transaction` is **rejected by the scoped gate with T05's OWN `dateRange.test.ts` fail-before signal**, which drives a real `begin_transaction → replace_body → validate → commit_transaction{ok:true}` → success. ≥2/3 was the bar; 3/3 observed — robustly real. **Honest caveat (on the record):** T05 is a *correctness* success but an *efficiency loss* vs the file baseline — substrate ≈ 6535 tok / 21 tools / 128 s mean vs baseline ≈ 796 tok / 5 tools / 17 s (token distributions separated the *wrong* way). The gate rescues T05's correctness; it does not make T05 efficient.
- **HN-4 (T01 stays isolated to a non-gate lever): PASS, 0/3 isolated.** All three T01 trials fail via the diagnosed `add_parameter`/manual-`replace_body` collision thrash — every trial hits `validate✗ oldText mismatch at [52,110)` (the agent hand-patches a callsite `add_parameter` already rewrote, so the overlay text no longer matches), with 36–47 tool calls; 1 trial wall-aborted, 2 ran to near-budget without ever producing a correct committed change (`success 0/3`, `operationRowAppended 0/3`). Precise nuance vs the pre-reg wording: some trials *do* call `commit_transaction` and get `{ok:true}` on empty/partial transactions, but **never a correct T01 fix** — the failure is upstream of and orthogonal to the commit gate, exactly as diagnosed. No trial unexpectedly succeeded (no informative-variance surprise). The gate is confirmed **not** T01's lever.
- **HN-2 (T08 clean win replicates): 2/3 — "win with noted variance" per the frozen scale (not 3/3 robust, not ≤1/3 downgrade).** All three T08 trials are process-identical and clean: single transaction, `change_return_type → replace_body → replace_body → validate → commit_transaction{ok:true}` first try, 13 tools, 0 retries, **`operationRowAppended` 3/3, no cross-task collateral** (GS-3 holds at N=3 — no T08 commit was rejected by, or repaired, T05's fixture). 2/3 met T08's task-success criteria; **trial 1 committed a `tsc`-clean, behaviorally-passing change (`resultQuality` tsc+vitest both true, opRow true) that missed T08's strict regex *text* criteria** (`evaluateT08TextCriteria`: return-type-literal-union / no-`as string`-cast / narrowed-callsite shape). The miss is **criteria-shape strictness on an otherwise correct, contamination-free committed change**, not a process failure, regression, or contamination.

**Conclusion:** No bail STOP. The validated task-scoped gate is **robust at N=3** for the regression guard (T03 — the flagship claim, now re-replicated post-fix and still disjoint from baseline) and for the T05 gate-driven correctness mechanism. T08 is a **real win with honest 2/3 task-criteria variance** (clean every trial; the 1 miss is text-criteria strictness on a correct change, worth a future look at either the agent's solution shape or the regex criteria — not a contamination or a gate defect). T01 is **firmly isolated** to the known `add_parameter` tool-legibility / model-capability lever, replicated 0/3, orthogonal to the gate. The aggregate "cross-task pattern does NOT hold" line remains the known definitional artifact (it requires the T05 control to *not* separate; the scoped gate correctly makes T05 pass its own task — desired, not contamination).

**Design-doc impact:** none to architecture. Hardens the prior entry's N=1 result into N=3 distributions for T03/T05 and a quantified 2/3 for T08; RESULTS.md updated accordingly.

**Revisit when:** (a) the T08 2/3: inspect whether trial-1's behaviorally-correct miss is agent solution-shape variance or over-strict regex criteria — a small, separable investigation, not a gate pass; (b) the now-isolated T01 lever (stronger model and/or `add_parameter` legibility redesign); (c) raising N further only as an explicit separate budget decision (N=3 is the claim bar; do not auto-escalate).

## 2026-05-16 — Keyed validation of the task-scoped gate: GS-1..GS-4 ALL PASS — BG-4 reversed, T08 clean win, T01 fails for a non-gate reason

**Context:** The operator-keyed re-run mandated by the gate-scope spec's pre-committed bail signals, run on branch `feat/gate-scope-redesign` (the task-scoped-gate fix), `pnpm --filter @strata/bench bench -- --trials=1 --tasks=T01,T05,T08,T03 --keep-artifacts`, `claude-sonnet-4-6`, N=1, **round cost $0.79** (vs the BG-4 round's $1.52 — agents stopped doing unrelated collateral work). Classified from the persisted substrate transcripts (`packages/bench/results/logs/*-2026-05-16T20-5*/21-0*.jsonl`), per the spec — not aggregate inference. Artifact: `packages/bench/results/phase15-four-task-2026-05-16T21-05-00-441Z.{json,md}`.

**Bail-signal classification (all from transcripts):**
- **GS-1 (T03 regression guard restored) — PASS.** T03 substrate is the canonical single clean transaction: `find_declarations → get_references → begin_transaction → rename_symbol → validate → commit_transaction`. 1 transaction, **0 `replace_body`**, commit `{ok:true}` first try (no gate rejection), 1228 tok / 6 tools / 28 s / 0 retries — back inside (tighter than) the proven band, vs BG-4's 2176 tok / 12 tools / 45 s / 2 transactions. The BG-4 regression is fully reversed; the round is therefore VALID. Still beats baseline (3553 tok / 21 tools).
- **GS-2 (teeth where due) — PASS.** T05 (scoped to its OWN `tests/dateRange.test.ts`): the agent's first transaction was an empty `begin→validate→commit` no-op; the gate **correctly rejected it with T05's own fail-before signal** (`dateRange.test.ts 1 failed`), which drove a real second transaction (`begin→replace_body→validate→commit{ok:true}`) → success 1/1. The behavioral gate converted a would-be Phase-1.5-style no-op/thrash into a real fix. T08 (scoped `[]`→tsc-only): a tsc-clean correct change committed in one transaction. Correct, task-scoped teeth.
- **GS-3 (no cross-task contamination) — PASS.** T03 and T08 each committed in ONE transaction with ONLY their own task's edits; no commit was rejected by another task's fixture; no agent fixed the unrelated `isWithinRange` bug as collateral. The defining BG-4 symptom (every non-T05 first commit rejected by T05's red) is GONE. T05 seeing `dateRange` in its rejection is correct — that IS T05's own fixture.
- **GS-4 (scorer == gate) — PASS (structural + observed).** Tasks 6/7 wired the same `behavioralFixturesForTask(taskId)` into the live gate and both scorers; the final whole-branch review traced all three paths; no per-task divergence observed (T03/T08/T05 `vitestPassed` reflect their own scoped fixtures).

**Substantive result:**
- **The gate-scope fix is validated. BG-4 is resolved.** The proven atomic T03 win is fully restored and clean.
- **T08: substrate clean win 1/1 (one transaction, only its own edits, tsc+behavioral pass); baseline 0/1.** The gate's original motivating case (T08 confident-wrong) is closed *without* contamination.
- **T05: substrate 1/1, gate-driven.** The scoped behavioral rejection of a no-op first transaction is exactly the designed mechanism. Caveat: N=1, and substrate is slower here (18 tools / 74 s) than baseline (6 / 19 s) — a correctness success, not an efficiency win.
- **T01: still FAILS — and the gate is provably NOT its lever.** Transcript: 16× `read_node` + 10× `find_declarations` exploration, then `begin_transaction → add_parameter → replace_body×3 → validate✗ → rollback → begin_transaction → replace_body → add_parameter → replace_body×3 → validate✗`, then wall-abort. `validate` failed twice with `oldText mismatch at [52,110)` — the diagnosed `add_parameter`/manual-`replace_body` callsite-collision thrash. It **never reached `commit_transaction`**, so the behavioral gate was never invoked. The report's T01 `tsc/vitest 1/1` is the known scorer-on-non-converged-run artifact (`success 0/1`, `operationRowAppended 0/1`, `error_wall_time` are the truthful signals). T01's failure is upstream of commit; its remaining lever is `add_parameter` tool legibility and/or model capability — explicitly a DIFFERENT lever than the commit gate, and one prompt tuning already failed to move (2026-05-15 BS-P-B terminal).

**Cross-task "pattern does NOT hold" line is a definitional artifact, not a negative:** the harness heuristic requires the T05 control to NOT separate; T05 now succeeds because the scoped gate correctly makes it pass its own task — desired behavior, not contamination. The transcript-level truth (which the spec mandates over the aggregate heuristic): 3/4 tasks succeed cleanly under the substrate (T03 win intact, T08 clean win, T05 gate-driven), T01 fails for a non-gate reason.

**Design-doc impact:** none to architecture. Confirms the gate-scope spec's thesis and sharpens `strata-design.md`'s "validate-before-commit" gate: it is now a *valid, task-scoped* behavioral finish line. RESULTS.md updated to record this measured outcome (was "built, found invalid as-built: BG-4").

**Revisit when:** a stronger model or an `add_parameter` tool-legibility redesign takes on T01 (the now-isolated remaining lever); or N is raised from 1 to harden the T05/T08 single-trial observations into a distribution. Not by another gate-scope pass — that lever is closed and validated.

## 2026-05-16 — Gate-scope build: AcceptanceContext carries the resolved fixture list, not taskId

**Context:** Implementing the task-scoped gate (spec `docs/superpowers/specs/2026-05-16-gate-scope-redesign-design.md`). The spec's prose says `commitWithBehavioralGate` resolves `behavioralFixturesForTask(ctx.taskId)`.

**Considered:** (a) literal spec — `AcceptanceContext` carries `taskId`, the verify gate calls the resolver; (b) callers resolve and pass `AcceptanceContext.behavioralFixtures: readonly string[]`.

**Decided:** (b). The single authority (`behavioralFixturesForTask` in `@strata/verify`) and the gate==scorer guarantee are unchanged — both the live gate (session.ts) and the bench scorer (substrate/baseline) resolve through that one function. Carrying the resolved list keeps the verify gate decoupled from benchmark task identity and lets the gate unit tests exercise arbitrary fixture lists (`["tests/a.test.ts"]`, `[]`) directly.

**Why:** Same intent and invariants as the spec; strictly better seam (testability + no task-vocabulary coupling in the gate). Recorded because it diverges from the spec's literal wording per the project's build-time-divergence discipline.

**Design-doc impact:** none to architecture; refines the spec's internal call-site only. Spec intent (single authority, fail-loud, additive scoping, gate==scorer) fully preserved.

**Revisit when:** a non-bench caller needs the gate and cannot resolve a fixture list itself.

## 2026-05-16 — Keyed behavioral-gate re-run: BG-4 TRIGGERED — the whole-suite gate scope is invalid on the shared multi-task corpus (STOP)

**Context:** The operator-keyed re-run mandated by the prior entry's "Revisit when" and `docs/RESULTS.md` — `pnpm --filter @strata/bench bench -- --trials=1 --tasks=T01,T05,T08,T03 --keep-artifacts`, `claude-sonnet-4-6`, N=1, round cost $1.52. Classified from the persisted substrate transcripts (`packages/bench/results/logs/*-2026-05-16T18-*.jsonl`), as the spec requires — not aggregate inference. Artifact: `packages/bench/results/phase15-four-task-2026-05-16T18-42-04-563Z.{json,md}`.

**Considered:** (a) read the aggregate `successCount`/`vitestPassed` and proceed; (b) classify the transcripts against bail signals BG-1..BG-4 before drawing any conclusion.

**Decided:** (b), and the classification surfaced a gate **design defect**, not a result. **Recorded as a STOP per spec § Bail signals; the gate was not patched and the round was not re-run — that is an operator design decision, logged here per "record the failure too".**

**Root cause (source- + transcript-verified):**
- `runCorpusAcceptance` in `@strata/verify/src/corpusRun.ts` runs the **entire** corpus vitest suite (`vitestRun` → `vitest run`, no task scoping/filter/`testNamePattern`).
- The shared seed `examples/medium` deliberately ships a **failing** test — `tests/dateRange.test.ts` `describe("isWithinRange (T05 - half-open interval)")` against the buggy closed-interval seed `src/lib/dateRange.ts` (`date <= end`). That failing test **is the T05 task's own fail-before fixture**, i.e. one of the four benchmark tasks lives, pre-fix, in the shared corpus the gate runs in full.
- Therefore the behavioral gate is **structurally unsatisfiable for every non-T05 task by the correct task change alone.** Every first `commit_transaction` on T01/T03/T08 is rejected with the *identical, unrelated* `dateRange.test.ts` failure. The only way to `{ok:true}` is to **also fix the T05 bug**.

**Transcript evidence (substrate side, dispositive):**
- **T03 (regression guard):** `find_declarations → get_references → begin_transaction → rename_symbol → validate → commit_transaction{ok:false: dateRange…isWithinRange}` → **second transaction** `begin_transaction → rename_symbol → replace_body → validate → commit_transaction{ok:true}`. The `replace_body` is the agent fixing the unrelated T05 bug to land its rename. The proven **atomic single-transaction rename is gone**: 12 tools / 2176 tok / 44.8 s vs the proven 7–11 / 1201–1473 / 24–30 s.
- **T08:** agent verbatim — *"The test expects a half-open [start, end) interval but the body uses <= (closed). I need to fix isWithinRange in the same transaction."* It fixed T05's bug as collateral to land T08. Reported `failuresRetries=0` despite a visible `commit_transaction{ok:false}`→fix→`{ok:true}` self-correction (secondary instrumentation gap: the gate rejection is not counted by the retry rule).
- **T01:** 46 tools, 327 s (near the 420 s budget), three transactions, repeated gate rejections; `successCount=0`, `operationRowAppendedCount=0` — never converged. `vitestPassed=1` is a **scorer false-positive**: with nothing of T01 committed, the rendered tree ≈ seed, and the suite still fails on T05 — the 1 reflects a late incidental T05 touch, not a T01 success.
- **T05:** trivially `1/1` — the gate's whole-suite requirement *is* exactly its own task. Its prior "never reaches commit" thrash did not recur here, but this round cannot attribute that to the gate vs. model variance because the task and the gate are now the same thing.

**Bail-signal classification:**
- **BG-1 (flaky gate):** not triggered — deterministic (identical failure every run).
- **BG-2 (gate cost):** secondary — full render+tsc+vitest per commit attempt, ~2 attempts/task; per-invocation within the "seconds" tolerance, noted not blocking.
- **BG-3 (scorer relocation divergence):** not triggered — key-free `scopeEquivalence`/regression stayed green (`pnpm -r test` = 176 passing / 2 key-gated skipped). The *relocation* is behavior-preserving; the defect is the gate's **runtime scope**, a distinct axis from BG-3.
- **BG-4 (T03 regression):** **TRIGGERED.** T03 moved on every axis (tokens +~48%, +1 tool over the proven max, ~30→45 s) and, decisively, its **operation semantics changed** — the atomic rename now requires a second transaction repairing an unrelated seed bug to pass the gate. Spec: "any movement is a stop-and-diagnose, not a proceed."

**Conclusion:** The behavioral-commit-gate *concept* is not refuted, but the gate **as built is invalid against this shared multi-task corpus**: it conflates "did the agent's task succeed" with "does the whole corpus — including other tasks' deliberately-failing fail-before fixtures — pass." A change that type-checks and passes *its own* task's tests is still rejected because a *different* benchmark task's fixture is, correctly and by design, still red. This both breaks the T03 regression guard (BG-4) and contaminates the scorer for T03/T08 (their `vitestPassed=1` reflects the agent incidentally fixing T05). The `docs/RESULTS.md` "named next lever — now implemented, pending keyed validation" question is answered: **as-built, on this corpus, it does not validate.**

**Design-doc impact:** none to `strata-design.md`. Sharpens the prior entry: the agent finish line and the scorer finish line are now one function *by construction* — but when that one function is whole-corpus and the corpus co-locates multiple tasks' fail-before fixtures, the shared finish line is unreachable per-task. The "validate-before-commit" gate must be **task-scoped** to be a valid behavioral signal.

**Revisit when:** the operator chooses the gate-scope fix and re-runs. Options to weigh (not decided here): (a) the gate runs only the test files/names in scope for the active task (task metadata already names its fixture); (b) the benchmark corpus is per-task isolated so a task's gate never sees another task's fail-before fixture; (c) the gate asserts "no test regressed vs. the pre-change baseline" rather than "all green," so a pre-existing unrelated red is tolerated. Each is a substantive design change requiring its own spec/decision entry and a fresh keyed round with T03 re-established as the regression guard *before* any further generalization claim.

## 2026-05-16 — Behavioral commit gate: corpus runner lowered into @strata/verify; agent gate == scorer

**Context:** RESULTS.md named the next research lever — gate agent commit on behavioral task-acceptance, not just tsc-clean (underlies T08 and post-prompt T01). Spec: `docs/specs/2026-05-16-behavioral-commit-gate-design.md`; plan: `docs/superpowers/plans/2026-05-16-behavioral-commit-gate.md`.

**Considered:** (a) new `run_tests` agent tool the loop must call; (b) hard-gate inside the commit path reusing the existing validate-before-commit machinery; (c) both.

**Decided:** (b). The on-disk render+tsc+vitest runner (`renderStoreToDir`, `tsc*`, `vitestRun`, scope guards, `QualityResult`) moved from `@strata/bench` down into `@strata/verify` (`corpusRun.ts`); `@strata/bench/src/quality.ts` is now a thin re-export. New `runCorpusAcceptance` (captures subprocess output) and `commitWithBehavioralGate` (validate-as-today → corpus acceptance → finalize). The agent's `commit_transaction` calls the gate only for live runs (`acceptance` undefined in replay), so the 170 key-free tests and replay determinism are unchanged (post-change `pnpm -r test` = 176 passing / 2 key-gated skipped: the prior 170 + 6 new @strata/verify gate tests).

**Why:** Acyclic (`bench → agent → verify`); the agent finish line and the scorer finish line become one function by construction, removing the diagnosed confident-wrong commit. Additive: `commit()`/`validate()` signatures and behavior untouched.

**Execution findings (recorded per "record the failure too"):**
1. **Plan test-fixture defect, fixed.** The plan's `behavioralGate.test.ts` fixture created an empty on-disk `src/` while the source lived only in the in-memory store, so `validate()`'s `loadCompilerOptions`/`ts.parseJsonConfigFileContent` threw "No inputs were found in config file" against the `include: ["src/**/*.ts"]` glob. An implementer first masked this with a blanket `try/catch` around `validate()` in production code; that deviation was rejected (silent-failure anti-pattern, and unnecessary — the real corpus `examples/medium` is always on disk). Correct fix: the fixture now writes the seed `.ts` to disk before constructing the store, mirroring production; `commitWithBehavioralGate` is exactly as designed with no error-swallowing.
2. **Latent design assumption, documented not changed.** The gate is keyed on `runParams.replayTranscript` being absent as the proxy for "a live model is driving." This holds for every current caller (the only non-replay path reaching `runAgentForPrompt` is the genuine live benchmark + the key-gated `agentT03` test). A future deterministic non-replay caller would silently engage the corpus runner; flagged here for any such future caller's author.
3. **Pre-existing pipeline assumption, noted.** `commitWithBehavioralGate`'s abs→corpus-`src`-relative path mapping (shared with the pre-existing `renderStoreToDir`/scorer) assumes all modules live under `srcRoot`; a module outside `srcRoot` would write outside the scratch `src/` tree. Not a regression (pre-existing pipeline-wide), out of scope here, recorded for completeness.

**Design-doc impact:** none to architecture; sharpens strata-design.md's "validate before commit" gate — necessary but not sufficient; behavioral acceptance is now the agent's finish line for live runs.

**Revisit when:** the operator's keyed re-run (T01/T05/T08 with T03 as the regression guard) reports its finding — recorded as a new newest-first entry whatever the outcome, including "gate works but T05 still thrashes", per the spec's bail signals BG-1..BG-4.

## 2026-05-15 — Phase 1.5-P: prompt/description tuning is INSUFFICIENT (BS-P-B terminal); the gap is not prompt-closeable

**Context:** Operator re-validation after the P1 (explore-then-act prompt discipline) + P2 (rewritten `add_parameter` description) pass. Keyed N=1 with `--keep-artifacts` over T03/T01/T05/T08 ($1.12). Classification from the persisted substrate transcripts, as the protocol requires.

**Results (log-classified, not inferred):**
- **BS-P-A PASS — T03 did not regress.** Substrate 1/1, baseline 1/1, exactly as before. The prompt/description changes are safe on the proven, replicated win.
- **P1 ineffective (T05).** Transcript: `find_declarations`×14, `read_node`×9, one `begin_transaction`, ZERO mutations, wall-timeout — the *same* pure exploration thrash as the pre-P1 run. The general explore-then-act discipline paragraph did not change the agent's behavior at all.
- **P2 ineffective (T01).** Transcript: `begin_transaction`→`add_parameter`→`replace_body`×3→rollback→`begin_transaction`→`add_parameter`→`replace_body`×2→commit→`begin_transaction`→`replace_body`→commit. The agent still hand-patches callsites with `replace_body` despite the rewritten description *explicitly forbidding exactly that*. It committed this round (N=1 variance, criteria still 0/1) via the same wrong behavior.
- **T08 flipped to 1/1 at N=1** — treated as model variance per the spec's "a changed T08 is not an improvement claim", not a fix; the commit-gate gap is unaddressed by design this pass.

**Decided / concluded (BS-P-B terminal — do NOT iterate the prompt further):** The Phase 1.5 multi-decision-task failures are **not prompt- or description-tunable**. A fair, general (non-scripted) rework of both the navigation discipline and the most-misused tool's description left agent behavior byte-for-byte unchanged on the failing tasks. The agent ignores explicit worldview discipline and an explicit prohibition for these tasks, while following the same style of guidance perfectly for the single-operation rename (T03). The honest synthesis across Phases 1/1.5: **the file-abstraction-removal advantage is real, robust, and replicated for atomic single-operation structural edits (rename: wins every harness iteration and survives the prompt change), but does not generalize to multi-step agent-driven refactors, and that gap is NOT closeable by prompt engineering.** The remaining real levers are deeper (commit-gate/in-loop-acceptance redesign — implicated in T01 and T08 — or a model-capability limit at an 11-tool multi-decision surface), not more tuning.

**Design-doc impact:** none to architecture. Empirically sharpens strata-design.md's thesis: the substrate efficiency claim is demonstrated for atomic operations and is an open question for multi-step refactors; prompt engineering is shown insufficient to bridge it.

**Revisit when:** a future effort takes on the deferred commit-gate/loop redesign as a deliberate research item, or evaluates a stronger model at this tool surface. Not by another prompt pass.

**Context:** Fixed the `--keep-artifacts` -> `logPath` instrumentation gap in `packages/bench/src/configs/substrate.ts` (when `keepArtifacts` and no explicit `logPath`, derive a discoverable `results/logs/<task>-substrate-trial<N>-<stamp>.jsonl`; 170+2 tests stay green, no test files edited). A cheap targeted keyed round (T01/T05/T08, N=1, $0.48) then persisted real substrate transcripts, enabling the spec-mandated log-based R3 classification instead of aggregate inference.

**Transcript evidence (substrate side):**
- **T05 (one-line bugfix, the inverted control): pure BS15-E exploration/decision thrash.** 23 tool calls, ZERO mutation calls, 1 `begin_transaction`, 1 `validate`; 14 `read_node` (11 consecutive) + 5 `find_declarations`. The agent never attempted the fix — it loops on cheap read-only structural tools and never commits to acting. The file baseline did this in 5 tools / 16s.
- **T01 (add_parameter): tool-illegibility + thrash.** 34 calls: `begin_transaction`->`add_parameter`->`replace_body`x3->rollback->`begin_transaction`->`replace_body`x3->`add_parameter`, never a clean `validate`. The agent does not trust/understand `add_parameter`'s callsite fan-out, falls back to hand-patching with `replace_body`, loops and rolls back.
- **T08 (change_return_type): NOT thrash — a deeper correctness-gate gap.** Clean 15-call run: `begin_transaction`->`change_return_type`->`replace_body`x2->`validate`->`commit_transaction`, terminal success. The agent confidently committed; tsc-clean `validate` passed; but the corpus vitest fails. The substrate's commit gate (tsc-clean) is weaker than the task's real success criterion, so the agent commits confidently wrong with no signal.

**Conclusion:** The Phase 1.5 negative is not a single fundamental substrate failure. It decomposes into: (a) **agent navigation/decision discipline** (T05 thrash) — likely system-prompt-tunable (explore-then-act budget; the cheap structural read tools enable infinite stalling); (b) **tool legibility** (T01) — `add_parameter`'s callsite-fan-out semantics aren't conveyed well enough for the agent to wield it instead of hand-patching; tool-description + prompt work, medium; (c) **commit-gate weakness** (T08) — the most significant: `validate` (tsc-clean) is not the task's success criterion, so confident-but-wrong commits pass. This is a loop/design question (the agent likely needs task-acceptance/test signal in-loop, not just tsc), not a tool bug. Rename (T03) works because it is a single unambiguous operation with one path and no decisions; the expanded toolset introduces choices the current prompt+tool-descriptions+commit-gate do not equip the agent to make.

**Design-doc impact:** none to architecture; this refines the prior honest-negative entry with mechanism. It identifies that strata-design.md's "validate before commit" gate is necessary but not sufficient for task correctness — a real finding for any future agent-loop design.

**Revisit when:** the operator decides the next lever (prompt/tool-description rework for a,b; commit-gate/in-loop-test redesign for c) vs. accepting the scoped result and writing up. The classification, not more benchmark runs, is what should drive that decision.

## 2026-05-15 — Phase 1.5 re-validation: harness now valid; T03 win replicates; new tools are NOT agent-effective (honest negative)

**Context:** Post-remediation operator re-validation, `claude-sonnet-4-6`, N=1 (8 runs $0.76) + a targeted T01/T05/T08 round ($0.43). The remediation (R1/R2/R3) is confirmed working: scoring is symmetric and valid (both configs `tsc clean 1/1` everywhere; T03 baseline passes again exactly as in the valid Phase 4 round — proving the harness is fair, not rigged).

**Result (N=1, indicative not a significance claim — and N=3 deliberately NOT run because the pattern does not hold):**
- **T03 (rename): the Phase-1 win replicates under the now-valid harness.** Both succeed; substrate ~2.9x fewer tokens (1359 vs 3910), ~1.8x faster (30.6s vs 56.4s), 0 vs 2 retries. Robust.
- **T01 (add_parameter):** substrate `error_wall_time`; at the raised 420s/40t budget it did MORE tool calls (33) than the prior 240s round (22) and still failed. More budget produced more work, not success → by the R3 anti-inflate clause this is NOT budget-bound; do not raise further.
- **T05 (the reasoning control):** baseline succeeds trivially (5 tools, 16s); substrate `error_wall_time` at 12 tool calls / 300s. The control is INVERTED — the substrate loses where the file baseline trivially wins. The strongest possible evidence the gap is the substrate, not a rigged comparison.
- **T08 (change_return_type):** substrate terminated "success" but the corpus vitest fails (0/1); it passed pre-remediation — that earlier "win" was a scoring artifact the symmetric scorer correctly destroyed.

**Decided / concluded:** Phase 1's `rename_symbol` substrate advantage is real and replicable. Phase 1.5's tool expansion (`add_parameter`, `change_return_type`, `replace_body`) does NOT generalize that advantage: the tools pass 170 unit tests but the agent cannot effectively wield them on real tasks. Do NOT run N=3 (would spend ~$3 confirming a non-pattern). Do NOT inflate budgets (forbidden by BS-R3; more budget already produced more thrash, not success).

**Instrumentation gap (a real harness defect, recorded per "log the failure too"):** the R3 spec required operator timeout classification from the session log, but `--keep-artifacts` does not actually persist a readable per-tool transcript — `substrate.ts` takes a `logPath?` and the runner threads a `keepArtifacts` boolean, but nothing converts the boolean into a concrete written log and trial records carry no `sessionLog`. So the precise budget-bound-vs-BS15E-thrash-vs-tool-ergonomics label cannot be log-classified as the protocol demands; the conclusion above is drawn from aggregates (terminal reasons, tool counts vs. budget, the inverted control), which is strong but not the spec-mandated method.

**Design-doc impact:** none to the architecture; this is an empirical finding about agent-effectiveness of the new tools + a harness instrumentation defect. The strata-design.md thesis stands on T03; it is NOT demonstrated for the broader tool set.

**Revisit when:** the keepArtifacts->logPath wiring is fixed and a cheap targeted round captures real transcripts → then classify (thrash vs ergonomics) to guide tool/prompt rework; that rework, not a benchmark re-run, is the next lever for the Phase 1.5 tools.

**Context:** Phase 1.5R's three fixes (R1 seed-clean, R2 scorer/quality scope equivalence, R3 per-task budget + classification protocol) are implemented and green key-free.

**Decided / Observed:** Acceptance holds before any operator live round: (1) unmodified seed src is `tsc --noEmit` clean under the post-R1 src-only corpus tsconfig; `tests/` remains present, in `vitest.config.ts` include, and a real fail-before signal. (2) `scopeEquivalence.test.ts` passes for all four tasks × correct/half-done/seed: substrate-side pure core and baseline-side `scoreTaskSharedCriteria` return byte-identical text booleans, and tsc scope is `["src/**/*.ts"]` with no `tests/`. (3) Per-task `maxTurns`/`wallTimeMs` are first-class in `runner.ts` and threaded unchanged into the session; T03/T08 remain 25t/240000ms by default, while T01/T05 carry the artifact-derived higher defaults; the projected-spend line prints the per-task ceiling. (4) `pnpm -r build` and `pnpm -r test` are green key-free: existing 152 passing + 2 skipped baseline held, plus 18 passing cases in the two allowed new bench test files. The genuine T03 regression guards are byte-unchanged. No BS-R1/R2/R3 fired during implementation.

**Why:** Only a valid harness may produce a number anyone should believe; the N=1→N=3 validation-before-distribution discipline is unchanged.

**Design-doc impact:** none.

**Revisit when:** the operator runs the keyed re-validation N=1; record its DR-round entry regardless of outcome.

## 2026-05-15 — R3: per-task maxTurns/wallTimeMs first-class + --task-budget + timeout-classification protocol (Phase 1.5R DR3)

**Context:** Phase 1.5R remediation. Substrate T01 timed out at 22 tool calls and T05 at 17 under the 240,000 ms global wall. Budgets were single global values; the structurally bigger tasks need justified per-task budgets plus a protocol that classifies timeouts rather than inferring them.

**Considered:** (a) raise the single global budget; (b) make maxTurns/wallTimeMs per-task overridable with artifact-derived defaults for T01/T05, T03/T08 untouched, plus operator-recorded classification.

**Decided:** (b). `runner.ts` now has `PerTaskBudget`, `DEFAULT_PER_TASK_BUDGET` (T01 40t/420000ms, T05 40t/300000ms; T03/T08 no override and therefore global 25t/240000ms), `resolveTaskBudget`, `parseTaskBudget`, and `--task-budget=T01:maxTurns=40,wallMs=420000;T05:maxTurns=40,wallMs=300000`. The projected-spend line prints resolved per-task budgets. `SessionLog` `session_start` now records `wallTimeMs` alongside `maxTurns` so operator timeout classification has the configured budget in the log.

**Timeout-classification protocol (operator-recorded, never auto-inferred):** every substrate `error_wall_time`/`error_max_turns` is classified from the session log into exactly one bucket and recorded as `T0N: <bucket> — <one-sentence evidence>`: (1) budget-bound, monotonic progress; one bounded logged raise and one re-run only; (2) BS15-E thrashing, wrong-tool loops or oscillation; surface the tool-selection finding, do not inflate; (3) genuine tool-ergonomics failure, right tool cannot express the task; surface the substrate limitation. A second bucket-1 timeout at the raised budget escalates to bucket 3.

**Why:** Quantified, bounded, honest. T03/T08 budgets are unperturbed, while T01/T05 get room justified by the failing artifact without opening an inflate-until-green loop.

**Design-doc impact:** none — additive runner plumbing; the session budget contract is unchanged.

**Revisit when:** the re-validation round's classified evidence shows T01/T05 need a different shape of help than one bounded raise; that is the honest BS15-E finding, not a third raise.

## 2026-05-15 — R2c: scopeEquivalence.test.ts proves substrate==baseline byte-identical over the identical src-only scope (Phase 1.5R DR2c, BS-R2 gate)

**Context:** Phase 1.5R remediation. The methodology requires the BS-Bench-B/BS15-C identical-core property: "did the task succeed" must be the same question for substrate and baseline, over the identical scope, through one pure core.

**Considered:** n/a — this is the key-free gate and bail-signal observation.

**Decided / Observed:** Added `packages/bench/tests/scopeEquivalence.test.ts`: per task (T01/T03/T05/T08) × state (correct/half-done/seed), the substrate-side pure `evaluateT0NTextCriteria` core and the baseline-side `readModuleMap`→`scoreTaskSharedCriteria` path return byte-identical text-criteria booleans on the same logical post-edit Map. The test also asserts the materialized corpus tsconfig scope is exactly `["src/**/*.ts"]` while `tests/` remains present, and that `tscNoEmitSrc` fails loudly if `tests/` is reintroduced. BS-R2 did not fire; no byte-frozen existing test was edited.

**Why:** A non-equivalent scorer invalidates every number. This proves equivalence key-free before any operator live round, exactly as D1/D2/D12 require.

**Design-doc impact:** none — restores and gates the identical-core integrity property.

**Revisit when:** render canonicalization diverges from baseline whitespace for a semantically-identical result on any task (BS-R2 fires — do not ship that task's number, do not fork the core).

## 2026-05-15 — R2b: evaluateT0NCriteria returns the rendered Map additively; substrate resultQuality unified to the baseline's two probes (Phase 1.5R DR2b)

**Context:** Phase 1.5R remediation. The substrate `resultQuality` was not scope-equivalent: T03 re-derived a deterministic rename and T01/T05/T08 mirrored `validateAfterCommitClean`, while the baseline ran `tscNoEmit` and `vitestRun` over its edited temp tree. `runAgentForPrompt` closes its in-memory DB before returning, so resultQuality needs the final rendered text before closure.

**Considered:** (a) re-derive each task deterministically; (b) have the per-task `evaluateT0NCriteria` wrapper additively expose the rendered `Map<modulePath,text>` it already builds, then materialize that exact Map to a scratch corpus-shaped tree and run the same probes as baseline.

**Decided:** (b). `evaluateT0{1,3,5,8}Criteria` now returns `T0NCriteria & { rendered: Map<string,string> }`; the property is non-enumerable so existing boolean `Object.entries(criteria)` regression guards stay unchanged. `AgentT03Result`/`AgentTaskResult` carry optional `rendered`. `substrate.ts` now uses one quality path for every task: materialize `result.rendered` as `src/`, copy post-R1 `tsconfig.json`, `package.json`, `vitest.config.ts`, and seed `tests/`, symlink repo `node_modules`, then run `tscNoEmitSrc` and `vitestRun`.

**Why:** Substrate quality is now measured on the exact text the shared per-task core scored, using the same src-only typecheck and real vitest signal as the baseline. BS-R2 did not fire at this step; no byte-frozen tests were edited.

**Design-doc impact:** none — restores the scorer-equivalence requirement D1/D2/D12 already mandate.

**Revisit when:** a future task's committed output cannot be expressed as a rendered src Map; that would be a BS-R2 finding for that task's quality sub-metric.

## 2026-05-15 — R2a: src-scoped tscNoEmitSrc with an explicit scope guard; baseline points at it (Phase 1.5R DR2a)

**Context:** Phase 1.5R remediation. Pre-fix the baseline typechecked its whole temp tree through the corpus tsconfig while the substrate typechecked rendered src only. Post-R1 the tsconfig is src-only, but a future re-add of `tests/**` would silently re-break equivalence unless the quality path asserts the scope.

**Considered:** (a) rely on R1 alone; (b) add an explicit `tscNoEmitSrc` wrapper that asserts the resolved corpus `include` is src-only before delegating to the unchanged `tscNoEmit`.

**Decided:** (b). `quality.ts` now exports `resolveCorpusTsconfigInclude`, `assertSrcOnlyScope`, and `tscNoEmitSrc`. The baseline `defaultValidateWorkingTree` uses `tscNoEmitSrc`; the original `tscNoEmit` remains unchanged for compatibility and existing regression guards.

**Why:** The src-only typecheck invariant is now enforced where the quality probe runs, so a future `tests/` glob fails loudly instead of producing a non-equivalent benchmark number.

**Design-doc impact:** none — additive helper enforcing the existing scorer-equivalence requirement.

**Revisit when:** the corpus legitimately needs a non-`src/`-prefixed production glob; broaden the assertion while retaining the explicit `tests/` exclusion.

## 2026-05-15 — R1: corpus typecheck scope is src-only; vitest is the test-based signal (Phase 1.5R DR1)

**Context:** Phase 1.5R remediation. The N=1 round surfaced that `examples/medium/tests/format.test.ts` is written against the post-`add_parameter` signature, so `tsc --noEmit` over a scope including `tests/` fails on the unmodified seed and breaks the seed-clean invariant.

**Considered:** (a) edit/delete the post-signature assertions to make the seed clean (BS-R1: weakens T01's bar); (b) exclude `tests/` from the corpus typecheck scope while keeping it in the vitest scope so the test-based signal remains fail-before/pass-after.

**Decided:** (b). `examples/medium/tsconfig.json` `include` is now `["src/**/*.ts"]`. `compilerOptions`, `vitest.config.ts`, `tests/`, and all `src/` fixtures are unchanged. "The corpus compiles" (`tscClean`) now means "src compiles"; the task test signal runs under vitest. Key-free acceptance: unmodified seed src is `tsc --noEmit` clean, while `tests/` stays on disk, in the vitest include, and remains a real fail-before signal.

**Why:** Restores the seed-clean invariant without weakening a task criterion. T01's post-task signature is still required by `evaluateT01TextCriteria` and by `tests/format.test.ts` running under vitest. BS-R1 did not fire.

**Design-doc impact:** none — corrects an implementation regression and confirms validation-before-distribution discipline.

**Revisit when:** the corpus gains a non-test src module that legitimately must be excluded, or a future task genuinely requires `tests/` in the typecheck scope (would reopen BS-R1).

## 2026-05-15 — Phase 1.5 N=1 validation round caught an invalid 4-task harness; remediation before any N=3

**Context:** First keyed 4-task live round, N=1 validation (8 runs, $0.73), `claude-sonnet-4-6`. Run as a cheap gate before the N=3 distribution. It did its job: results were NOT a clean pattern and diagnosis found the harness invalid, not the substrate beaten.

**What the round showed:** substrate T03 ✓ and T08 ✓ (rename + change_return_type work end-to-end via the agent); substrate T01 and T05 hit `error_wall_time`; baseline 0/1 on ALL four tasks including T03 (which the baseline passed cleanly 3/3 in the Phase 4 round).

**Root causes (three, distinct):**
1. **Seed-clean invariant broken (Pass 3 fixture defect).** `examples/medium/tests/format.test.ts` is written against the post-`add_parameter` signature (asserts a 2nd param; calls with 2 args). On the unmodified seed `formatTimestamp` takes 1 arg, so `tsc --noEmit` over the whole seed corpus is NOT clean (2 diagnostics). Runtime fail-before/pass-after is correct for a test-based criterion, but it must not make the seed fail typecheck.
2. **Substrate/baseline tsc-scope asymmetry (scorer non-equivalence).** `quality.ts` tsc's the baseline's whole temp tree (incl `tests/format.test.ts` → fails → baseline `tscClean:false` on every task → baseline 0/1 across the board, incl T03). The substrate re-derives quality from only its rendered changed modules — a different file set. The two configs are typecheck-judged over different scopes, violating the BS15-C/BS-Bench-B identical-core integrity property the methodology depends on.
3. **Substrate timeouts on T01/T05** (`error_wall_time`, 17–22 tool calls before the wall) — independent of scoring. Wall-time too tight for the harder tools, and/or BS15-E (tool-selection thrashing at the 11-tool surface), and/or tool ergonomics. Needs its own diagnosis; may be an honest "substrate struggles here" result.

**Decided:** Do NOT run N=3 on an invalid harness; do NOT hack the fixture green. Remediate all three (operator-approved "fix all 3 properly"): (1) exclude `tests/` from the corpus tsconfig so "tscClean" means "src compiles" with vitest as the separate test-based success signal, restoring the seed-clean invariant; (2) make substrate AND baseline score/tsc the identical file scope (restore scorer equivalence); (3) raise/parameterize wall-time for the harder tools and re-diagnose the T01/T05 timeouts (BS15-E). Then re-run N=1 validation, then N=3. Remediation goes through the spec→plan→Codex machine.

**Design-doc impact:** none — confirms the validation-before-distribution discipline and the scorer-equivalence requirement; corrects an implementation regression, not the design.

**Revisit when:** the remediated N=1 re-validation either clears (proceed to N=3) or surfaces a genuine substrate limitation on T01/T05 (report honestly, do not massage).

## 2026-05-15 — Bench task abstraction; T03 path preserved unchanged (Phase 1.5 Task 12 / D14)

**Context:** The Phase 4 harness was T03-specific (`task:"T03"`, hard-wired scorer/report). The four-task pattern needs T01/T05/T08 beside T03 without rewriting the proven path.

**Decided:** Added `BenchTask` (`packages/bench/src/tasks/`, one module per task), generalized `runner.ts` to loop a `--tasks` list (default all four), kept `bench:t03` as `--tasks=T03`, and added `bench` for the four-task default. Per-task baseline/substrate runners delegate to the matching `@strata/verify` per-task core through `scoreBaselineTask` / `runAgentTask`; T05 threads seed and post-edit test text symmetrically for the byte-identical anti-cheat. The report gained `buildSuiteReport`/`renderSuiteMarkdown`: per-task distributions plus a cross-task pattern section stating the claim and falsifier (structural tasks separate and T05 does not, else report honestly). Existing `buildReport`, `runSubstrateTrial`, `runBaselineTrial`, and `runAgentT03` signatures are preserved for the Phase 4 T03 path.

**Why:** Generalize the harness without forking the T03 regression path. Scorer cores stay in `@strata/verify` to preserve the acyclic package graph and config-equivalent scoring discipline.

**Design-doc impact:** none — additive generalization on the reserved bench slot.

**Revisit when:** a fifth task is added (add a task module and verify core; the runner does not change) or the live round shows a per-task scorer is not config-portable (BS15-C — do not ship that task's number).

## 2026-05-15 — Agent surface 8 -> 11; minimal prompt additions; BS15-E framing (Phase 1.5 Task 11 / D13)

**Context:** The three new mutation tools must be agent-visible. Going 8->11 may degrade tool selection (BS15-E).

**Decided:** Registered `add_parameter`, `change_return_type`, and `replace_body` in `tools.ts` over the shared `{ db, actor }` context, with zod shapes reusing `nodeIdSchema`/`txHandleSchema`, and added all three to `STRATA_TOOL_NAMES`/qualified tool names for the runtime guard. Prompt changes are minimal: one plain-English sentence per new tool plus a "Choosing the right mutation" paragraph. The single worked pattern stays rename and key-free tests assert no benchmark-specific prompt recipes. The obsolete pre-existing tool-surface count assertion was updated 8->11; T03 behavior tests were not changed.

**Why:** Mechanical registration; the hermetic isolation contract is unchanged. BS15-E is an empirical live-round question, not something inferred from no-key tests. Wrong-tool paths must not be scored as substrate wins and task-specific recipes must not be added to hide tool-selection confusion.

**Design-doc impact:** takes the mutation-tool count to four (rename + the three), inside `strata-design.md` Phase 1 "5-7" target.

**Revisit when:** the live round shows the agent cannot reliably select the right mutation tool after honest prompt iteration (BS15-E — surface as the tool-granularity finding; do not paper over).

## 2026-05-15 — Agent session generalized to per-task entry points; T03 path preserved (Phase 1.5 Task 10)

**Context:** Phase 4's substrate path is `runAgentT03`/`T03_PROMPT`, T03-specific. The four-task benchmark needs T01/T05/T08 substrate runs without forking the proven T03 loop.

**Decided:** Extracted the `runAgentT03` body into an internal `runAgentForPrompt(params, prompt, scoreFn)`; `runAgentT03` now delegates to it with public signature/return unchanged. Added `TASK_PROMPTS` and `runAgentTask(taskId, ...)` selecting prompt plus the matching `@strata/verify` per-task scorer. `runLiveSession`'s prompt is parameterized and defaults to `T03_PROMPT`. Hermetic Options are reused unchanged.

**Why:** One session loop, zero intended behavior change for T03, and no live call added. Replay/synthetic tests remain the key-free guard; the existing T03 replay and live-test path stay the regression net.

**Design-doc impact:** none — additive generalization.

**Revisit when:** a fifth task is added (extend `TASK_PROMPTS` and a scorer; the loop does not change).

## 2026-05-15 — T05 control scorer core in @strata/verify; symmetric anti-cheat (Phase 1.5 D12 — T05, BS15-C/BS15-D)

**Context:** T05 is the reasoning control: parity is the credibility anchor. Its criteria include the anti-cheat "test file byte-identical to seed", which MUST be applied identically for both configs or the control is invalid.

**Decided:** `packages/verify/src/t05Criteria.ts` mirrors `t03Criteria.ts`: pure core (half-open comparison present, closed interval gone, test file byte-identical), with `seedTestText` passed in explicitly and never file-read inside the core. The substrate wrapper renders committed source modules and feeds the seed test under `T05_TEST_KEY`; the baseline adapter will feed its post-edit test text under the same key. Substrate-only `operationRowAppended` = ReplaceBody. Core stays in verify (no cycle).

**Why:** T05 must be expressible by BOTH configs as a localized body edit with no reference-graph advantage to the substrate (`replace_body` confers none of the fan-out leverage that wins T01/T03/T08). The passed-in seed text makes the anti-cheat provably symmetric (BS15-D), and the BS15-C key-free equivalence test feeds file text and rendered store text through one core.

**Design-doc impact:** none.

**Revisit when:** the live round shows T05 gave the substrate a structural advantage or handicapped the baseline (BS15-D — stop and surface; do not tune T05 to manufacture parity or a win).

## 2026-05-15 — T08 per-task scorer core in @strata/verify; BS15-C did NOT fire for T08 (Phase 1.5 D12 — T08)

**Context:** T08 (return-type narrowing) needs one provably-identical pure core for both configs.

**Considered / Decided:** Same as D12-T01: `packages/verify/src/t08Criteria.ts` mirrors `t03Criteria.ts`; pure text core (literal-union return type, no `as string` on `getRole` results, caller guards intact), substrate wrapper renders committed store modules and adds substrate-only `operationRowAppended` (ChangeReturnType). Core stays in verify (no cycle).

**Why:** BS15-C key-free equivalence feeds file text and rendered store text through one core and asserts identical text booleans. T08's number is portable across substrate and baseline only because the scorer has no config-specific branch.

**Design-doc impact:** none.

**Revisit when:** render canonicalization diverges from baseline whitespace for a semantically-identical T08 result (BS15-C fires — do not ship T08's number, do not fork the scorer).

## 2026-05-15 — T01 per-task scorer core in @strata/verify; BS15-C did NOT fire for T01 (Phase 1.5 D12 — T01)

**Context:** T01 needs substrate and baseline scored by one provably-identical pure core (BS-Bench-B / BS15-C discipline), the T03 pattern.

**Considered:** (a) duplicate regexes in the bench adapter; (b) one pure `evaluateT01TextCriteria(Map)` core in @strata/verify fed by substrate-render and baseline-file adapters; (c) move it to bench.

**Decided:** (b). `packages/verify/src/t01Criteria.ts` mirrors `t03Criteria.ts`: pure text core (timezone signature/default, server `"UTC"` callsites, UI `"local"` direct callsite, HOF reference not mis-edited), and `evaluateT01Criteria` renders committed store modules then delegates to the same core while adding substrate-only `operationRowAppended` (AddParameter). Core stays in verify (no cycle).

**Why:** "T01 succeeded" means byte-identically the same for both configs. The BS15-C key-free equivalence test feeds file text and rendered store text through the same core and asserts identical text booleans, gating T01's number.

**Design-doc impact:** none — additive scorer core mirroring D1.

**Revisit when:** render canonicalization diverges from baseline whitespace for a semantically-identical T01 result (BS15-C fires — do not ship T01's number, do not fork the scorer).

## 2026-05-15 — examples/medium gains a runnable offline vitest suite; baseline temp-tree resolves vitest via node_modules symlink (Phase 1.5 D11, Open Question 2 / BS15-D gate)

**Context:** T01/T05 success criteria are `pnpm vitest run`. examples/medium had no src/lib, no tests, no vitest dep; `materializeCorpus` copied without installing; the implementer cannot reach the registry. This is exactly the "Revisit when: the corpus gains its own vitest suite" condition the 2026-05-15 "Baseline temp-checkout" entry named.

**Considered:** (a) `pnpm install` into the temp tree (needs registry and is operator-only); (b) symlink the repo-root node_modules into the temp tree (vitest + typescript already on disk via pnpm); (c) symlink only vitest/.pnpm/typescript/@types.

**Decided:** (b). Added `src/lib/{format,dateRange,permissions}.ts`, `src/server/events.ts`, `src/ui/timeline.ts`, `tests/{format,dateRange}.test.ts`, `vitest.config.ts`, a `package.json` test script + documentary vitest devDep, and `tests/**` in the corpus tsconfig include. `materializeCorpus` removes any copied corpus `node_modules` cache and symlinks the repo-root `node_modules` into the temp tree after the recursive copy, so the baseline's `pnpm vitest run` resolves offline with ZERO registry at run time. The seed deliberately fails the new signal (`dateRange` closed-interval bug, and T01's missing parameter is caught by the corpus typecheck/type-level test), so the suite is not vacuous. Existing T03 modules are left byte-identical.

**Why:** The deps already exist on disk; resolution is the only gap. No `pnpm install`, no registry, no per-trial dependency cost. The whole-node_modules symlink did not need the narrower fallback in this environment.

**Design-doc impact:** none — implements spec § Fixtures + Open Question 2; supersedes the "Baseline temp-checkout" entry's "no install/symlink required" clause (the corpus now has a vitest suite, exactly its named Revisit condition).

**Revisit when:** the corpus gains real runtime (non-dev) deps, an SDK/vitest upgrade changes resolution, or the live baseline shows the symlink form needs to be the narrow (c) variant.

## 2026-05-15 — add_parameter shipped (Phase 1.5 D10 — tool)

**Context:** With BS15-B cleared by the callsite-resolution probe, the tool now fans an argument out to resolved direct callsites.

**Considered:** n/a — settled by spec; build record.

**Decided:** `packages/store/src/addParameter.ts` follows the spine: validate name/type/default via public-API parse; declaration edit inserts `name: type[ = default]` at the clamped position as a zero-width text-span edit; each direct callsite from `resolveCallsites` gets a zero-width arg-slot edit at the matching argument position (slot value = the parameter default if any else `undefined`); one `AddParameter` op row records affected = [declaration, ...callsiteStatements]. HOF/aliased reference identifiers are NOT edited, so the compiler flags arity/type breaks honestly rather than the tool silently mis-editing them.

**Why:** Clean spine extension for the declaration edit; the callsite fan-out reuses the BS15-B-cleared resolver and stays reference-graph based, not text search. The tool's deterministic guarantee is "every resolvable direct callsite gets an argument slot"; the semantic value remains the caller's per-site decision.

**Design-doc impact:** none — implements spec § tool specs / `add_parameter`.

**Revisit when:** a live T01 round shows a callsite shape the resolver misses (re-probe before assuming a wall — BS15-B discipline).

## 2026-05-15 — add_parameter callsite resolution probed; BS15-B did NOT fire (Phase 1.5 D10 — probe)

**Context:** BS15-B: the genuine-new-work risk of Phase 1.5. `node_references` resolves reference identifiers, not enclosing CallExpression argument lists.

**Considered:** (a) accept BS15-B as a substrate wall; (b) investigate whether re-parsing the referring statement + walking up from the reference identifier to its enclosing call (callee === that identifier) reliably resolves callsites, with HOF/aliased uses correctly classified as non-argument arity-risk sites.

**Decided / Observed:** (b). `packages/store/src/callsites.ts` `resolveCallsites(db, functionId)` resolves direct and template-literal callsites and correctly classifies `.map(formatTimestamp)` and `const f = formatTimestamp` as `nonCallReferences` (compiler-flagged arity breaks, never silently mis-edited). The probe fixture produced counts `{ resolvedDirectCallsites: 2, arityRiskReferences: 2, unresolvedReferences: 0 }`; import-specifier references are ignored as import edges, not callsites or arity-risk sites. Public TS APIs only (BS1 discipline). The substrate's reference-integrity pitch holds for callsite fan-out on the T01 stress shapes tested here.

**Why:** A missed callsite must not be papered over with text search — that abandons the substrate's whole argument. The probe is isolated and early so a fired signal stops the phase before the tool is built.

**Design-doc impact:** none — confirms the spec crux's add_parameter feasibility argument held in implementation.

**Revisit when:** the T01 corpus or live round surfaces a callsite shape (e.g. re-exported-then-called, decorator) the walk-up misses — re-probe before assuming a wall, same as BS1.

## 2026-05-15 — replace_body shipped; input is validated body text, not structured AST (Phase 1.5 D9, Open Question 3)

**Context:** Phase 1 stores bodies as raw text and renders canonically; `replace_body` needs an input shape.

**Considered:** (a) structured AST body input + a body-construction API + structured render path; (b) validated `{ ... }` body text the tool syntactically pre-checks.

**Decided:** (b). `packages/store/src/replaceBody.ts` takes a body string including braces, wraps it as `function __probe__() <body>` + `ts.createSourceFile`, requires one `ts.Block` consuming the whole text and zero compiler syntactic diagnostics through the public `ts.createProgram` API, then queues one whole-body `textSpanMutation` + one `ReplaceBody` op row (params: function_id + new_body_len; the literal body is recoverable from the post-commit payload). Interior identifiers of the new body are NOT lowered/re-resolved into `node_references` — the same limitation Phase 1 documented; validate-before-commit is the safety net (a body referencing something undefined fails tsc and commit blocks). Identical-body / non-FunctionDeclaration / no-body are no-op/throw.

**Why:** Matches the storage model; (a) is the deferred Phase 2 lowering and out of scope. T05's fix is a single-statement comparison flip with no new cross-module references, so the interior-reference caveat does not bite the control.

**Design-doc impact:** none — implements spec § tool specs / `replace_body` + Open Question 3.

**Revisit when:** a task needs interior-reference integrity after `replace_body` (logged Phase 2 decision; would be BS15-A if T05 needed it — it does not).

## 2026-05-15 — change_return_type shipped on the rename spine (Phase 1.5 D8)

**Context:** Phase 1.5's lowest-risk tool: change a function declaration's return-type annotation.

**Considered:** n/a — settled by spec; this records the build shape.

**Decided:** `packages/store/src/changeReturnType.ts` follows the `rename.ts` spine: declaration lookup → `locateSpan(payload,"returnType")` → one `textSpanMutation` (replace existing annotation, or insert `: T` after the param list `)` when absent) → one `ChangeReturnType` op row. Identical-type and non-FunctionDeclaration are no-op/throw, mirroring `rename_symbol`. The tool edits ONLY the annotation; caller repair is agent reasoning (T08 framing), not a tool fan-out. Type validity is a public-API syntactic pre-check (wrap + `ts.createSourceFile` + compiler syntactic diagnostics through `ts.createProgram`), not a hand-rolled grammar or internal parser diagnostics.

**Why:** Clean spine extension on the Task 1 overlay + Task 2 locator; no lowering (BS15-A did not fire for this tool).

**Design-doc impact:** none — implements spec § tool specs / `change_return_type`.

**Revisit when:** a task needs the tool to also repair callers (it does not — that is agent reasoning per spec/T08).

## 2026-05-15 — On-demand re-parse span location, no ingest lowering (Phase 1.5 D7, Open Question 1)

**Context:** The three tools must locate parameter-list / return-type / body spans inside a function declaration on the current statement-raw-text + identifier-child model.

**Considered:** (a) extend ingest to lower parameters/bodies/return-types into structured nodes; (b) locate spans on demand by re-parsing the statement's own stored raw payload with `ts.createSourceFile` + public `getChildren`.

**Decided:** (b). `packages/store/src/spanReparse.ts` exports `locateSpan(payload, "params"|"returnType"|"body")`. The payload IS `statement.getFullText`, so re-parsed offsets are payload offsets directly; absent return type / empty param list return a zero-width insertion span. Public TS APIs only (`createSourceFile`, `getChildren`, `getStart`/`getEnd`); no internal properties, no `forEachChild`+`.jsDoc` (BS1 discipline).

**Why:** Exact and schema-free; structured lowering is deferred Phase 2 work and not needed for the three tasks. One source of truth so the tools don't each hand-roll re-parse.

**Design-doc impact:** none — additive store helper.

**Revisit when:** a tool needs structured nodes rather than a text span (BS15-A — stop and surface).

## 2026-05-15 — textSpanMutations overlay + generalized spliceStatement (Phase 1.5 D6, Open Question 1)

**Context:** Phase 1.5's three tools edit non-identifier regions (parameter list, return type, body) of a statement's raw payload. Phase 1's overlay was identifier-text only.

**Considered:** (a) structured AST-node lowering of params/bodies/return-types; (b) generalize the existing text-splice mechanism to arbitrary text spans, with identifier mutation as the degenerate case.

**Decided:** (b). `TxOverlay` gains `textSpanMutations: Map<statementId, TextSpanEdit[]>` where `TextSpanEdit = { start, end, oldText, newText }`; `IdentifierMutation` is the degenerate span. `spliceStatement`, render, and `commitWithoutValidate`/`materializeStatementPayloads` apply text-span edits with the same descending-offset, oldText-checked algorithm Phase 1 used; identifier offsets reshift by the net text-span delta. `TextSpanEdit` is owned by `@strata/store`; `render` consumes it (keeps `render → store` one-directional, no cycle).

**Why:** The statement payload is verbatim source, so a span edit on it is exact and needs no schema change; the splice already did descending-offset oldText-checked edits. Structured lowering is real Phase 2 work and unnecessary (per-tool argued in the spec crux). Behavior-preserving for `rename_symbol`: every pre-existing rename/agent/replay/T03 test stays green unchanged (the regression net).

**Design-doc impact:** none — additive overlay generalization; supersedes the Phase 1 "Transaction overlay stores identifier text mutations in memory" entry's narrowness (text-span is the superset).

**Revisit when:** a tool needs structured parameter/body/return-type node lowering rather than text-span edits (that is BS15-A — stop and surface, do not half-lower).

## 2026-05-15 — First T03 benchmark round: substrate beats file-based baseline on every metric (BS-Bench-A/C/D resolved)

**Context:** First keyed live benchmark round (operator-run, `bench:t03`), `claude-sonnet-4-6`, validation N=1 then distribution N=3 per config. Same verbatim T03 prompt, same model, same 10-criterion shared bar, same success scoring core for both configs. Resolves the operator-pending bail signals from the D5 entry below.

**Result (N=3, both configs 3/3 success, 0 retries, tsc+vitest clean 3/3):**
- Total tokens — substrate raw [1201, 1270, 1473] (mean 1315) vs baseline [4450, 4514, 4682] (mean 4549). Distributions **disjoint** (substrate max 1473 < baseline min 4450), ~3.5x fewer.
- Wall time — substrate 24.6–30.3s vs baseline 57.4–59.4s. Disjoint, ~2.2x faster.
- Tool/edit invocations — substrate 7–11 vs baseline 25–27. Disjoint, ~3x fewer.
- Cost/run — substrate ~$0.038 vs baseline ~$0.184, ~4.9x cheaper. Round spend: $0.26 (N=1) + $0.67 (N=3) = $0.93 total.

**Bail signals:**
- **BS-Bench-A — cleared.** The file-based baseline completed T03 successfully 3/3; the comparison is meaningful (a baseline that couldn't do the task would have made the numbers vacuous).
- **BS-Bench-C — cleared.** $0.93 for the full validation+distribution round; no cost explosion. N capped at 5, dry-run available.
- **BS-Bench-D — did NOT fire.** Distributions are cleanly separated, not swamped by variance. Had they overlapped at N=3 the report and this entry would record "no separable signal" — they do not. The report and this entry explicitly frame N=3 as an observed separation, **not** a statistical-significance claim; larger N is future work.

**Why this matters:** This is the core thesis of strata-design.md ("AI coding agents are bottlenecked by the file abstraction… a structural substrate makes agents fundamentally more efficient") demonstrated empirically on a real task: same model, same task, same success criteria, materially less work to the right answer, with no quality regression.

**Design-doc impact:** none — this is the evidence the design predicted. Feeds the eventual Phase 5 write-up. Raw per-round artifacts under `packages/bench/results/` are gitignored by intent (reproducible, cost-bearing, operator-run); this entry is the durable record of the finding.

**Revisit when:** the benchmark broadens past T03 (needs Phase 1.5 tools) or runs at larger N / multiple models — re-measure; a single-task N=3 separation is a strong directional result, not the final word.

## 2026-05-15 — Phase 4 verticalizes on the T03 substrate-vs-baseline benchmark (D5); BS-Bench-A/C/D operator-pending

**Context:** `@strata/bench` now runs the substrate (`runAgentT03`, reused as-is) and a file-tools baseline (temp copy of `examples/medium`) N trials each on T03, scores both through the shared `evaluateT03TextCriteria` core (BS-Bench-B gate green key-free), aggregates distributions, and writes artifacts via the operator-only key-gated `bench:t03` script. `strata-design.md` Phase 4 remains broader (10 tasks); this is the verticalized T03-only slice the spec settled.

**Considered:** n/a — verticalization is settled by the approved spec; this is the build record plus the bail-signal observation status.

**Decided / Observed:** Deferred: no API key in this environment; the live round is an operator action via `ANTHROPIC_API_KEY=... pnpm --filter @strata/bench bench:t03 -- --trials=3`. All harness logic (scorer-equivalence BS-Bench-B gate, metrics/distribution math, retry counter, report, temp-tree materialization, and resultQuality probes) is green key-free. BS-Bench-A (whether the baseline can complete T03 with file tools), BS-Bench-C (actual per-round/per-run cost), and BS-Bench-D (whether distributions overlap or separate at N=3-5) are explicitly operator-pending and must be recorded from round one regardless of outcome. Runner module-system guard form used: CommonJS `require.main === module` with `__dirname` because `tsconfig.base.json` is `module: "CommonJS"`. Baseline SDK form used: `tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"]`, `systemPrompt: { type: "preset", preset: "claude_code" }`, `settingSources: []`, `strictMcpConfig: true`, `mcpServers: {}`.

**Why:** BS-Bench-A/C/D are measurement findings recorded from the real live round, never inferred from skipped logic. The substrate path was not modified; `runAgentT03` remains the substrate. The CommonJS guard preserves script-only execution without using `import.meta`, and the baseline SDK options make the contrast file-tools-yes / Strata-tools-no / ambient-MCP-no.

**Design-doc impact:** none — `strata-design.md` Phase 4 remains the broader target; this records the implemented verticalized slice and the operator-pending live round.

**Revisit when:** the operator completes the keyed live round (record actual BS-Bench-A/C/D observations as a new newest-first entry if this deferred form was already committed), N is raised as a budgeted operator decision, or Phase 4.5 widens to a second task.

## 2026-05-15 — Baseline temp-checkout = recursive copy plus git init; file tools pinned (D4, Open Question 3)

**Context:** Phase 4's baseline needs an isolated, writable, real `.ts` tree with the corpus tsconfig/package.json and working `tsc --noEmit`. Open Question 3 left clone-vs-copy and corpus-deps handling to implementation.

**Considered:** `git clone --depth=1 file://`; recursive copy + `git init`; recursive copy only.

**Decided:** Recursive `cpSync(corpusRoot, tmp, { recursive: true })` into an OS temp dir, then `git init` in that temp tree for live operator runs. The baseline needs no repo history; `examples/medium` is a no-emit corpus with no own vitest suite and no runtime deps, so no `pnpm install`/symlink is required. Unit tests pass `initGit: false` so key-free tests do not run git. The SDK tool surface is the explicit allow-list `["Read", "Write", "Edit", "Glob", "Grep", "Bash"]` with `systemPrompt: { type: "preset", preset: "claude_code" }`, `settingSources: []`, `strictMcpConfig: true`, and no Strata MCP server.

**Why:** Copy is the minimal mechanism that gives an isolated writable real tree; `git init` gives Claude Code a repository-shaped workspace without depending on repository history. Pinning the tool list keeps the fairness invariant auditable: same model, same task prompt, same success bar; vary substrate vs. files, not ambient MCP servers.

**Design-doc impact:** none — implements spec § "Baseline config" / Open Question 3.

**Revisit when:** the corpus gains its own runtime deps or vitest suite, an SDK upgrade changes `Options.tools`/`systemPrompt` semantics, or the operator live run shows Claude Code requires different plain-file-tool scoping.

## 2026-05-15 — Symmetric T03 retry/failure counting rule shipped as specified (D3, Open Question 1)

**Context:** `docs/benchmarks.md` Open Questions flags that "retry" is undefined for the file baseline, so the metric is meaningless without a concrete rule. The Phase 4 spec proposed a symmetric definition.

**Considered:** count every failed tool call (over-counts a single self-correction as 3); count only explicit substrate commit blocks (no file analog); the spec's "failed verification + subsequent mutation = one self-correction" rule.

**Decided:** Shipped the spec's rule. Substrate retry = a `validate` returning diagnostics OR `commit_transaction` `{ ok:false }`, followed by a further mutating tool call (`rename_symbol`/`begin_transaction`/`rollback_transaction`). Baseline retry = a `tsc`/`vitest`/test Bash run exiting non-zero OR a re-edit of an already-edited file, followed by a further `Edit`/`Write`. A failed check with no subsequent mutation is NOT a retry.

**Why:** Symmetric on each side's native verify/edit primitives, derivable from each config's session log with no extra instrumentation, resilient to differing tool vocabularies. The worked example (one failed validate -> rollback -> corrected rename) counts as ONE, matching the spec's stated intent.

**Design-doc impact:** none — resolves `benchmarks.md` Open Question; the rule is reported alongside the metric so a reader can audit it.

**Revisit when:** the first live round's logs (operator, Task 9) show mis-classification — a corrected rule is then logged as a NEW newest-first entry, never silently retuned.

## 2026-05-15 — @strata/bench created; T03 scorer core stays in @strata/verify (D2)

**Context:** Phase 4's harness needs a package. `strata-design.md` § "Project layout" reserves `packages/bench`. The shared scorer core (D1) could nominally live in `bench`.

**Considered:** (a) put `evaluateT03TextCriteria` in `bench`; (b) keep it in `@strata/verify` and have `bench` import it from the verify barrel.

**Decided:** (b). `packages/bench` (`@strata/bench`) depends on `@strata/agent`/`@strata/verify`/`@strata/ingest`/`@strata/render`/`@strata/store` + the SDK + zod, NOT `@strata/cli`. The scorer core stays in `@strata/verify`.

**Why:** (a) cycles: `verify`'s own `evaluateT03Criteria` needs the core, and `agent`->`verify`, `bench`->`agent`/`verify`. Keeping it in `verify` keeps the graph acyclic (`bench` -> `agent` -> ... -> `verify`; `bench` -> `verify`) and lets `bench` reach the core via the barrel with no `cli` edge and no deep `dist/` import. The scorer core must NOT be relocated to `bench` later.

**Design-doc impact:** none — additive package on the reserved `packages/bench` slot.

**Revisit when:** a non-T03 benchmark task is added (the harness generalizes; the T03 scorer does not move).

## 2026-05-15 — T03 text-criteria core extracted (evaluateT03TextCriteria) in @strata/verify (D1)

**Context:** Phase 4 needs the substrate and the file-based baseline to score the nine text-derived T03 criteria through identical logic, or the comparison is invalid (BS-Bench-B). The nine criteria were inlined inside `evaluateT03Criteria`, coupled to `db`/`batch`.

**Considered:** (a) duplicate the regexes in the bench baseline adapter; (b) extract a pure `Map<modulePath,text>`-taking core in `@strata/verify` that `evaluateT03Criteria` delegates to and the baseline adapter also calls; (c) move the scorer into the new `@strata/bench`.

**Decided:** (b). `packages/verify/src/t03Criteria.ts` now exports `evaluateT03TextCriteria(modules)` (the nine text criteria, regexes verbatim) and `T03TextCriteria`. `evaluateT03Criteria` keeps its signature, builds the rendered-text Map from `db`/`batch` exactly as before, delegates the nine, and adds `commitReturnedOk`/`validateAfterCommitClean`/`operationRowAppended` unchanged.

**Why:** A single pure core called by both adapters makes "T03 succeeded" mean exactly the same thing for substrate and baseline. (c) was rejected: it would cycle (`verify` needs the core; `agent`->`verify`; `bench`->`agent`/`verify`). The core MUST stay in `@strata/verify` — moving it to `bench` later would reintroduce the cycle; do not "tidy" it there.

**Design-doc impact:** none — refactor only; `evaluateT03Criteria` signature/behavior unchanged, `cli` `t03.test.ts` and `agent` `replay.test.ts` green unchanged.

**Revisit when:** T03 grows criteria, or a fourth caller needs the core.

## 2026-05-15 — Agent hermetic isolation: `LSP` disallowed + `strictMcpConfig`/`settingSources` required

**Context:** Phase 3 live BS-A run. With `tools: []` (documented as "disable all built-in tools"), the runtime invariant guard still tripped — first on an injected `LSP` tool, then (after fixing that) on `mcp__claude_ai_Breeze__*` tools leaking in from the operator's `~/.claude.json`. Both violate the CLAUDE.md invariant that the agent's only tools are the in-process Strata ones and its world is the node graph, not files. The bail-signal guard caught this; it was NOT relaxed.

**Considered:**
- Relax the runtime guard to allow `LSP` / ambient MCP tools — rejected: papers over a real invariant violation and would invalidate the benchmark (an `LSP` tool inspects real files; Breeze tools perform arbitrary RMM actions).
- Whack-a-mole add every ambient tool to a banned list — rejected: not hermetic, brittle.
- Use the SDK's own hard-removal/isolation mechanisms — chosen.

**Decided:** In `runLiveSession` options: (1) add `"LSP"` to `BANNED_BUILTINS` (fed to `disallowedTools`, the SDK's documented "removed from the model's context and cannot be used" path) — `tools: []` does not strip `LSP` in `@anthropic-ai/claude-agent-sdk@0.2.118`; (2) set `strictMcpConfig: true` — in the underlying Claude CLI this means "use only the explicitly-passed MCP servers, ignore all other sources"; without it the SDK inherits `~/.claude.json` servers (Breeze); (3) set `settingSources: []` explicitly (documented default when omitted, set to make hermetic intent unambiguous). After these, the strict guard passes live and the agent completes T03 through only the 8 Strata tools.

**Why:** Enforces the invariant via the SDK's own mechanisms rather than weakening the check. Documents two installed-SDK-vs-docs gaps (the Phase 3 spec already flagged this class of risk): `tools: []` does not cover `LSP`; `strictMcpConfig`'s type doc says "strict validation" but its operative effect is MCP source isolation.

**Design-doc impact:** none — confirms strata-design.md § "The Agent" ("no file tools ... entire world is the node graph") is enforceable on this SDK with explicit isolation options.

**Revisit when:** upgrading `@anthropic-ai/claude-agent-sdk` (re-verify `tools: []`/LSP/`strictMcpConfig` behavior — these are version-observed, not type-guaranteed), or if a future SDK injects another ambient tool the guard catches.

## 2026-05-15 — Phase 3 verticalizes on agent-drives-T03 (D5)

**Context:** Phase 3 now has `@strata/agent` wrapping the existing store/verify spine as eight in-process SDK tools, a static worldview prompt, session logging, a headless `query()` live path configured with `tools: []`, and a deterministic replay path that passes all 11 shared `evaluateT03Criteria` checks. The design doc's Phase 3 remains broader than this slice.

**Considered:** broaden to the full benchmark harness, more tools, and the Claude Code baseline now; or ship the single agent-drives-T03 vertical slice and broaden in Phase 3.5/4.

**Decided:** single vertical slice. Phase 3 verticalizes on the proven `rename_symbol` T03 spine with no filesystem tools. Broadening to more tasks, more tools, and baseline comparison is Phase 3.5/4.

**Why:** Verticalizing isolates agent/SDK-integration risk from substrate risk. The substrate was already green for T03, so this run focuses on whether a Strata-only tool loop can drive the same outcome. The no-key replay path proves the substrate outcome deterministically. BS-A and the live half of BS-B are not claimed from skipped tests; they remain operator-pending keyed runs. BS-C cost capture wiring exists in the session log and will be populated by the operator's keyed run.

**Design-doc impact:** none — `strata-design.md` Phase 3 remains the target; this records the implemented first slice.

**Revisit when:** the operator completes the keyed live acceptance, Phase 3.5 adds a second tool/task, or Phase 4 builds the baseline comparison.

## 2026-05-15 — Phase 3 acceptance determinism: recorded-transcript replay (D4)

**Context:** The agent T03 acceptance test calls a live model, but CI must be deterministic and key-free.

**Considered:** key-gated live-only with a retry budget; or record a live transcript and replay the tool-call sequence through the real handlers so the store outcome is a pure function of the sequence.

**Decided:** Use replay. `runAgentT03` supports a replay path that re-executes `{ tool, args }` steps through the real Strata handlers and substitutes `"$TX"` with a fresh transaction handle. The committed fixture at `packages/agent/tests/fixtures/agent-t03-transcript.jsonl` is clearly labeled as a synthetic placeholder because this environment has no key; it keeps key-free CI exercising the full replay path and all 11 criteria. The operator replaces it with a real keyed live recording using `pnpm --filter @strata/agent build && ANTHROPIC_API_KEY=... pnpm --filter @strata/agent record:t03-fixture`.

**Why:** Replay keeps CI deterministic without secrets while a real live run remains the source of truth once recorded. The store outcome is a pure function of the recorded tool-call sequence, so replay is a faithful substrate-outcome reproduction, not a mock. The current placeholder is not represented as a real agent run; live confirmation remains operator-pending.

**Design-doc impact:** none — implements spec § "Acceptance test" / Open Question 2.

**Revisit when:** the SDK changes how tool calls are surfaced, the T03 corpus changes, or the operator regenerates the placeholder from a successful live run.

## 2026-05-15 — Phase 3 agent drives T03 live: BS-A / BS-C observation

**Context:** Phase 3 Task 10 wires the headless agent against the verbatim T03 prompt with only the eight Strata tools and `tools: []`.

**Considered:** n/a — this is a bail-signal observation entry, not a design choice.

**Decided / Observed:** Deferred in this environment: no Anthropic API key or Claude Code OAuth token is available, so the live BS-A run is an operator action. The live half of BS-B is likewise pending keyed confirmation from the SDK session. The CI proof for substrate outcome is the replay path added in Task 11. BS-C: token, cost, and wall-time numbers are pending the operator live run, but the session log now captures `SDKResultMessage` usage, per-model usage, total cost, and duration fields.

**Why:** BS-A is the substrate-agent-fit signal; BS-C is a primary Phase 4 cost signal. Both must be recorded from a real live run, not inferred from skipped tests.

**Design-doc impact:** none.

**Revisit when:** the operator runs the keyed live acceptance, the prompt is iterated again, the tool set is widened, or Phase 4 benchmarking begins.

## 2026-05-15 — Phase 3 SDK session integration shape pending live confirmation (D3)

**Context:** Phase 3 BS-B asks whether the SDK runs headless with only custom in-process tools and `tools: []`, and whether tool results compose with our transaction model. Task 4 cleared the tool loop at the handler layer with no model; Task 5 adds the live one-tool session probe.

**Considered:** trust BS4 (schema-only) and build the full orchestrator directly; or probe a minimal one-tool session first.

**Decided:** probe-first. `packages/agent/src/session.ts` implements a single-yield async-generator prompt and `collectSession(...)` over the public `query(...)` API. `packages/agent/tests/sessionSmoke.test.ts` registers an in-process `createSdkMcpServer` with one `ping` tool, runs with `tools: []`, `allowedTools: ["mcp__probe__ping"]`, `bypassPermissions` + `allowDangerouslySkipPermissions`, `maxTurns`, and an `abortController`. Result: pending-live-confirmation — this environment has no API key, so the live SDK probe is skipped until the operator runs it with `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.

**Why:** The session/loop is the part BS4 did not exercise. Probing one tool isolates "the SDK headless loop composes" from "our eight tools / system prompt are right" before the full orchestrator. The no-key surface remains covered by Task 4's direct handler test; BS-B live confirmation is not claimed from a skipped test.

**Design-doc impact:** none — confirms the intended integration shape in code, with live confirmation pending.

**Revisit when:** the keyed Task 5 probe runs, an SDK upgrade changes `query`/`Options.tools`/MCP server handling, or the full Task 10 session reveals loop behavior the one-tool probe did not.

## 2026-05-15 — `read_node` added to @strata/store for the Phase 3 agent

**Context:** Phase 3's `read_node` tool needs "a node plus optional shallow children". `@strata/store` exposed `findNodeById` and `listChildren` separately; the agent must not reach into store internals.

**Considered:** (a) compose `findNodeById`+`listChildren` inside `packages/agent`; (b) add a public `readNode`/`read_node` to `@strata/store`.

**Decided:** (b). `packages/store/src/read_node.ts` exports `readNode(db, id, { includeChildren? })` (alias `read_node`) returning `{ node, children? }`.

**Why:** Keeps the dependency edge clean (`agent -> store` public surface only) and matches the spec's note that this helper belongs in `store`, not in `agent`. Minimal: one level of children, no recursion (Open Question 1 — widen only if agent behavior shows it's needed).

**Design-doc impact:** none — additive public API on an existing package.

**Revisit when:** the agent's transcript shows it repeatedly needs deeper traversal than one child level (then it becomes a logged tool-widening decision per Open Question 1).

## 2026-05-15 — T03 scoring extracted to `@strata/verify`

**Context:** Phase 3 needs the agent path and the programmatic `cli t03` path to score against identical logic so the agent cannot be given a weaker or vacuous check. The scoring block was inlined inside `runT03`, and Plan Amendment 1 moved the shared scorer boundary from `@strata/cli` to `@strata/verify`.

**Considered:** (a) duplicate the regex/operation checks in the agent test; (b) extract the post-commit scoring into `@strata/cli`; (c) extract it into `@strata/verify` and export it through the verify barrel.

**Decided:** (c). `packages/verify/src/t03Criteria.ts` exports `evaluateT03Criteria(db, batch, srcRoot, input)` and `emptyT03Criteria()`, re-exported from `@strata/verify`. `runT03` keeps driving the rename + post-commit re-validate itself and passes `commitReturnedOk`/`validateAfterCommitClean`/`renameTxId` in; the regex/operation-row scoring moved behavior-preservingly.

**Why:** `@strata/verify` already owns validation and depends on the store/render surface the scorer needs, while both `@strata/cli` and the Phase 3 agent can consume it without creating an `agent -> cli` dependency or a fragile deep `dist/` import. The 4th `input` arg keeps the function pure while letting each caller feed in its own commit outcome.

**Design-doc impact:** none — refactor only; `RunT03Result` shape unchanged, existing `t03.test.ts` unchanged and green.

**Revisit when:** T03 grows additional criteria, or Phase 4 creates a dedicated `@strata/bench` package that should own benchmark-acceptance logic.

## 2026-05-15 — Phase 1 verticalizes around `rename_symbol`

**Context:** Phase 1 completed Tasks 10-14 after the substrate pieces from Tasks 0-9 were already green. The design doc's Phase 1 remains broader than this run's implemented mutation surface.

**Considered:**
- Implement the whole Phase 1 mutation set now.
- Ship the single `rename_symbol` vertical slice with the infrastructure it forced, then broaden later.

**Decided:** Phase 1 ships as the `rename_symbol` vertical slice: identifier-level ingest, TypeChecker references, transactions, operation log, render splicing, `@strata/verify` validate-before-commit, CLI smoke commands, and the T03 acceptance path.

**Why:** The T03 path exercises the load-bearing substrate without prematurely designing every mutation. The stable-ID, overlay, JSDoc traversal, source-map, validation, and SDK-schema decisions have all been tested against the same hero operation.

**Design-doc impact:** none for now. `strata-design.md` still describes the broader target; this records the implemented Phase 1 slice.

**Revisit when:** Phase 1.5 adds the second structural mutation and tests whether the same transaction/reference/render spine generalizes.

## 2026-05-15 — BS4 cleared with SDK Zod tool schemas

**Context:** Phase 1 Task 12 probed whether `@anthropic-ai/claude-agent-sdk` can express the future Strata tool shapes before Phase 3 agent work starts.

**Considered:**
- A hand-written JSON-schema-shaped smoke object only.
- A smoke harness that also type-checks against the SDK's real `tool(...)` / `SdkMcpToolDefinition` API.

**Decided:** Use the SDK's typed `tool(...)` surface with explicit Zod schemas for `TxHandle`, `NodeId`, and `Diagnostic[]`, plus a serializable `sdk-smoke` command output for inspection.

**Why:** The installed SDK exposes `tool` and accepts Zod raw-shape schemas. The smoke harness type-checks and runs, so BS4 is cleared without inventing a custom schema representation.

**Design-doc impact:** none — this confirms the planned Phase 3 SDK direction remains viable.

**Revisit when:** Phase 3 adds the real agent tool registry, or an SDK upgrade changes `SdkMcpToolDefinition` / `tool(...)`.

## 2026-05-15 — Validate uses the nearest corpus tsconfig before root defaults

**Context:** Phase 1 Task 11 T03 initially failed validation before any rename-specific check: `examples/medium` imports `.ts` extensions and uses `import.meta` / top-level await, but `@strata/verify` was compiling rendered files with the monorepo `tsconfig.base.json` CommonJS defaults.

**Considered:**
- Keep using only `tsconfig.base.json` and special-case T03.
- Load the nearest `tsconfig.json` from the rendered module paths, falling back to `tsconfig.base.json` when no corpus config exists.

**Decided:** `@strata/verify` now loads the nearest corpus `tsconfig.json` for rendered module roots and falls back to `tsconfig.base.json`.

**Why:** The corpus already compiles cleanly under its own `examples/medium/tsconfig.json`; validation should check rendered output under the same compiler options as the corpus, not unrelated package defaults. This was an implementation bug, not a TypeChecker resolution wall.

**Design-doc impact:** supersedes the earlier Phase 0 assumption that one root base config is enough for verification.

**Revisit when:** validation spans multiple package roots with incompatible configs.

## 2026-05-15 — BS2 T03 timing recorded below total-run threshold

**Context:** Phase 1 Task 11 timed the built T03 path: ingest `examples/medium`, rename `User` to `Account`, validate through `@strata/verify`, commit, and assert acceptance criteria.

**Considered:** Stop if the run exceeded the plan's total-run timing note or if a single-module ingest / affected-node transaction clearly crossed the BS2 thresholds.

**Decided:** Continue. The final built command reported `wallTimeMs = 511.3`; `/usr/bin/time -p` reported `real 0.69`, `user 1.21`, `sys 0.06`.

**Why:** The full command is well below the plan's 5s T03 total-run note, and no single 2k-LOC ingest or ~50-node transaction threshold was clearly exceeded by this fixture.

**Design-doc impact:** none.

**Revisit when:** T03 grows to the intended ~15 modules / ~40 type positions, or validate timing becomes agent-loop visible.

## 2026-05-15 — Render source maps are per-module statement spans

**Context:** Phase 1 Task 9 moved validation into the new `@strata/verify` package and maps TypeScript diagnostics from rendered files back to graph nodes.

**Considered:**
- A per-module source map of rendered byte spans to renderable node IDs.
- A deeper identifier-level source map that maps diagnostics directly to Identifier nodes.

**Decided:** `renderWithSourceMap` returns `Array<{ renderedStart; renderedEnd; nodeId }>` sorted by `renderedStart` for each module. `@strata/verify` keys those maps by rendered module path and binary-searches the span containing `diagnostic.start`. In Phase 1 those entries point to renderable statement/EOF nodes; Identifier rows remain splice inputs rather than source-map targets.

**Why:** TypeScript diagnostics are file-position based, and statement-level mapping is enough to make validate failures actionable for the rename slice. Identifier-level mapping can be layered on later without changing the per-module map contract. The BS3 probe on the two-module validate corpus took 322.9ms cold and returned one mapped diagnostic for the intentional half-rename, below the 500ms bail threshold, so a fresh `ts.Program` per validate call remains acceptable.

**Design-doc impact:** none — this locks in the Phase 1 source-map shape without changing `strata-design.md`.

**Revisit when:** diagnostics need to drive automatic repair at identifier precision, or validate on the medium corpus crosses the BS3 threshold.

## 2026-05-15 — Transaction overlay stores identifier text mutations in memory

**Context:** Phase 1 Task 6 implemented transactions for the `rename_symbol` slice.

**Considered:**
- Store full replacement `NodeRow` values in the overlay keyed by node ID.
- Store only identifier-text mutations keyed by identifier node ID, plus pending operation rows.

**Decided:** The Phase 1 overlay is an in-memory `identifierMutations: Map<identifierId, { text }>` plus `pendingOps: PendingOp[]`, keyed by `tx_id`. `commitWithoutValidate` materializes those text mutations into canonical Identifier payload rows. Open transactions do not survive process restart; startup recovery marks persisted `status='open'` rows as `rolled_back`.

**Why:** The public Task 6/9 mutation surface queues identifier updates without a database handle, so it cannot safely construct full replacement rows at queue time. The canonical offset and statement splice context stay in the store rows until validate/commit materializes the transaction view. This preserves the Phase 1 rename invariant while keeping the overlay small and tied to operation intent.

**Design-doc impact:** none to `strata-design.md`; this records a narrower implementation shape than the plan's full-`NodeRow` overlay option.

**Revisit when:** mutations need non-identifier replacements, or read APIs must expose a fully overlay-merged graph view before commit.

## 2026-05-15 — BS1 probed and cleared: AST traversal must use `getChildren`, not `forEachChild` + internal `.jsDoc`

**Context:** Phase 1 Task 4. The BS1 probe ("resolves the JSDoc `@param {User}` identifier") fired: the resolver resolved 5 of 6 `User` references, missing the JSDoc one. Per the spec this is a bail signal — stop, do not work around. Investigation followed before accepting the bail.

**Considered:**
- Accept BS1 as a true substrate wall (TypeScript can't do reference-aware rename through JSDoc) and re-spec.
- Investigate whether the miss is a substrate limitation or an implementation defect.

**Decided:** Not a true bail. Root cause is an implementation defect: the ingest/resolver traversal used `ts.forEachChild` (which deliberately skips JSDoc nodes) plus the **internal** `node.jsDoc` property as a workaround. The internal property is absent from TypeScript's public typings, so `tsc -b` failed outright; and even cast, `forEachChild` is the wrong traversal for JSDoc. A standalone probe (`/tmp/bs1-probe.mjs`) proved `checker.getSymbolAtLocation` **does** resolve JSDoc `@param {User}` and `@returns {User}` type-reference identifiers to their `InterfaceDeclaration` when the AST is walked with the public `node.getChildren(sourceFile)` API (which includes JSDoc). Resolution: all identifier traversal in `packages/ingest` uses a pre-order DFS over `node.getChildren(sourceFile)`; `ts.forEachChild` + `.jsDoc` is banned for identifier discovery.

**Why:** The spec's BS1 threshold is explicit — "if the workaround is no more than a different TypeChecker/AST method, continue." Switching `forEachChild`→`getChildren` is exactly a different AST method. The substrate (TS Compiler API) is sufficient for reference-aware rename including JSDoc; the bail signal correctly prevented a papered-over probe but the wall was illusory.

**Design-doc impact:** none — confirms the design's premise rather than changing it. Strengthens spec § "Open questions" Q1: TypeChecker accuracy is adequate for JSDoc type references.

**Revisit when:** a later identifier-bearing construct (e.g. template literal types, satisfies expressions) is missed by `getChildren` traversal — re-probe before assuming a wall, same as here.

## 2026-05-15 — Identifier lowering stops at TypeScript identifiers

**Context:** Phase 1 Task 3 added identifier-level ingest for `rename_symbol`, which needs addressable nodes for declaration and reference occurrences without turning the whole AST into graph rows.

**Considered:**
- Emit every `ts.Identifier` under each statement, including declaration names, type references, expression references, property names, and JSDoc identifiers surfaced by the TypeScript AST.
- Emit only rename-candidate identifiers after TypeChecker resolution.
- Add deeper expression/property-access lowering immediately.

**Decided:** Emit every `ts.Identifier` occurrence under a statement as an `Identifier` node with `{ text, offset }`, while leaving string literals, template literal text, and ordinary comment text out of the identifier layer. Identifier rows are non-renderable until the render splice work lands.

**Why:** The raw statement payload remains the canonical render path for now, and a shallow identifier layer is enough for Phase 1 rename resolution. Deferring filtering until Task 4 keeps ingest simple and lets the TypeChecker decide which identifiers are real references.

**Design-doc impact:** none — this locks in the Phase 1 plan's identifier emission boundary without changing the broader node graph direction.

**Revisit when:** later mutations need property-access member renames, expression-level edits, or comment-aware transformations outside JSDoc.

## 2026-05-15 — Stable node IDs use path plus structural child path

**Context:** Phase 1 Task 1 needs deterministic node IDs before identifier-level ingest and rename operations can preserve identity across non-structural mutations.

**Considered:**
- Path + structural-position hash: `modulePath`, dot-joined child index path, and node kind.
- Content-anchored IDs based on source text or syntax-node content.

**Decided:** Use `sha1(modulePath + ":" + childIndexPath + ":" + kind)`, truncated to 16 hex characters, implemented as the single `nodeId()` helper in `@strata/store`.

**Why:** This is deterministic across re-ingest of unchanged files and stable across Phase 1 rename mutations, which only change identifier text and do not alter parent/child shape. Content anchoring would better survive statement insertion, but it is more work than Phase 1's rename slice needs.

**Design-doc impact:** none yet — this resolves a Phase 1 plan-level open choice without changing the design direction.

**Revisit when:** operations need identity stability across structural edits such as inserted statements or moved declarations.

## 2026-05-14 — EOF trivia stored as a sibling `EndOfFileTrivia` node, not on the module

**Context:** Phase 0 ingest review found trailing trivia (comments/whitespace between the last statement's end and EOF) was silently dropped because `sourceFile.statements` doesn't include the `endOfFileToken`. A real codebase with a trailing footer comment would round-trip lossy without ingest noticing.

**Considered:**
- (a) Add a synthetic child node of kind `EndOfFileTrivia` at the highest `childIndex`, with the trivia text as its payload.
- (b) Attach the trivia to the module node (e.g., JSON-encode `{ path, trailingTrivia }` into the module payload).

**Decided:** (a). The module payload stays a plain string label, and rendering — which already orders children by `childIndex` — concatenates the trivia naturally as the last child.

**Why:** Keeps the module payload schema simple (still just a path string), avoids special-casing module payload parsing in render, and produces byte-identical round-trip on the new comment fixture and on all examples/small/*.ts. The trade-off is one extra node per module and a non-statement kind in the child list — fine because `EndOfFileTrivia` is structurally just another payload-bearing child for Phase 0.

**Design-doc impact:** none yet — Phase 0 is intentionally pre-schema. Lock in when the formal node-graph schema is written for Phase 1.

**Revisit when:** statement-level lowering lands and ingest no longer stores raw source text per child. The lowering for EOF trivia will probably remain "verbatim text" since it has no semantic structure, but the node kind may want renaming once other trivia kinds (between-statement comments, JSDoc) get their own representation.

## 2026-05-14 — Verify uses in-process TypeScript Compiler API, not subprocess `tsc`

**Context:** Phase 0 CLI initially shelled out to `npx tsc --noEmit` with hard-coded compiler options that didn't match `tsconfig.base.json`. Three problems: (1) PATH-dependent `npx` resolution, (2) the rendered output was being type-checked under different settings than the project's own build, (3) it contradicted the 2026-05-14 "TS Compiler API everywhere" decision logged below.

**Decided:** Verify is now in-process: `ts.createProgram([outputPath], options)` + `ts.getPreEmitDiagnostics(program)`. Compiler options are loaded from `tsconfig.base.json` via `ts.readConfigFile` + `ts.parseJsonConfigFileContent`. No subprocesses anywhere in `packages/cli`.

**Why:** Consistency with the parser/printer decision; one toolchain for parse, print, and verify. Also faster (no `npx` cold start), and the rendered output is checked under the same compiler options that the project's own packages build under.

**Design-doc impact:** Consistent with strata-design.md § Verify ("TypeScript Compiler API for in-process type checks"). The design doc was already correct — Phase 0's first cut diverged and has now been brought back in line.

**Revisit when:** multi-file verification is needed (Phase 2). The current implementation only type-checks the single rendered file; Phase 2 will need program-level verification across all rendered modules.

## 2026-05-14 — Use TypeScript Compiler API for parse + print in Phase 0 (drop tree-sitter and Prettier)

**Context:** Phase 0 bootstrap. The design doc specifies `tree-sitter-typescript` for parsing and `prettier` for canonical rendering, with the TS compiler API reserved for type-checking in `verify`.

**Considered:**
- tree-sitter + Prettier as specified.
- @swc/core (fast Rust parser with a built-in printer).
- TypeScript Compiler API (`typescript` package) for both parse and print, with Prettier added later only if style needs tightening.

**Decided:** Use the TypeScript Compiler API for both parse and print in Phase 0. No tree-sitter, no swc, no Prettier yet.

**Why:** The design's stated reason for tree-sitter is "round-trip preservation," but Strata renders canonically and discards original formatting — that benefit is moot for our pipeline. Meanwhile `verify` already needs the TS compiler API, so using it as the parser too collapses three toolchains into one. `ts.createPrinter()` produces serviceable canonical output; Prettier can be a post-pass when we have a reason to add it. Cuts dependencies, install time, and conceptual surface for a phase whose only goal is proving the pipeline.

**Design-doc impact:** Supersedes the Tech stack § "Parser" recommendation and the Render § "prettier" line *for Phase 0*. Will revisit at Phase 1 boundary; if expression-level lowering reveals TS-printer output to be inadequate, reopen.

**Revisit when:** (a) we need richer formatting control than `ts.createPrinter()` provides; (b) ingest perf becomes a bottleneck (swc); (c) we need incremental reparse for live editing (tree-sitter).
