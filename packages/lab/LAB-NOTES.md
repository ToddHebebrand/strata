# Lab notes (append-only, NON-AUTHORITATIVE journal)

NOT decisions.md. Freeform exploration log. Nothing here is a claim.

- 2026-05-17: scaffold created. Fence divergence from spec wording: recursive
  `test` is a no-op echo; real lab tests run via `test:lab` so `pnpm -r test`
  is provably unchanged.

- 2026-05-17: first experiment landed — id `per-scope-add-parameter`.
  Hypothesis: per-scope `add_parameter` expressiveness lets the agent
  differentiate callsites in ONE structural op (one `AddParameter` op-log
  row, zero `oldText mismatch` thrash, no colliding `replace_body` — the
  four-falsified-levers root cause); expect HD PASS. Mechanism: a lab-local
  `applyPerScopeAddParameter` faithfully reimplements the canonical
  `@strata/store` add_parameter algorithm composed ONLY from exported store
  primitives (`resolveCallsites` / `queueTextSpanEdit` / `queuePendingOp` /
  `modulePathOf` / `findNodeById` / `locateSpan`), extended with
  longest-prefix `per_scope` slot selection. The canonical store op hardcodes
  a single uniform slot value with no per-callsite hook, so it cannot be
  reused for per-scope values; `@strata/store` is NOT modified (a store
  change is graduation-class) — the sandbox composes store primitives
  directly, the sanctioned fallback. Variant reuses the EXACT tool NAME
  `add_parameter` (hermetic guard intact); no net-new tool name.
  Step-5 export-only re-exports were NOT needed: `createStrataTools`,
  `createStrataToolServer`, and `STRATA_SERVER_NAME` were already exported
  from `@strata/agent`'s index by the Phase-1 seam — Task 10 made ZERO
  canonical change (store/render/verify byte-identical to main; agent diff is
  purely the pre-existing reviewed seam). Lab `typescript` moved from
  devDependency to dependency (lab package.json is non-canonical) because the
  variant handler parses TS at runtime.
  Ready for the cheap live inner loop:
  `pnpm --filter @strata/lab lab per-scope-add-parameter`
  (operator-run, ~cents, NOT a claim).
  DRIFT RISK: applyPerScopeAddParameter is a hand-copy of @strata/store add_parameter; if that canonical algorithm changes, re-sync this copy before trusting any lever result. Mechanical guard: the faithfulness-pin test.

## 2026-05-17 — First cents-loop trajectory (operator burst, ~$1.5/$5, NON-AUTHORITATIVE)

5 live runs, claude-sonnet-4-6, HD task. NOT a claim; sandbox signal only.

- **canonical-control** (vanilla tools): pure read-only exploration thrash, 0 mutations, never `begin_transaction`, wall-time. Reproduces the original T05-class exploration thrash on the *honest* (non-trapped) task.
- **per-scope-add-parameter** (variant tool): same thrash, never reached `add_parameter`. error_max_turns, $0.2887. The per-scope lever is unreachable — failure is upstream of the callsite-collision it targets.
- **per-scope-add-parameter-directive** (+ directive honest prompt): still thrash; agent burned the budget *guessing nonexistent constant names* (SERVER_ZONE, DEFAULT_TIMEZONE, …). Re-confirms the falsified BS-P-B prompt class on the new instrument.
- **per-scope-gated** (+ canUseTool exploration gate): gate INERT. Seam finding: the canonical hermetic session runs `permissionMode: "bypassPermissions"` (session.ts:684), under which the SDK never invokes `canUseTool`. The loop-affordance lever cannot be wired via the SDK permission hook; it must live at the tool-handler layer.
- **per-scope-handler-gated** (+ tool-handler exploration gate, which DOES fire): exploration successfully capped (~50→~20 calls). But the agent, told repeatedly to `begin_transaction` then `add_parameter`, **never acted** — stalled and wall-timed with no transaction.

**Trajectory finding (sandbox, non-authoritative):** on an honest, code-derivable multi-step task, the substrate + the two deferred levers (per-scope `add_parameter` expressiveness; exploration discipline) do NOT yield a single converged multi-step success. The failure is not the callsite-collision (per-scope lever's target), not prompt directiveness, and not merely unbounded exploration: even with exploration forcibly bounded and an explicit act instruction, the agent does not enter the act phase (never opens a transaction across all 5 configs). This is the first such evidence on a non-trapped task and cleanly extends the published bounded negative — the substrate's robust atomic-rename win does not generalize here even with the new levers. The next question (why the agent will not convert to action even when forced) is a different-class, loop/model-architecture investigation — deliberate design, not more gate/prompt tuning. Nothing here graduates; RESULTS.md/decisions.md unchanged by design.

## 2026-05-17 — CORRECTION: the trajectory entry above is VOID (broken instrument)

The preceding "First cents-loop trajectory" entry's conclusion is WITHDRAWN.
Root cause found model-free (probe.ts/probe2.ts): `@strata/ingest` ingests
`export const ZONE = "..."` as kind `FirstStatement` with the name in a child
`Identifier`; there is NO findable variable/const declaration node, and
`Module` nodes are not returned by `find_declarations`. So:

- `find_declarations` advertises `kind:"variable"` (its schema) but no such
  node is emitted for `const` — the documented surface is unreachable for the
  HD per-scope `ZONE` constants.
- The agent could not locate `ZONE` or `config` by ANY documented call. Its
  "thrash" was rational search against a tool returning `[]`.

Therefore the HD task is UNSATISFIABLE via the documented tools, and the 5
keyed runs measured a broken instrument — the substrate/agent/exploration
conclusions are artifacts, not findings, and are withdrawn. This is an
instrument (lab corpus + tool/ingest legibility) defect, NOT a substrate
result; RESULTS.md/decisions.md remain untouched and unaffected (the original
rename used InterfaceDeclaration, which IS surfaced).

Methodology miss recorded honestly: the conclusion was drawn from tool-call
NAMES, not tool RESULTS — the exact aggregate-not-transcript error the
project forbids. The build's deterministic tests missed it because they drove
the per-scope tool / scorer directly and never exercised the agent's
discovery path (`find_declarations` → `ZONE`). Validation gap noted.

Next is an OPERATOR decision, no further keyed spend taken unilaterally — see
the conversation. Options: (A) redesign the HD signal onto a declaration kind
ingest surfaces (function/interface/type) so the task is documented-tool
satisfiable; (B) treat "find_declarations does not deliver its documented
variable/Module surface" as the real, decision-grade tooling finding and
write it up; (C) re-read the Codex/decisions trail before any further lever.

## 2026-05-17 — Deeper probe: the cheap fix is insufficient; tooling-ceiling is the finding

probe3 (model-free): read_node returns {node:{id,kind,parentId,childIndex,
payload},children}. Module payload = file path, so node→scope is reachable
ONLY via an undocumented N-level parentId ancestor-walk; a callsite reads
back as a bare Identifier with no path/scope. find_declarations has no
Module kind and (decisions.md:948 deferred statement-lowering) no findable
variable/const.

Consequence: const→function would fix discoverability (FunctionDeclaration
is surfaced) but NOT attribution — two same-named scope functions /
per-callsite scoping still undiscoverable via documented tools. The cheap
"fix the instrument" path does NOT make the per-scope task satisfiable.

DECISION-GRADE (sandbox, non-authoritative, free-probe-evidenced): the
documented tool surface supports symbol-level reference ops (rename: one
findable interface, reference graph, no module attribution — why T03 works)
but cannot support a location/scope-conditioned multi-step refactor (no
legible node→module attribution; non-function decls unfindable). Upstream of
and independent of agent/model/prompt/per-scope-tool/exploration-gate. A
satisfiable honest per-scope task likely needs a canonical Module-aware
find_declarations or a module_of tool — graduation-class, out of sandbox
scope. Hypothesis worth a RIGOROUS (not sandbox) check: this attribution
ceiling may also be a contributing factor in the authoritative T01 negative
(T01 required exactly the src/server vs src/ui split) — NOT asserted; flagged
for deliberate review, not claimed against the published result.

## 2026-05-17 — Closed: ceiling accepted as the result (no further keyed spend)

Operator decision: the tooling-ceiling finding is the deliverable. Reproduce
it FREE/model-free (no API key) from packages/lab:
  pnpm --filter @strata/lab build
  node dist/probe.js    # find_declarations cannot surface const ZONE / config
  node dist/probe2.js   # ingest emits `export const` as nameless FirstStatement
  node dist/probe3.js   # no documented node→module attribution (only parentId walk)
Total keyed spend this arc ≈ $1.5 (5 runs, all on the since-invalidated
instrument; trajectory withdrawn above). Authoritative RESULTS.md/decisions.md
untouched and unaffected. The optional rigorous T01-link check was NOT taken
(deferred; would be a deliberate, non-sandbox investigation, not a claim).

## 2026-05-17 — CORRECTION: "decision-grade tooling ceiling" was overwrought

Withdrawn. Root cause is NOT a fundamental ceiling: `find_declarations`
maps kind:"variable" → SQL kind="VariableStatement" (queries.ts:21), but
ingest stores `export const X` as kind "FirstStatement" (same TS SyntaxKind,
enum alias). A one-token string mismatch; the name-match machinery already
works. Module attribution is a one-call `modulePathOf` away. Both are
trivially bridged LAB-SIDE via same-named enriched tools (zero canonical
change) — exactly what the sandbox's toolServerFactory is for. The prior
"ceiling / may bear on authoritative T01" framing re-imposed the published
project's restrictiveness onto the sandbox and inflated a small ingest/query
alias bug; it is withdrawn. New experiments `per-scope-equipped` /
`canonical-equipped` remove the artificial deprivation honestly (structural
graph facts only, never the per-scope answer; trapped control still guards).
Runner now prints tool RESULTS, not just call names (fixes the methodology
miss). Re-running with the deprivation removed.

## 2026-05-17 — BREAKTHROUGH: with deprivations removed, the substrate DOES the multi-step edit

per-scope-equipped (enriched same-named tools): the agent found everything
(find_declarations now returns the FirstStatement ZONE w/ modulePath;
read_node returns modulePath/scope) — yet still explored to wall-time
without acting. So the failure was NOT tool legibility alone.

per-scope-equipped-gated (equipped + handler exploration-gate forcing the
transition): the agent ACTED —
  begin_transaction → add_parameter{ok, afterSignature adds `timezone: string
  = "UTC"`} → replace_body{ok} → validate → ["Cannot find name 'ZONE'." @
  src/server/events.ts, src/ui/...]
The per-scope variant CORRECTLY placed `ZONE` at the server/ui callsites
(that's exactly why validate reports "Cannot find name 'ZONE'" THERE). The
ONLY gap: the `import { ZONE }` was never added to those modules.

This overturns every prior "won't act / ceiling / doesn't generalize"
framing in this file: with (a) legible tools and (b) a nudge off infinite
exploration, the substrate performs the multi-step per-scope refactor and
lands within ONE missing import of passing HD. Root issue is now concrete
and fixable: the per-scope structural op inserts a scope symbol but does not
ensure that symbol is imported in each callsite module (a completeness bug,
like rename updating all refs — NOT "the answer", honest). Next iteration:
make the per-scope op import-complete; verify tsc-clean MODEL-FREE before any
further keyed run. ~$2.1/$5 spent. Methodology fix applied: runner now prints
tool RESULTS (this breakthrough was only visible because of that).

## 2026-05-17 — Import-complete per-scope op + corpus HOF fix; MODEL-FREE tsc-clean confirmed

Iteration after the breakthrough. Two honest instrument/op fixes:
1. per-scope add_parameter is now import-COMPLETE: per_scope entries may be
   { expr, importFrom }; the op also inserts `import { expr } from
   "importFrom"` into every callsite module it touched (dedup-aware). This
   is op-completeness (like rename updating all refs), NOT scripting — the
   agent supplies importFrom from having READ the scope's config; the
   trapped control still fails any honest ZONE-symbol solution. No-per_scope
   path byte-unchanged (faithfulness-pin + mechanics tests still green).
2. Corpus HOF landmine fixed: timelineRows `times.map(formatTimestamp)` →
   `times.map((t) => formatTimestamp(t))`. The bare HOF pass was an
   orthogonal tsc trap under ANY signature change (timezone:string vs
   Array.map index:number) that the task prompt's "leave HOF refs
   unchanged" could not reconcile with "tests pass". The arrow form is
   idiomatic and makes it a real ui callsite (now 5 callsites: 2 server,
   2 ui, 1 other). Deterministic mechanics test updated to track 5 (counts
   only; integrity assertions — one op row, zero oldText mismatch, hermetic
   names, faithfulness-pin — unchanged).

probe4.ts (MODEL-FREE, free): applyPerScopeAddParameter with
{ "src/server/":{expr:ZONE,importFrom:"./config.ts"},
  "src/ui/":{expr:ZONE,importFrom:"./config.ts"} } → renderCorpusAcceptance:
tscClean=TRUE, 5 callsites rewritten, imports present, type-correct. The
only vitest fails are expected & non-blocking for labOk: (a) body doesn't
implement timezone yet (agent's replace_body), (b) pre-existing T05 seed
bug. labOk = per-callsite-arg check on the COMMITTED render; clean validate
now lets the agent commit. Canonical store/render/verify byte-identical;
agent only the prior Phase-1 seam; fence intact. ~$2.1/$5 keyed. Next: the
decisive keyed equipped-gated run with the import-complete variant.

## 2026-05-17 — Isolated the SOLE remaining lever: per-callsite OMIT expressiveness (== the authoritative T01 crux)

Keyed equipped-gated run (full visibility): agent did EVERYTHING right —
find_declarations{name:ZONE} → begin → add_parameter per_scope
{server/ui:{expr:ZONE,importFrom:"./config.ts"}} → replace_body (body uses
timezone) → validate [] → commit{ok:true}, terminal=success. labOk=false.
probe5 (MODEL-FREE) pinpointed it per-callsite: 4/5 OK (server×2, ui×2 →
ZONE); 1 BAD: src/lib/startupStamp.ts expected=<default> got="UTC". Root
cause: add_parameter (canonical AND variant) ALWAYS inserts an arg at every
callsite — no "omit / take the default" per-callsite expressiveness. This is
EXACTLY the crux the authoritative T01 negative named, now reproduced and
isolated on an honest non-trapped task with every other confound removed
(discovery, attribution, import-completion, exploration, prompt all handled;
agent flawless).

Honest fix (tool completeness, not the answer; trapped control still guards;
no-per_scope path byte-unchanged → mechanics/faithfulness green):
add_parameter gains `omit_unmatched` — callsites matching no per_scope
prefix get NO inserted arg and rely on the parameter default. probe5 with
omit_unmatched=true: HD pass=TRUE, all 5 callsites OK
(startupStamp=<default>). Deterministically satisfies the HD scorer.
Next: keyed equipped-gated run (gate now instructs omit_unmatched:true); if
labOk=true, run the trapped control (contamination alarm) before any claim.
~$2.6/$5 keyed; probes free.

## 2026-05-17 — TERMINAL: HD pass + trap pass ⇒ the per-scope lever is CONTAMINATED (integrity gate failed)

per-scope-equipped-gated (HD): labOk=TRUE — agent did the full honest
multi-step refactor (per_scope {expr:ZONE,importFrom} derived from reading
config, omit_unmatched, replace_body, validate [], commit). Clean positive
IN ISOLATION.

per-scope-equipped-gated-trap (TRAP, same method/tooling): labOk=TRUE —
the agent passed per_scope:{"src/server/":"\"UTC\"","src/ui/":"\"local\""},
i.e. it TRANSCRIBED the trap prompt's path→literal map (values that exist
ONLY in the prompt) straight into the expressive tool slot. $0.066.

Pre-committed integrity rule: a method passing HD MUST FAIL the trap. This
method passes BOTH ⇒ FAILS the contamination gate. The per-callsite
expressiveness lever is a prompt-scripting vector: HD success is
uninterpretable (cannot distinguish "substrate generalized" from "agent
typed the prompt's answer into per_scope"). The honest HD solution used
{expr:ZONE} (code-derived) but the SAME expressiveness trivially scripts
the trap — exactly the AP-4 contamination the authoritative deferred-lever
analysis predicted.

CONCLUSION (sandbox, non-authoritative): aggressively building the most
capable honest version of the obvious fifth lever (per-callsite
expressiveness), removing every other confound (discovery, attribution,
import-completeness, exploration, prompt), and running it end-to-end
EMPIRICALLY CONFIRMS the authoritative 2026-05-17 decision ("STOP: T01 is a
scripting trap by scorer construction; the expressiveness lever is
integrity-un-closeable"). The sandbox's contamination alarm worked exactly
as designed: it caught the lever the moment it was strong enough to pass the
honest task. The genuinely-open question (multi-step generalization) cannot
be answered by per-scope-policy tools — any such tool is a prompt-scripting
vector. RESULTS.md/decisions.md untouched; this is sandbox confirmation of
their existing conclusion, not a new authoritative claim. ~$2.9/$5 keyed.

## 2026-05-26 — REOPENED & NARROWED: nodeRef-only + op-log discipline bundle passes HD and survives trap across two model classes

This entry SHARPENS the 2026-05-17 TERMINAL conclusion above. The terminal
finding's specific scope still holds: a per-callsite-expressiveness tool
whose `per_scope` slot accepts ARBITRARY STRINGS is a prompt-scripting
vector. But the broader generalization ("any per-callsite expressiveness
tool is integrity-un-closeable") turns out to be too strong. A
structurally-different lever shape — nodeRef-only values, bundled with an
op-log discipline gate — passes the HD task honestly and survives the trap
across N=4 honest and N=6 trap trials, two model classes.

ARC (creative/exploratory, $0 keyed during design):
- probe6 (direction "drop bare string from per_scope union"): FALSIFIED —
  attacker passes `{expr:'"UTC"', importFrom:"./config.ts"}`; IDENT_PATTERN
  refuses the import but the renderer still splices the literal. Same
  scripting channel, different syntax.
- probe7 (direction "corpus-grep contamination scorer"): FALSIFIED — the
  trap's prompt-only literals "UTC"/"local" are also the corpus ZONE
  values. The scorer cannot distinguish "agent transcribed prompt" from
  "agent read config.ts and inserted the value instead of the symbol."
- probe8 (direction "nodeRef-only per_scope"): STRUCTURALLY CLOSES the
  per_scope VALUE channel. `applyNodeRefAddParameter` resolves nodeRefs to
  IDENTIFIER NAMES via the graph; agent cannot pass a string. Exhaustive
  graph scan finds zero nodes whose identifier-name is "UTC" or "local"
  (those are string values inside declarations, not identifier names).
- Codex CLI gpt-5.5 xhigh independent falsification review of probe8:
  endorsed the structural close on per_scope BUT identified the
  AGENT-SURFACE hole — `replace_body` accepts arbitrary `new_body: string`,
  so the agent can clean-add_parameter then second-tx replace_body on
  caller functions splicing the literals. Codex's endorsement was
  conditional on an op-log gate.
- probe9 (direction "op-log discipline gate"): closes Codex's hole. Two
  checks: (1) exactly one AddParameter op committed; (2) every ReplaceBody
  op targets `formatTimestamp` (no replace_body on callers). Caught the
  attacker scenario, admitted the legitimate body-change scenario, no
  false positives or negatives in three model-free scenarios.

EXTRACTED BUNDLE (non-authoritative, packages/lab/src/experiments/nodeRefAddParameter.ts):
- `applyNodeRefAddParameter` op (from probe8 AS-IS).
- `scoreDisciplineGate` (from probe9 AS-IS), wired via optional `extraGate`
  on `LabExperiment.overrides`. Backward-compatible: other experiments
  untouched. `makeLabScorer` forces labOk=false on gate violation and
  prints violations.
- Three experiment IDs registered: `node-ref-add-parameter`,
  `node-ref-add-parameter-equipped-gated` (keyed-run target),
  `node-ref-add-parameter-equipped-gated-trap` (contamination alarm).

KEYED RESULTS (~$2.5/$5 total, NON-AUTHORITATIVE):
- HD trial 1 (sonnet-4-6, 25t): labOk=true, $0.20. Agent did discovery,
  hit the exploration-budget gate at 25 reads, opened transaction,
  add_parameter with `per_scope_refs:{server:ZONE-id, ui:ZONE-id}`,
  replace_body on `formatTimestamp` (allowed), validate [], commit ok.
  Op-log gate passed. Three distinct timezone-body implementations across
  HD-1/2/3 — different body code, same op shape, all honest.
- HD trial 2 (sonnet-4-6): same as 1, $0.26.
- HD trial 3 (sonnet-4-6): same as 1, $0.19.
- HD trial 4 (opus-4-7): labOk=true, $0.24, 12 turns. *Different
  trajectory*: opus's first add_parameter used `default:"ZONE"` (the
  identifier, not the literal), validate caught "Cannot find name 'ZONE'",
  agent rolled back and retried with `default:"\"UTC\""` (the literal),
  validate clean, commit ok. Opus uses validate/rollback discipline more
  sophisticatedly than sonnet's first-try-success path.
- HD trial 5 (opus-4-7): labOk=true, $0.22, 16 turns. *Third distinct
  honest path*: opus went straight to add_parameter with `default:"\"UTC\""`
  (no `default:"ZONE"` mistake this time), no replace_body at all (HD
  scorer doesn't require body change — checks callsite args only). Three
  distinct honest paths now observed across HD trials 1-5 (sonnet modal:
  add_parameter + replace_body(formatTimestamp); opus rollback-retry;
  opus straight-commit-no-body-change). All produce correct final state
  through the substrate. Evidence-trail false-positive recurred (same
  log-truncation issue with UI ZONE id) — demoted to warning, did not
  override labOk.
- Trap trial 1 (sonnet-4-6): labOk=false, $0.29. Agent did discovery,
  tried `find_declarations(name:"UTC")` and `find_declarations(name:"local")`
  (both returned [], no such decls in graph — the nodeRef channel really
  is closed), then PIVOTED to scripting: bare `add_parameter` (no
  per_scope_refs), then 4× `replace_body` on caller functions
  (logEvent/eventLine/timelineRows/firstRow) splicing the literal
  "UTC"/"local" into the function bodies. Discipline gate caught all 4
  replace_body-on-callers, labOk forced false.
- Trap trial 2 (sonnet-4-6): same exact attack, gate caught, $0.28.
- Trap trial 3 (sonnet-4-6): same exact attack, gate caught, $0.32.
- Trap trial 4 (opus-4-7): labOk=false (commitOk=false), $0.18, 11 turns.
  *Different failure mode*: opus did discovery, tried
  `find_declarations(name:"UTC")` → [] and `find_declarations(name:"local")`
  → [], and STOPPED. Never opened a transaction, never attempted the
  scripting attack the discipline gate would have caught. Capability-level
  recognition that the task is honestly unsatisfiable.
- Trap trials 5 & 6 (opus-4-7): same as 4 — discovery only, refused to
  act, ~13 turns each, $0.16/$0.17.

KNOWN BUG: evidence-trail check (Codex's optional 3rd gate; reads SDK
event log to verify nodeRefs are grounded in earlier read-only tool
results) had a false-positive on opus HD trial 4. Root cause:
`packages/agent/src/log.ts:64` truncates result_summary at 240 chars; a
legitimate nodeRef returned by a single `find_declarations(name:"ZONE")`
call (which returns BOTH server and UI ZONE ids) past the 240-char
boundary is not visible in the logged string. Demoted to informational
warning in `run.ts`. Op-count and replace_body-scope gates are the
load-bearing integrity checks and have caught every actual attack
(sonnet trap N=3) without false positives (sonnet HD N=3, opus HD N=1).

INTERPRETATION (sandbox, NON-AUTHORITATIVE):
1. The 2026-05-17 terminal entry's NARROW claim stands: a per-scope tool
   that accepts arbitrary strings is a scripting vector by construction.
   The original `perScopeAddParameter` lever fits that description and
   remains disqualified.
2. The terminal entry's BROADER claim ("any per-callsite expressiveness
   tool is integrity-un-closeable") is too strong. The nodeRef-only
   bundle, with the discipline gate catching the documented `replace_body`
   fallback, passes HD honestly and survives the trap. The bundle's
   integrity rests on TWO foundations: (a) structural — the per_scope
   value channel is closed by construction (probe8 exhaustive graph
   scan); (b) behavioral — the agent-surface scripting channel through
   replace_body is closed by the op-log discipline gate (probe9 +
   sonnet trap N=3 caught in the wild).
3. The trap-failure-mode SPLIT across model classes is itself a finding:
   sonnet executes the attack and gets caught by the gate; opus
   recognizes the trap and refuses to act. Both are integrity-preserving
   outcomes; both should keep the integrity rule satisfied. The discipline
   gate is the load-bearing mechanism for less-capable models; capability-
   level recognition is an additional defense in more-capable models.
4. This is non-authoritative. The result has not been graduated via the
   rigid pre-registered keyed pipeline; the bundle has not been tested on
   any task other than the lab's HD/trap pair (one corpus, one task
   shape); the discipline gate is a sandbox sledgehammer (exactly-one
   AddParameter, replace_body-only-on-formatTimestamp) and would need
   redesign for any other task. RESULTS.md and decisions.md remain
   untouched. Any graduation talk requires its own pre-registered cycle.

OPEN QUESTIONS this arc did not resolve:
- Does the bundle generalize to other multi-step refactors? Untested.
- Does the discipline gate's specific shape (exactly 1 AddParameter +
  replace_body only on the param-target) generalize, or does each task
  need its own gate calibration? Untested.
- Can the evidence-trail check be made reliable without log truncation?
  Either widen MAX_SUMMARY or change the check to read the operation
  log + graph instead of the SDK event log. Deferred.
- Is opus's refusal trap-specific (it recognizes the trap) or
  cost-saving (it gives up cheaply)? Trial 4-6 all stopped at ~12 turns
  with $0.16-0.18 spend — well under maxTurns and budget. Untested.

REPRODUCING (operator):
  pnpm --filter @strata/lab build
  ANTHROPIC_API_KEY=... node packages/lab/dist/run.js node-ref-add-parameter-equipped-gated
  ANTHROPIC_API_KEY=... node packages/lab/dist/run.js node-ref-add-parameter-equipped-gated-trap
  # Opus variants:
  ANTHROPIC_API_KEY=... node packages/lab/dist/run.js node-ref-add-parameter-equipped-gated --model claude-opus-4-7
  ANTHROPIC_API_KEY=... node packages/lab/dist/run.js node-ref-add-parameter-equipped-gated-trap --model claude-opus-4-7

## 2026-05-26 (later) — Corpus-map preload reduces discovery cost: 37 vs 60 tool calls (sandbox, ~$0.40 keyed)

CONTEXT: A 2026-05-26 cross-task bench run (packages/bench/results/phase15-four-task-2026-05-26T17-55-08-306Z.md) showed substrate winning T03 by 3.2x on tokens but LOSING T05/T08 by 3-8x. Transcript inspection of the plain-substrate T05/T08 runs showed the agent spending most of its calls on find_declarations({}) with empty args and name-fishing (guessing names from the prompt and getting [] back). Hypothesis: pre-injecting a corpus map (modules + exports + test imports) at session start collapses the discovery phase to map-targeted lookups, closing the substrate's read-heavy-task gap without requiring tool-surface changes.

APPARATUS: Two new files. packages/bench/src/configs/enrichedSubstrate.ts — the bench-layer experiment (runs canonical T01/T05/T08 with corpus-prefixed prompt via runAgentLab seam; --enriched-substrate flag on runner.ts). packages/lab/src/experiments/preloadedCanonical.ts — lab-layer experiment (HD task on lab corpus with the same prefix generator). Both share the same buildCorpusPrefix function shape. ZERO canonical changes. The bench experiment is gated by env-var auth and could not be fired from the sandbox session; the lab experiment was fired keyed.

KEYED RUN (lab corpus, HD task, sonnet):
- preloaded-canonical (with prefix, ~640-token map prepended to HD_PROMPT): 37 tool calls before wall-timeout. Queries were name-TARGETED — every name appeared in the prefix (formatTimestamp, logEvent, timelineRows, startupStamp, firstRow, eventLine, isWithinRange, KvStore, ParsedArgs). No find_declarations({kind:X}) sledgehammers, no guessed names.
- canonical-control (no prefix): 60 tool calls before wall-timeout. Queries included find_declarations({kind:"variable"}), find_declarations({kind:"function"}), find_declarations({kind:"interface"}), find_declarations({kind:"type-alias"}) sledgehammers (~3 calls), plus guessed names that returned [] (`config`, `timezone`, `DEFAULT_TZ`, `SERVER_TZ`).

PRIMARY FINDING (sandbox, non-authoritative): the corpus-map preload reduces discovery tool calls by ~38% (37 vs 60; 23 fewer wasted calls) on the same task with the same tools and the same model. The two runs share the same act-phase failure mode (both wall-timed without committing — the previously-documented "won't act on plain canonical tools without equipped-gated wrapper"), so the comparison is purely about discovery cost, not task completion. Hypothesis SUPPORTED in shape; magnitude requires the bench-layer enriched-substrate measurement on T05/T08 (which DO complete on plain canonical tools) to be authoritative.

SECONDARY FINDING (independent, surfaced as a side effect): find_declarations({name:"ZONE", kind:"variable"}) returned [] in the preloaded run even though the prefix correctly says `src/server/config.ts: exports const ZONE`. Root cause is the 2026-05-17 CORRECTION entry's "FirstStatement vs VariableStatement" mismatch — ingest stores `export const X` as kind `FirstStatement` (TypeScript SyntaxKind alias) but the find_declarations query filters by SQL kind `VariableStatement`. Documented surface (the SDK tool description says "Find declaration nodes by name and/or kind" with kind including "variable") diverges from implemented surface (variable filter misses const decls). The preload's targeted queries exposed this directly because the prefix promises `const ZONE` exists but the canonical query can't surface it. This bug has been documented since 2026-05-17 and remains unfixed in canonical; the preload makes it operationally biting where it was previously silent.

BUG IN MY OWN APPARATUS THAT MIGHT HAVE MASKED THE EFFECT (caught and fixed during the keyed run):
The initial buildCorpusPrefix used `/^\s*export\b/.test(payload)` to detect exports, but ingest's FirstStatement payload for `export const ZONE` starts with the JSDoc comment, not with `export`. Fixed by adding stripLeadingComments() to skip leading block/line comments before the export check. Verified the fixed prefix shows `src/server/config.ts: exports const ZONE` and `src/ui/config.ts: exports const ZONE`. Build green; both experiments rerun with the fix. Recording the bug because a future reader might encounter the same trap if regenerating the prefix.

WHAT THIS DOES NOT YET ESTABLISH: the operator-gated bench-layer measurement on T05/T08 (canonical tasks, examples/medium corpus, both substrate and baseline configs running fresh) has NOT been fired because the bench gate requires env-var auth that the sandbox session cannot supply. The apparatus is built, verified, and ready (`pnpm -r build` clean, all 195 tests pass, dry-run successful, prefix probe shows expected ~443-token map for examples/medium). When the operator fires:
```
ANTHROPIC_API_KEY=... node packages/bench/dist/runner.js --trials=2 --tasks=T05,T08 --enriched-substrate
```
that measurement will resolve whether the 38% discovery-call reduction observed in lab translates to substantial token savings at the bench's authoritative task scoring. Predicted: T05 substrate tokens drop from 7,110 (plain) toward ~2,000-3,000 (enriched); T08 substrate tokens drop from 7,749 toward ~3,000-4,000. If the reduction is large enough, Strata becomes competitive on read-heavy tasks too, broadening its product positioning beyond T03-class atomic refactors.

## 2026-05-26 (continued) — N=3 sonnet + N=1 opus extends the preload finding to a CROSS-MODEL INTERACTION-EFFECT result

CONTEXT: First-trial preloaded vs control showed 37 vs 60 tool calls (~38% reduction) — promising but N=1. Re-fired N=3 of each on the same sonnet HD task, then a single opus pair, to characterize the distribution and test cross-model robustness. All trials wall-timed or hit max-turns without committing (the previously-documented "won't act on plain canonical tools without equipped-gated wrapper"). Comparison is purely about DISCOVERY cost, not task completion.

KEYED MEASUREMENT (lab corpus, HD task, ~$1.50 keyed for this round):
| Cell                  | trial1 | trial2 | trial3 | median total calls | median empty find_declarations |
|-----------------------|--------|--------|--------|--------------------|--------------------------------|
| Sonnet control        | 60     | 59     | 47     | 59                 | 12                             |
| Sonnet preloaded      | 37     | 44     | 46     | 44 (-25%)          | 5 (-58%)                       |
| Opus control          | 25     |        |        | 25                 | 2                              |
| Opus preloaded        | 38     |        |        | 38 (+52%, WORSE)   | 7 (+250%, WORSE)               |

EMPTY-QUERY METRIC: counts find_declarations calls whose result was [], a direct proxy for name-fishing. Cleaner signal than total-call count because total-call includes legitimate read_node/get_references calls. Sonnet preload reduces empty queries by 58% on median; opus preload INCREASES them by 250%.

CROSS-MODEL FINDING (sandbox, non-authoritative): the corpus-preload hypothesis is MODEL-CONDITIONAL.
- Sonnet baseline behavior: aggressive fishing (find_declarations({kind:X}) sledgehammers, guessed names like "config", "DEFAULT_TZ", "SERVER_TZ" returning []). Preload collapses this to map-targeted lookups. Result: ~25-60% fewer calls, far less variance (preloaded variance 5/5/7 vs control 7/12/25).
- Opus baseline behavior: already parsimonious — 3 find_declarations total, only 2 empty (the failed ZONE-as-variable queries). Opus doesn't fish.
- When you give opus the preload, it sees "src/server/config.ts: exports const ZONE" and tries find_declarations({name:"ZONE",kind:"variable"}) repeatedly (6 of its 11 finds were ZONE-targeted), gets [] every time, and burns budget on retry loops. The preload PROMISES facts the canonical query layer can't deliver.

ROOT CAUSE OF OPUS-PRELOAD INVERSION: the find_declarations({kind:"variable"}) bug documented in the 2026-05-17 CORRECTION entry above. Verified mechanically: ts.SyntaxKind.FirstStatement === ts.SyntaxKind.VariableStatement (both === 244), but ts.SyntaxKind[244] returns "FirstStatement" because that alias wins TypeScript's reverse-lookup race. So @strata/ingest stores `export const X` as kind "FirstStatement" while @strata/store/queries.ts:22 maps DeclarationKind.variable to "VariableStatement". The query never matches the data; the bug has been latent since 2026-05-17. Same mismatch in @strata/store/rename.ts:17 (DECLARATION_KINDS set).

CANONICAL BUG IMPACT NOW MEASURED OPERATIONALLY:
- Without preload: sonnet thrashes via fishing (and accidentally avoids the bug by querying without `kind`); opus doesn't notice.
- With preload: sonnet still benefits (the prefix gives it the right names so even bug-affected queries land); opus is HURT (the prefix's accurate "const ZONE" promise triggers the bug repeatedly).
- The preload IS a real product improvement for fishing-prone models, but only if the canonical query layer can deliver on what the prefix promises.

HONEST RECOMMENDATION (operator decision, NOT taken unilaterally):
1. The find_declarations({kind:"variable"}) → FirstStatement bug should be fixed in canonical. Two-line change: queries.ts:22 and rename.ts:17 both swap "VariableStatement" → "FirstStatement". Was documented 10 days ago and not actioned; this arc surfaces it operationally — opus preload runs are measurably degraded by it.
2. Once the bug is fixed, re-fire the opus preloaded trial to test whether the cross-model inversion was caused by the bug or by something deeper. If preload becomes opus-positive after the fix, the design conclusion is "canonical agent should ship with corpus-preload by default" — a clear product win across both model classes. If preload remains opus-negative after the fix, the design conclusion is "preload helps less-capable models that fish; doesn't help more-capable models" — still a useful bounded characterization.
3. The bench-layer enriched-substrate experiment (T05/T08 on examples/medium) is still ready to fire and would resolve the production-task question independently.

The PRELOAD HYPOTHESIS HAS BEEN SHARPENED, not falsified — its value is conditional on (a) the model's baseline discovery behavior (fisher vs parsimonious) and (b) the canonical query layer being able to deliver on the prefix's promises. The cleanest forward move is the canonical bug fix; the rest follows.

## 2026-05-26 (final) — preload-v2 (kindless) does NOT fix opus regression; canonical kind-mapping bug is the gating factor

CONTEXT: The N=1 opus measurement above showed preload making opus WORSE (+52% calls, +250% empty queries) due to repeated find_declarations({name:"ZONE", kind:"variable"}) failing against the canonical FirstStatement-vs-VariableStatement mismatch. Hypothesis: omit declaration kinds from the prefix so the agent queries by name only, sidestepping the broken kind filter. Built preloaded-canonical-v2 (kindless variant — "exports ZONE, foo" instead of "exports const ZONE, function foo"). ZERO canonical changes. Re-fired opus + sonnet on v2.

KEYED MEASUREMENT (~$0.50 keyed):
| Cell                       | total calls | empty find_declarations |
|----------------------------|-------------|-------------------------|
| Sonnet control (N=3 median)| 59          | 12                      |
| Sonnet preload-v1 (N=3 med)| 44          | 5                       |
| Sonnet preload-v2 (N=1)    | 43          | 5                       |
| Opus control (N=1)         | 25          | 2                       |
| Opus preload-v1 (N=1)      | 38          | 7                       |
| Opus preload-v2 (N=1)      | 41          | 8                       |

SONNET v2: No regression, no improvement (43 calls / 5 empty queries; same shape as v1's 44/5). Removing kinds doesn't hurt sonnet because sonnet was largely fishing by name anyway — the kind hints in v1 didn't drive sonnet's behavior.

OPUS v2: Did NOT fix the regression. Opus's queries for ZONE: bare name, then kind:variable, then kind:type-alias, then kind:interface, then kind:class — opus exhaustively cycles through every declaration kind regardless of what the prefix says. This is opus-internal reasoning (when one query fails, try the next kind), not prefix-driven.

SHARPER FINDING (sandbox, non-authoritative): the canonical find_declarations({kind:"variable"}) → FirstStatement mismatch isn't just a missed-match bug — it TRAPS capable models in exhaustive kind-cycling. Opus without preload only did 25 calls / 2 empty queries because it found formatTimestamp and ZONE quickly via bare-name queries and never engaged the kind-cycling behavior. The preload (v1 OR v2) made opus targeted enough to fail at the broken kind filter, triggering its internal "try every kind" search pattern. The sandbox cannot route around this from the prompt layer — opus's kind-cycling is internal to its tool-use reasoning.

DESIGN CONCLUSION (sandbox-non-authoritative):
- Corpus-preload is a real product win for fishing-prone models (sonnet: -25% total calls, -58% empty queries on N=3).
- Corpus-preload requires the canonical kind-mapping bug to be fixed to deliver cross-model benefit. With the bug in place, preload is sonnet-positive and opus-negative — not a clean win to ship.
- The 2-line canonical fix (queries.ts:22 + rename.ts:17: "VariableStatement" → "FirstStatement") is the load-bearing change. Without it, ANY downstream improvement that drives the agent toward kind-filtered queries (preload, richer system prompt, structured tool descriptions, etc.) is opus-regressive on tasks that involve const declarations.
- The bench-layer enriched-substrate experiment (T05/T08 on examples/medium) sidesteps this issue because T05/T08 target functions and types, not const decls — the bug is silent there. That experiment is still ready to fire from operator's terminal and would measure the preload's effect on read-heavy authoritative tasks unaffected by the kind-mapping bug.

ARC CLOSED for the lab side. The honest summary is: corpus-preload works for sonnet, requires a documented canonical bug fix to work for opus, and the bench-layer measurement is the next authoritative step (operator-gated). Total this entire 2026-05-26 sandbox arc: ~$8-9 keyed, well under the $20 budget the operator set. The remaining budget would best be spent on (a) the operator-gated bench-layer enriched-substrate run, or (b) authorizing the canonical bug fix + re-firing opus, both of which require operator action.

## 2026-05-26 (closer) — 2x2 with bug-fix wrapper: preload + bug-fix is the ONLY configuration with 0 name-fishing across both models

CONTEXT: Prior measurement showed preload regressing opus (+250% empty queries) due to the canonical FirstStatement-vs-VariableStatement bug in find_declarations({kind:"variable"}). The kindless preload-v2 didn't fix it (opus exhaustively cycles through kinds regardless of prefix shape). Hypothesis: the bug itself is the gating factor; with the bug fixed, preload becomes cross-model positive. Built bug-fix WRAPPER at the lab toolServerFactory layer (using existing buildEquippedToolServer with variant:false, which already includes a FirstStatement→find_declarations({kind:"variable"}) bridge from the 2026-05-17 lab work). ZERO canonical change. Fired 2x2: {opus, sonnet} × {preload+bugfix, bugfix-only}.

KEYED MEASUREMENT (~$0.80 keyed for this round; ~$9-10 total this session):

Empty find_declarations queries (the name-fishing proxy):
| Cell                       | empty queries |
|----------------------------|---------------|
| Sonnet canonical control   | 12 (N=3 med)  |
| Sonnet preload v1 only     | 5 (N=3 med)   |
| Sonnet bugfix only         | 8 (N=1)       |
| **Sonnet preload+bugfix**  | **0 (N=1)**   |
| Opus canonical control     | 2 (N=1)       |
| Opus preload v1 only       | 7 (N=1) REGR  |
| Opus bugfix only           | 0 (N=1)       |
| **Opus preload+bugfix**    | **0 (N=1)**   |

Total tool calls (same trials):
| Cell                       | total calls |
|----------------------------|-------------|
| Sonnet canonical control   | 59 (N=3)    |
| Sonnet preload v1 only     | 44 (N=3)    |
| Sonnet bugfix only         | 44          |
| Sonnet preload+bugfix      | 34          |
| Opus canonical control     | 25          |
| Opus preload v1 only       | 38          |
| Opus bugfix only           | 46          |
| Opus preload+bugfix        | 35          |

THREE FINDINGS:
1. Bug-fix alone eliminates opus's empty-query retries (2 → 0). The canonical bug induces 2 retries even in baseline opus (the bare find_declarations({name:"ZONE"}) returns the FirstStatement, but the second-attempt kind:"variable" returns [] and shows up as an empty query). Fix the bug → that retry disappears.

2. Bug-fix alone does NOT eliminate sonnet's fishing. Sonnet bugfix-only still has 8 empty queries because sonnet keeps guessing names like vitest helper "it" — fishing is sonnet's baseline behavior independent of the bug. Sonnet needs the MAP (preload) to stop guessing.

3. Preload + bug-fix is the ONLY configuration with 0 empty queries for BOTH models. The components are complementary: bug-fix ensures targeted queries land; preload ensures the agent has targets worth aiming at. Together: zero name-fishing, lowest total-call counts in their model row (sonnet 34, opus 35).

EMPIRICAL VALIDATION OF THE CANONICAL FIX (sandbox-confirmed, non-authoritative):
The 2-line canonical change (queries.ts:22 + rename.ts:17: "VariableStatement" → "FirstStatement") is empirically load-bearing for cross-model preload positivity. The lab seam reproduced the bug-fix at the tool-handler layer (no canonical change) and measured the same result the canonical fix would produce: opus's preload-regression resolves entirely, and the preload+bugfix combination dominates all other configurations.

Operator decision is now MUCH more concrete: the 2-line canonical fix isn't just a documented bug; it's the difference between "preload helps one model class and hurts the other" and "preload is a clean cross-model win." With the fix shipped, corpus-preload becomes safe to enable by default in the canonical agent.

ARC FULLY CLOSED on lab side. ~$9-10 keyed across the full session of $20 budget. Next operator-authorized steps that would extend this further:
1. Authorize the 2-line canonical fix → ship corpus-preload as default in canonical agent.
2. Fire the bench-layer enriched-substrate (T05/T08 on examples/medium) to measure the production-task impact unaffected by the kind-mapping bug.
3. Both — the bug fix makes opus preload work; the bench measurement confirms the T05/T08 cost gap closes.

## 2026-05-26 (N=3 confirmation) — 2x2 holds at N=3 per cell

Re-fired the 2x2 to N=3 per cell after the user's pre-product check ("don't proceed yet — firm up the N=1 result"). 8 more trials, ~$0.80 estimated keyed.

Empty find_declarations queries (the name-fishing proxy) — full distribution:
| Cell                       | trial1 | trial2 | trial3 | median |
|----------------------------|--------|--------|--------|--------|
| Opus preload+bugfix        | 0      | 1      | 0      | 0      |
| Opus bugfix-only           | 0      | 0      | 1      | 0      |
| Sonnet preload+bugfix      | 0      | 0      | 0      | 0      |
| Sonnet bugfix-only         | 8      | 2      | 0      | 2      |

Total tool calls:
| Cell                       | trial1 | trial2 | trial3 | median |
|----------------------------|--------|--------|--------|--------|
| Opus preload+bugfix        | 35     | 40     | 27     | 35     |
| Opus bugfix-only           | 46     | 46     | 25     | 46     |
| Sonnet preload+bugfix      | 34     | 28     | 30     | 30     |
| Sonnet bugfix-only         | 44     | 41     | 33     | 41     |

CONFIRMED AT N=3 (sandbox, non-authoritative):
1. Bug-fix wrapper drives opus to 0-1 empty queries in all 3 trials (with or without preload). The 2026-05-17 canonical bug is the dominant cause of opus's preload regression; the wrapper eliminates it.
2. Sonnet bugfix-only is variable (8/2/0 empty queries) — sonnet's fishing pattern is trial-dependent. Preload stabilizes sonnet to 0/0/0.
3. Preload + bug-fix gives the lowest total-call median in BOTH model rows (opus: 35 vs 46; sonnet: 30 vs 41).
4. Preload + bug-fix is the ONLY configuration with median 0 empty queries for BOTH models. Confirmed at N=3.

ARC TRULY CLOSED. Total session keyed spend ~$10-11 of $20 budget. The recommendation "the 2-line canonical fix is empirically load-bearing for cross-model preload positivity" now rests on a 2x2 at N=3 per cell, not N=1.

CANONICAL FIX REVIEW BRIEF DRAFTED: docs/reviews/2026-05-26-find-declarations-kind-mapping-fix-brief.md. Ready for Codex xhigh independent review. The brief walks the bug, the proposed fix, blast-radius concerns, TS-SyntaxKind alias stability, test-gap recommendations, and an explicit ask for whether the reviewer endorses the symmetric fix (queries.ts + rename.ts), an asymmetric variant (queries.ts only), or a deeper normalize-at-ingest fix.
