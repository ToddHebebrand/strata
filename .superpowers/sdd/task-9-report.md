# Task 9 report — scheduler gate and bounded decision

## Status

Recorded a bounded coordination-scheduler `PASS` at implementation commit
`1410eaa44db618a29a2398cd08c6503c3281d4fa`. Added the complete twelve-row
acceptance matrix, prepended the decision entry, and checked only the roadmap's
**Coordination kernel** item. **Two-operation proof**, **Key-free acceptance**, and
**Live falsifiable comparison** remain unchecked.

## Toolchains

- `rustc 1.89.0 (29483883e 2025-08-04)`
- `cargo 1.89.0 (c24e10642 2025-06-23)`
- Node.js `v26.3.0`
- pnpm `10.26.2`
- TypeScript `5.9.3`
- redb `4.1.0`

## Exact final gates

- `cargo fmt --all -- --check` — exit 0, no output.
- `cargo clippy -p strata-kernel --all-targets -- -D warnings` — exit 0,
  `Finished dev profile` with no warnings.
- `cargo clippy -p strata-kernel --features redb-spike-api --all-targets -- -D warnings`
  — exit 0, `Finished dev profile` with no warnings.
- `cargo test -p strata-kernel` — exit 0; 59 tests passed, 0 failed.
- `cargo test -p strata-kernel --features redb-spike-api` — exit 0; 109 tests
  passed, 0 failed.
- `pnpm --filter @strata/ingest build` — exit 0.
- `pnpm --filter @strata/ingest test` — exit 0; 8/8 tests passed.
- `pnpm -r build` — exit 0 across all 8 built workspace projects.
- `pnpm -r test` — exit 1 with the sole authorized baseline failure below;
  store 177/177, render 13/13, ingest 8/8, verify 69/70.

## Pnpm baseline classification

The only failure was:

```text
FAIL  tests/extractFunctionCommit.test.ts > extract_function on the real corpus > extracts a contiguous span from a medium-corpus function and commits green
AssertionError: expected false to be true // Object.is equality
 ❯ tests/extractFunctionCommit.test.ts:228:25
    226|     if (!(analysis instanceof Error)) {
    227|       const result = commit(db, tx);
    228|       expect(result.ok).toBe(true);
```

This is the previously authorized extractor mismatch: an unsafe `let args` span
reaches commit, where TS2454 (`args` used before assignment) is correctly rejected.
No scheduler change touched the extraction/verify path, and no second pnpm failure
appeared. It is therefore recorded as an unrelated baseline exception, not a
scheduler `FAIL`.

## Documentation and claims

- `docs/spikes/2026-07-14-coordination-scheduler.md` records the exact tested
  commit/toolchains/commands and all twelve approved acceptance rows.
- Rows 1–5 are explicitly bounded as scheduler-level intent+graph-derived
  test-analyzer proofs, not real TypeScript semantic or validation evidence.
- Row 12 distinguishes default Rust raw-publication API sealing from deferred
  transport/authentication and Node worker process isolation.
- Existing-resource versions are documented as payload/reference content hashes;
  graph generation remains separate authority. Global generation hashing would
  incorrectly turn unrelated disjoint commits into material scope changes.
- `decisions.md` records the pass, baseline exception, scope/version clarification,
  and deferred bridge/service/live boundaries.
- `docs/product-roadmap.md` advances only **Coordination kernel**.

## Files

- `.superpowers/sdd/task-9-report.md`
- `decisions.md`
- `docs/product-roadmap.md`
- `docs/spikes/2026-07-14-coordination-scheduler.md`

## Self-review

- Confirmed all claimed test names and totals against the final command output.
- Confirmed the report does not claim production TypeScript analyzers, validation,
  transport, authentication, worker isolation, or live agent results.
- Confirmed the inherited redb crash claim remains limited to explicit tested
  boundaries and does not claim instruction-level injection inside redb commit.
- Confirmed only one roadmap checkbox changed.
- No Rust or TypeScript production/test source was changed in Task 9.
