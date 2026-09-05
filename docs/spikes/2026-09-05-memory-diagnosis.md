# Persistent-worker RSS diagnosis — 2026-09-05

## Outcome

The registered N=12 guard still fails. A longer diagnostic and a no-mutation
control attribute the observed increase to collectable validation-workload
allocations and retained process capacity, not an identified accumulating
worker graph. This is not proof of unlimited-session memory safety and does
not turn the existing failure into a pass. No production code or acceptance
constant was changed.

Revision: `330e1faaaa34bd6992e6012f403251a3ea805719`; macOS arm64,
Node `v22.23.2`, V8 `12.4.254.21-node.56`; existing debug daemon,
`--persistent-bridge`, no validation manifest (the registered tsc-only path),
`examples/medium`. No live model calls. The preceding uninstrumented failures
are preserved in [restart verification](2026-09-05-restart-verification.md).

## Discriminating probes

1. **Natural-GC, 48 real publications.** Same alternating User/Account renames
   through the production typed client and daemon. A diagnostic-only Node
   preload samples worker `memoryUsage()` every 100 ms and observes GC events.
   The existing OS RSS sampler records post-publication and 200 ms quiescence
   samples. All 48 publications succeed and PID continuity holds. No forced
   collection occurs until AFTER iteration 48 and the first-12 verdict.
2. **Type-check-only control.** Hydrate the same qualified graph into a local
   in-memory DB, then repeat begin → validate unchanged corpus → rollback
   24 times, with 200 ms between iterations. No daemon, coordination, rename,
   mirror sync, candidate fingerprint, or growing operation history. Every
   validation passes and every sampled open-overlay count is zero.
3. **Final collection, diagnostic only.** Each process uses an inspector
   `HeapProfiler.collectGarbage` call after its entire natural sequence. This
   perturbs memory and is NOT an acceptance sample or proposed runtime fix.

All figures below are decimal MB, rounded; raw JSON retains exact bytes.

| Natural publication | Worker RSS | Daemon RSS |
| --- | ---: | ---: |
| 1 | 218.0 | 18.1 |
| 4 | 391.3 | 19.2 |
| 12 | 501.7 | 19.7 |
| 24 | 497.4 | 20.8 |
| 36 | 499.2 | 22.6 |
| 48 | 499.9 | 24.9 |

The first-12 diagnostic verdict also FAILS: combined baseline 410,566,656 B,
tail 521,437,184 B, limit 472,151,654.4 B. Extending to 48 is a diagnostic
about the curve, not a replacement window for that predicate. The worker
plateaus around 500 MB rather than continuing the early growth. Natural
major-GC observations repeatedly show live heap near 36 MB; observer callbacks
are asynchronous and are not exact stop-the-world retained-heap snapshots.

After the natural sequence, forced collection reduces worker RSS from
500,219,904 B to 143,048,704 B and heap used from 100,713,016 B to
36,562,568 B. The control independently reaches 516,866,048 B RSS at
iteration 24, then falls to 139,689,984 B RSS / 35,562,848 B heap used after
its final collection. Thus coordination and accumulating operations are not
necessary to reproduce the large RSS increase.

## Source-grounded interpretation

`packages/verify/src/validate.ts` constructs a fresh full TypeScript Program
for each validation, including compiler-host library loading, and returns
plain mapped diagnostics. Pure renames skip the structural materialization
reference-refresh Program; this workload does not build two full validation
Programs per mutation. Temporary compiler/AST/render/query allocations are
enough to reproduce the growth in the control; their precise JS-versus-native
allocation shares were not measured.

The worker's analysis memo is capped at 32 entries and cleared at every
attestation change (`analyze-memo.ts`, `sync.ts`). Successful commits delete
their JS transaction overlay (`store/src/transactions.ts`). Candidate
savepoints restore all mutable tables and compare fingerprints
(`kernel-bridge/src/candidate.ts`). These mechanisms and the observations
argue against an accumulating Program/mirror cache as the cause here; they
do not prove absence of every possible leak.

The daemon rises about 6.7 MB across 48 real operations. Its durable history
and previously recorded request-binding/change-set-lock retention are distinct
long-session concerns, not explained away by the worker result.

## Independent review and disposition

Read-only `gpt-6-astra`, reasoning `xhigh`, reviewed repository ownership paths
and independently inspected the natural-run logs. It agreed with the bounded
diagnosis and rejected forced GC, artificial warmup allocations, cache changes,
or a threshold increase solely to obtain a pass. The main agent checked the
pivotal Program/memo/overlay claims against source and ran the separate control.

Keep the current bound, its failures, and the opt-in default intact. A revised
gate separating startup allocation growth, stationary retention, and absolute
capacity would be a NEW measurement contract, requiring independent review and
explicit operator approval before replacing the registered gate. No thresholds
or warmup lengths are selected from these traces. C/E cannot claim a green
full-kernel prerequisite in the meantime; E fixture/schedule qualification is
not completed by this diagnosis.

## Reproduction and evidence

Subsequent decision: the operator approved the separately reviewed
[v2 design](../superpowers/specs/2026-09-05-memory-gate-v2-design.md).
Implementation and fresh qualification remain pending; the diagnosis and v1
failures above are unchanged.

The [evidence directory](2026-09-05-memory-diagnosis/) contains the exact
executed scripts and complete raw traces. The scripts intentionally retain
the original absolute checkout and temporary-directory paths as provenance;
change those mappings explicitly for another checkout. Prerequisites: built
workspace and default daemon, no overlapping Cargo builds or heavy tests.
Diagnostic artifacts are not a supported product command.

Commands executed, sequentially:

```sh
node /tmp/strata-memory-diagnosis.tz1u4Z/probe.cjs 48
node /tmp/strata-memory-diagnosis.tz1u4Z/validate-control.cjs
```

`natural.jsonl`: client/publication samples and original first-12 verdict.
`worker-natural.jsonl`: complete preload samples, GC events, final collection.
`validate-control.jsonl`: unchanged-corpus control samples. Instrumentation
affects timing and allocation; these are diagnostic traces, not new performance
or release-gate results. The optional per-iteration `--gc` probe mode was NOT run.
