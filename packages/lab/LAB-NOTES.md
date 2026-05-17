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
