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
