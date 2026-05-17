# `add_parameter` legibility redesign: a manifest of what the tool did

*Spec. Date: 2026-05-17. Follows the positively-identified T01 lever in [`decisions.md`](../../../decisions.md) (2026-05-17, "T01 stronger-model probe: L2 confirmed"; 2026-05-15 BS-P-B; 2026-05-16 N=3). The gate is validated, the harness hardened, T03 robustly proven — this addresses the one remaining substantive lever.*

## Problem

`@strata/store`'s `add_parameter` correctly rewrites the function signature **and** inserts the new argument at every reference-graph-resolved direct callsite, in one transaction. But the tool returns **`{ ok: true }`** — zero verifiable evidence of what it did. The tool *description* already states, at length, "the argument is already inserted at each resolved direct callsite … you do not, and must not, hand-edit callsites afterward." Description-tuning of exactly this text was attempted and declared **terminal/falsified** (decisions.md 2026-05-15, BS-P-B): the agent ignores the prose.

Lacking concrete evidence and not trusting prose, the agent hand-patches the same callsites with `replace_body`. That manual edit's span overlaps the text-span edit `add_parameter` already queued for that statement, so commit fails with `commit text-span oldText mismatch` (`@strata/store/transactions.ts:142`) → rollback → `begin_transaction` → repeat. T01 never converges: sonnet 0/3, opus-4-7 0/2 (`operationRowAppended` 0 — never a correct committed change), the *identical* mechanism across models. Prompt-tuning is falsified, the commit gate is closed/validated, and a fair single-variable Opus probe ruled out model capability. The residual defect is **tool illegibility**: `add_parameter` does the right thing but reports nothing the agent can verify, so the agent re-does (and corrupts) the callsite work.

## Goal

Make `add_parameter` return verifiable, itemized evidence of exactly the edits **it** made, so the agent has no rational reason to hand-patch callsites and can proceed `validate → commit`. Measured by a pre-registered keyed re-run (transcript-classified), with T03 as a hard regression guard.

## Non-goals (scope boundaries — operator-set)

- **No `@strata/store` transaction/overlay semantics change.** The overlay the proven T03 rename depends on is untouched. If the agent still hand-patches in some runs and collides, that is the honestly-measured residual, not masked.
- **No collision-error rewrite.** `transactions.ts:142` "oldText mismatch" message is left as-is (operator chose manifest-only, not the "also make the collision legible" option).
- **No `add_parameter` description change.** Description-tuning is falsified; the description is held **constant as a deliberate control** so the keyed validation isolates the manifest as the single changed variable.
- No new corpus fixtures; no touching T05/T08, the gate, or the rename path.

## Approach: `add_parameter` returns an `AddParameterManifest`; the tool surfaces it

`@strata/store`'s `add_parameter` changes from `: void` to returning a manifest of the edits it just queued. The function already computes every field internally and discards it; this is a purely additive return value — no behavior or semantics change. Existing callers that invoke `add_parameter(...)` as a statement and ignore the return are unaffected (verified: CLI/store callers do not consume a return today; TypeScript permits ignoring a returned value where `void` was).

### Manifest shape

```ts
export interface AddParameterCallsiteEdit {
  modulePath: string;   // POSIX module path of the rewritten callsite
  statementId: string;  // affected statement node id
  before: string;       // statement payload text before the inserted argument
  after: string;        // statement payload text after the inserted argument
}

export interface AddParameterArityRiskSite {
  modulePath: string;
  statementId: string;
  reason: string;       // the ref kind the resolver already observed
                        // (non-direct-call: higher-order / aliased / other
                        // value position). No new analysis is introduced.
}

export interface AddParameterManifest {
  declaration: { id: string; beforeSignature: string; afterSignature: string };
  callsitesRewritten: AddParameterCallsiteEdit[];
  arityRiskSites: AddParameterArityRiskSite[];
}
```

- `declaration.before/afterSignature`: the declaration payload from its start through the end of the parameter list and return-type annotation, excluding the body block (i.e. up to but not including the body-opening `{`), before and after the queued parameter-insertion edit. The exact slice is pinned by the faithfulness invariant below (`afterSignature` must equal `beforeSignature` with the queued parameter edit applied), so prose precision here is not load-bearing.
- `callsitesRewritten[].before/after`: for each direct callsite the function rewrote, the statement payload and the same payload with the queued insertion applied (`payload.slice(0,start) + newText + payload.slice(start)`).
- `arityRiskSites`: the non-direct references `add_parameter` deliberately did **not** edit (already identified internally as it separates direct calls from other refs); `reason` is the kind already known to the resolver — no new classification logic.

### Tool surface (agent layer)

`packages/agent/src/tools.ts` `add_parameter` tool: `const m = add_parameter(...); return textResult({ ok: true, ...m });` — structured data, **no directive prose** (honors the integrity boundary: reports only what it did, no task guidance). The agent now receives concrete, scannable evidence (declaration before/after, the enumerated callsites with before/after, the arity-risk sites) in place of `{ ok: true }`.

## Integrity safeguard — manifest faithfulness

A key-free invariant test asserts the manifest is structurally honest: **every `callsitesRewritten` entry corresponds to a real queued text-span edit for that statement, every queued callsite edit appears exactly once in the manifest, and `declaration.afterSignature` equals the declaration payload with the queued parameter edit applied.** The manifest cannot claim an edit it did not queue or omit one it did. This is the analog of the T08 audit — it makes a convincing-but-fabricated manifest structurally impossible, independent of the keyed outcome.

## Error handling & edges

`add_parameter`'s existing validation throws (invalid identifier / type / default expression, declaration-not-found) are unchanged; the manifest is constructed only on the success path after edits are queued. Honest edge behavior: zero resolved direct callsites → `callsitesRewritten: []` (the agent sees there is nothing to hand-patch); references that are only higher-order/aliased → reported in `arityRiskSites`, never fabricated as rewrites.

## Testing

### Key-free regression net (BG-3: only `@strata/store` and `@strata/agent` gain tests, additively; every other package byte-identical, 0 failures, full build clean)

- `@strata/store`: `add_parameter` returns the correct `declaration.before/afterSignature`; exact `callsitesRewritten` (modulePath + statementId + before/after) on a multi-callsite, multi-module fixture; `arityRiskSites` populated for a higher-order reference; the **faithfulness invariant** above; the zero-callsite edge.
- `@strata/agent`: the `add_parameter` tool result carries the manifest fields (not bare `{ ok: true }`); replay/key-free determinism unchanged.

### Pre-registered keyed validation (frozen BEFORE the round, tamper-evident commit; classified from transcripts; logged newest-first in `decisions.md` whatever the outcome)

Round shape (frozen tamper-evidently in a separate pre-registration commit *before* the round, per the HN/GS/MP precedent): `claude-sonnet-4-6` (the model the benchmark's claims are on; model-capability already isolated out by the Opus probe), `--tasks=T01,T03` (T03 as regression guard), **N=3** (the project's claim bar, matching the N=3 hardening), artifact-derived per-task budgets (T01 `40t/420000ms`, T03 `25t/240000ms`), `--keep-artifacts`. Operator-run; spend (~$3–5, T01 walls long) confirmed at run time. The exact frozen AP-1..AP-4 wording lives in the pre-reg doc.

- **AP-1 (T03 regression guard — HARD STOP):** T03 substrate is the canonical single clean rename in every trial. The change is `add_parameter`-return-only and T03 never calls `add_parameter`; therefore *any* T03 movement indicates unexpected coupling — STOP, do not interpret T01.
- **AP-2 (does the manifest move T01):** from transcripts — T01 substrate reaches a correct committed change (`operationRowAppended` true AND T01 task-criteria success) in ≥1 of N trials ⇒ the manifest is effective (legibility was the lever); still 0/N ⇒ it did not move T01.
- **AP-3 (mechanism — the real readout regardless of AP-2):** does the agent still hand-patch callsites with `replace_body` after `add_parameter` and hit the `oldText` collision, or does the manifest cause it to stop hand-patching and proceed `validate → commit`? This characterizes the behavioral change even if T01 still fails for another reason.
- **AP-4 (no scripting / contamination):** the manifest contains only what `add_parameter` did (no task hints); any win is the agent declining to hand-patch given evidence, not the harness performing the task.
- Both AP-2 outcomes are pre-committed; an honest negative ("the manifest did not move T01") is a valid logged result, not a retry trigger. No budget/description/prompt change mid-round.

## Design-doc impact

None to architecture; sharpens `strata-design.md`'s tool-surface principle: a high-level structural tool must report the edits it made in verifiable, itemized form — tool legibility is part of the agent's worldview, not an afterthought. The keyed-round result will be logged as its own newest-first `decisions.md` entry.
