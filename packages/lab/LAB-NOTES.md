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
