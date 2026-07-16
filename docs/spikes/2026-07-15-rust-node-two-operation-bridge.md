# Rust–Node two-operation bridge evidence

**Date:** 2026-07-15

**Result:** bounded PASS

**Implementation range:** `9d4afab..eeee1d2` plus the Task 12 default-feature test-target correction

**Fixture:** ingest-derived `examples/medium`; full snapshot 1,282 nodes/614 references, production candidate source projection 1,203 nodes/592 references across 22 `src/**` modules

## Decision

The two-operation bridge gate passes at its explicitly tested boundary. Real
`rename_symbol` and uniform-value `add_parameter` intents travel through the
Rust-owned scheduler and authority checks, use the existing TypeScript
mutations and validator in a one-shot scratch worker, and publish/recover one
canonical Rust/redb generation and operation. The SQLite product path remains
supported.

This is not approval of the later full key-free multi-client acceptance gate,
a live model comparison, operations beyond rename/add-parameter, or candidate
validation of every row in the 1,282-node fixture. Those remain open.

## Environment and method

- macOS 26.5.2 (25F84), Apple host
- Node v26.3.0; pnpm 10.26.2
- rustc/cargo 1.89.0
- pre-evidence head `eeee1d20d596ca7a84cd0e649ae0464abe1c23a0`
- deterministic, key-free tests only; no model call or benchmark run
- commands were run once in plan order. Only the failed default Rust gate was
  rerun after its targeted correction; no clean full gate was rerun.

The real-worker candidate fixture is the ingest-derived `examples/medium`
`src/**` source projection. The untouched full fixture remains the authority
for graph/scope disjointness checks. G+1 is the committed
`examples-medium-add-parameter-g1.snapshot.json`, generated from a temporary
copy with one appended module containing one new direct `greet` call.

## Build and static gates

| Command | Result | Wall time |
| --- | --- | ---: |
| `pnpm -r build` | PASS | 1.94 s |
| `cargo fmt --all -- --check` | PASS | 0.62 s |
| `cargo clippy -p strata-kernel --all-targets --all-features -- -D warnings` | PASS | 1.91 s |
| `cargo check -p strata-kernel --no-default-features` | PASS | 0.20 s |
| `cargo check -p strata-kernel --features coordination-test-api` | PASS | 0.09 s |

## Test gates

| Command | Result | Wall time / detail |
| --- | --- | --- |
| `pnpm --filter @strata/kernel-bridge test` | PASS | 10.91 s; 71/71 |
| `pnpm --filter @strata/ingest test` | PASS | 1.55 s; 21/21 |
| `pnpm --filter @strata/store test` | PASS | 3.98 s; 177/177 |
| `pnpm --filter @strata/verify test` | BASELINE FAIL | 40.41 s; 69/70; unchanged line 228 failure below |
| `pnpm -r test` | BASELINE FAIL | 37.91 s; stopped at the same verify failure |
| `cargo test -p strata-kernel` | PASS after correction | first compile failed in 14.52 s; affected rerun passed in 56.50 s |
| `cargo test -p strata-kernel --features coordination-test-api` | PASS | 127.47 s; failure matrix 1/1 in 50.61 s |
| `cargo test -p strata-kernel --features redb-spike-api` | PASS | 169.85 s; failure matrix 1/1 in 49.74 s |
| `pnpm kernel:bridge:test` | PASS | 28.49 s; bridge 71/71 plus real-worker 3/3 |

The first default Rust run exposed one new Task 11 packaging defect:
`node_bridge_failures.rs` compiled without `coordination-test-api` although all
17 hooks it used were feature-only. Adding the same crate-level feature guard
used by peer integration targets corrected the boundary. The full default Rust
command was rerun once and passed; the coordination-feature suites then ran
the 21-row failure matrix normally. This is a test-target correction, not a
semantic or authority change.

No EPIPE race, 5-second rename timeout, or prior 30-second Node timeout occurred
in this final pass. No gate is represented as clean based on an earlier rerun.

### Unchanged TypeScript baselines

- Verify: `packages/verify/tests/extractFunctionCommit.test.ts:228`, 69/70.
  The real-corpus extractor accepts the span, then `commit()` returns
  `ok: false` for the documented TS2454 (`args` used before assignment).
- Because `pnpm -r test` stops at verify, the agent package was rechecked
  directly. `pnpm --filter @strata/agent test` exited 1 in 5.30 s with exactly
  two stale replay fixtures and no new failure: `tests/labSeam.test.ts` and
  `tests/replay.test.ts`, both `Declaration not found: 5073ecfb56151b41`.
  Result: 53 passed, 2 failed, 2 skipped.

## Feasibility measurements

A small read-only Node script built the same real `User -> Account` requests as
the worker tests and launched the compiled one-shot worker once per request.
These are characterization numbers, not a performance claim or benchmark.

| Real source-projection case | Request | Response | stderr | Wall time |
| --- | ---: | ---: | ---: | ---: |
| rename analysis | 239,543 B | 32,679 B | 0 B | 391.422 ms |
| rename candidate + tsc | 240,064 B | 10,532 B | 0 B | 700.120 ms |

One `node -e ''` launch measured 51.322 ms and is reported only as a process-
startup floor; the protocol has no ready signal that would isolate worker
module startup from semantic work. Both real success responses carried `[]`,
2 serialized diagnostic bytes. The enforced normalized-diagnostic maximum is
65,536 bytes.

Protocol-v1 hard limits are 33,554,432 request bytes, 16,777,216 response
bytes, 65,536 normalized diagnostic bytes, and 65,536 stderr bytes. The
measured real requests are below 1% of the request ceiling and responses below
1% of the response ceiling.

## Design acceptance cross-check

| Criterion | Result | Deterministic evidence |
| --- | --- | --- |
| Strict v1 schemas and shared Rust/TS golden frames | PASS | bridge protocol 21/21; Rust bridge protocol 22/22 |
| Unknown versions/kinds/fields, unsafe integers, duplicates, dangling records, oversize, and binding mismatch fail closed | PASS | protocol suites and 21-row `node_bridge_failures` matrix |
| Snapshot → scratch SQLite → snapshot is byte-equivalent | PASS | `snapshot.test.ts`; 1,282/614 full ingest snapshot coverage |
| Delta ordering/application is deterministic | PASS | snapshot delta tests and Rust graph generation tests |
| Client API exposes no provider/worker/scope/fence/storage authority | PASS | default `api_sealing` trybuild tests; missing-executor no-side-effect test |
| Real rename wide closure comes from TypeScript facts; Rust derives scope/policy | PASS | analyze tests and real-worker `User` analysis |
| Real rename builds, type-checks, contains, publishes once, renders, and recovers without Node | PASS | `real_user_rename_publishes_one_rust_operation_and_recovers_without_node` |
| Two disjoint rename candidates publish in either order; changed dependency requeues/rebuilds | PASS | feature `node_bridge` disjoint/rebase and dependency-drift cases |
| Add-parameter distinguishes calls, arity risks, and unresolved facts | PASS | analyze tests and real `greet` worker test |
| Existing uniform-value mutation is used and TypeScript-clean | PASS | candidate tests and G1 real-worker publication |
| Claim-time G+1 analysis requeues before candidate construction | PASS | `add_parameter_claim_reanalyzes_g1_and_requeues_before_candidate_construction` |
| Next claim edits the new callsite and publishes once | PASS | `real_add_parameter_on_g1_publishes_declaration_and_new_callsite_once` |
| G+1 causes no unrelated ID churn | PASS | exact G0 subset equality; +9 nodes/+2 references only; applying delta equals G1 |
| Composite uses one scratch transaction and one Rust generation/aggregate operation | PASS | candidate transaction tests and ordered composite acceptance |
| Mutation/validation/process/protocol/binding/stale failures publish nothing | PASS | candidate rollback tests and complete 21-row live/durable no-side-effect matrix |
| Out-of-scope well-formed delta is rejected by Rust containment | PASS | failure matrix plus coordination containment tests |
| Same-attempt replay accepts same digest and rejects changed digest | PASS | coordination publication/recovery tests |
| Restart recovers graph and canonical operation without Node | PASS | rename recovery and redb recovery 23/23 |
| Existing SQLite path remains supported | PASS with known baseline | store 177/177; verify retains only documented unrelated failure |

### Final review containment correction

The final whole-branch review found that the materialized-Identifier exception
could derive authority for an existing node from the worker-proposed parent.
A worker could therefore reparent an existing validation-only Identifier into
an inferred writable statement and gain node/edge write authority.

The regression failed first because containment returned `Ok(())`. The
corrected rule derives existing-node/source authority only from the current
graph and requires an Identifier upsert to retain its current kind, parent, and
child index; only a genuinely absent ID may derive authority from a proposed
new Identifier. Deletes also use current identity. The clean analyzer group
passed 3/3, including the existing direct-child and fresh-child cases.

Fresh post-correction gates passed: the 21-row failure matrix 1/1; bridge
71/71 plus default real-worker 3/3; feature real-worker acceptance 11/11;
default Rust (library 16 passed/1 ignored); coordination-feature Rust (library
16 passed/1 ignored); redb-feature Rust (library 19 passed/1 ignored); format;
strict all-target/all-feature Clippy; and no-default compile. The new unit test
is the only gate-count change. No EPIPE or timeout flake occurred.

## Divergence and stop-condition audit

The preferred complete-snapshot candidate experiment was attempted first. With
all 25 module paths localized and `sourceRoot=corpusRoot`, the existing verify
path returned `Validate/typescriptFailed`. The production candidate proof is
therefore explicitly limited to the 1,203-node/592-reference `src/**`
projection; 79 nodes, 22 references, and four known cross-boundary
`formatTimestamp` reference sources are excluded from candidate publication.
Full-snapshot semantic disjointness is still checked before projection. This
limitation is recorded in `decisions.md`; it is not silently described as a
full-fixture validation result.

No authority, canonical-storage, stable-ID, one-transaction, worker-failure,
message-size, or API-sealing stop condition fired. The source projection is a
bounded fixture-validation limitation, not permission to weaken trusted-root
checks or production containment.

## Remaining gate

The roadmap's **Two-operation proof** item is complete at this bounded result.
The later full key-free acceptance matrix remains unapproved, and the live
Strata-versus-worktrees comparison remains blocked until that separate gate
passes.
