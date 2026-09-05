# Memory qualification v2 — startup, bounded growth, sampled capacity

Status: independently reviewed design, 2026-09-05; implementation pending.
Operator approved a separately
reviewed redesign after the [RSS diagnosis](../../spikes/2026-09-05-memory-diagnosis.md).
This document proposes the new contract; no v2 execution or PASS exists yet.

## Question and honest boundary

Can the persistent worker complete a fixed real-corpus session with bounded
post-startup RSS growth and bounded sampled service capacity? This is finite
qualification, not proof of leak freedom, statistical stationarity, unlimited
session support, or memory safety under ten actors or structural creation.

The N=12 v1 contract remains exactly what it was: combined tail high-water of
iterations 9–12 must be at most 1.15 times iterations 1–4. September's failures
remain failures, as do the original July results under their original artifact
and configuration. The diagnostic showed that unchanged-corpus validation can
reproduce the growth without accumulating operations; it did not falsify RSS
as a capacity measurement. It falsified treating this short cold-start ratio
alone as an identified live-object leak.

V2 is a deliberate, post-diagnosis change in the question. Its constants are
selected with knowledge of the diagnostic, then frozen BEFORE fresh v2 runs.
Do not describe it as a blinded design or retroactively pre-registered v1.

## One workload, three separately reported components

Use `examples/medium`, a fresh source-only qualified snapshot, one actor and
one daemon, the default-feature **debug** CI binary, `--persistent-bridge`,
no manifest (existing tsc-only profile), and
the production typed client. Alternate User→Account→User for **160 successful
publications**. Readiness AND typed `hello` must report `validationMode: tscOnly`
and `validationManifestDigest: null`; do not infer profile only from argv.
Start at canonical generation zero. Each publication must use the ordinary discovery, begin,
add-intent, submit, advance lifecycle and actually increment graph generation.
No direct canonical-storage edits, extra symbols, artificial allocations,
forced GC, inspector preload, heap flags, or worker recycling.

1. **Startup disclosure:** readiness, the pre-first-mutation sample, and
   publications 1–32. Keep all their memory samples. Startup is not free and
   remains subject to the capacity bound. Emit the original v1 verdict from
   publications 1–12 as a separately labeled compatibility observation.
2. **Worker bounded growth:** publications 33–160, divided into four fixed
   contiguous blocks of 32: 33–64, 65–96, 97–128, 129–160. Let `B` be maximum
   WORKER RSS among the two recorded samples per publication in block 1.
   Each subsequent block maximum must be `<= 1.15 * B`. All three comparisons
   must pass; no averaging, best-window selection, tail-only masking, GC-cycle
   alignment, adaptive warmup, or retry-until-pass.
3. **Sampled total capacity:** every observed daemon+worker RSS sum, including
   startup and warmup, must be `<= 1400 * 1024 * 1024` bytes. Reuse the existing
   A3 big1k budget as a conservative capacity envelope, explicitly NOT as an
   empirically justified tight medium-corpus budget. Report daemon and worker
   independently as well as combined. A daemon decrease cannot mask worker
   growth because its ratio is evaluated separately from the daemon.

**Why these constants:** 32 borrows the scale of the existing gate-3
`WARM_HORIZON`, which is a ceiling on measured warm-run length, NOT an existing
warmup duration. Using it for warmup is new policy: a fixed engineering
allowance, not a measured proof that V8 has warmed. Four
additional equally sized blocks extend beyond the 48-publication diagnostic
without making a CI-sized check a soak test. The 1.15 growth allowance is
retained, not enlarged. The 1400 MiB envelope is inherited, not fitted to the
observed 500 MB plateau. These choices intentionally change the baseline and
horizon, and are a new policy even though some constants are reused.

**Sensitivity limitation:** maxima and a 15% allowance can miss small sustained
growth or an early high baseline. For illustration, a synthetic baseline near
500 MiB growing 1 MiB per measured publication must fail by the final block;
growth of 0.25 MiB per publication can pass. Both examples belong in tests and
the report. Neither establishes a universal detection floor. The absolute cap
limits denominator inflation but is loose on medium. This gate is not a
retained-heap oracle. Longer-duration and ten-client retention work stays open.

Do not ratio-gate the daemon against its startup RSS: its durable operations,
request bindings, scheduler records, and known retention debts grow during real
work. Instead publish its entire sampled series, first/last block maxima,
bytes per completed publication as descriptive arithmetic, and enforce the
combined capacity limit. This does not excuse unbounded daemon retention.

## Sampling and validity

Use the existing OS RSS measurement, bytes normalized from `ps` KiB, with the
existing post-publication sample followed by a 200 ms quiescence sample. Add
one pre-first-mutation sample after readiness and persistent-worker discovery.
Label phases explicitly in the v2 artifact. Capture actual monotonic elapsed
times: a 200 ms requested wait is not a guarantee of exactly 200 ms spacing.

This bounds **sampled RSS**, not all-time peak or allocation volume. No claim
is made about unsampled in-validation/startup spikes; there is no continuous
sampler in v2. A peak-memory contract would require a different sampler.

The daemon PID is bound to the spawned child. The worker PID is discovered
as its unique direct persistent child and must remain unchanged. Check both
at every sample, retain the sticky continuity verdict, and verify immediately
before intentional shutdown (not after a successful stop).
No absent PID or failed `ps` read may become zero. A duplicate matching worker
is invalid. Any nonzero/failed `ps` invocation is invalid even when its partial
stdout includes plausible rows. The existing helper catches nonzero exit and
parses partial stdout, so v2 needs a strict sampling adapter; reusing it
unmodified would not meet this contract. Future stronger PID-incarnation
tracking can refine this bounded
OS observation; sampled continuity does not prove uninterrupted lifetime.

Require exactly 160 ordered publications and exactly 321 valid samples,
matching phase, iteration, generation, and PID identity. RSS values must be
positive finite safe integers; elapsed times nonnegative and monotonic; combined
must equal daemon plus worker. Reject malformed, extra, missing, reordered,
NaN, infinite, negative, fractional, or zero rows. An incomplete run cannot pass
using a shorter prefix. Each published advance must return the submitted
change-set ID, a distinct nonnull operation ID, and the exact expected canonical
generation 1 through 160. After the final registered RSS sample, verify User is
restored through discovery as post-measurement correctness verification. This
still counts against the overall deadline but creates no 322nd RSS sample and
cannot run inside the final quiescence interval.

Run tests/builds serially: the workspace harness and Rust feature matrix share
a daemon binary path. Build the default-feature debug binary first, reject a
release/env-selected override, and pin its hash before and after the run;
reject a changed executable or worker artifact. Record Node/V8, platform/arch,
OS release, lockfile, source revision + dirty status, corpus/snapshot digest,
worker bytes, daemon bytes, flags, sample policy, all constants, and timestamps.
Provenance must also hash the worker's runtime workspace build-output closure
(including ingest/store/render/verify), resolved runtime dependency identities
and native-addon bytes, and relevant compiler configuration, before and after
the run. An unchanged entrypoint does not imply unchanged imported code.
Record the actual launched Node executable/version, not merely the harness's.
Qualification requires a clean source revision; artifacts are written outside
the hashed input set. Remove model credentials and require empty `NODE_OPTIONS`
and no undeclared Node preload/heap/GC arguments.
Ambient machine load is disclosed, never used to discard an unfavorable
completed verdict after the fact.

One run per invocation, no internal repetition. Startup budget 30 seconds;
per-operation lifecycle ceiling 120 seconds over discovery → begin → add →
submit → ALL advances as ONE deadline, with every call inheriting its remaining
budget. Overall ceiling is 15 minutes, including startup and sampling; expiration
must interrupt active work/sampling, not wait for the next iteration boundary.
Cleanup has a separate 30-second budget outside the measurement window, after
which only owned processes may be forcibly terminated. Cleanup failure remains
nonzero even if measured predicates passed. A new attempt after failure/invalidity writes
a new artifact and records why; it never overwrites or selects a prior result.
No model calls or paid comparison is part of v2.

## Verdict and evidence ownership

`memoryQualificationVersion: 2` has separate `startup`, `workerGrowth`,
`sampledCapacity`, `validity`, and `legacyV1Observation` fields. Raw rows are
authoritative; the pure evaluator recomputes all derived fields.

- PASS: complete valid run, all worker block comparisons pass, all sampled
  combined values within capacity, all required publications verified.
- FAIL: any observed valid growth/capacity breach or workload correctness
  violation. Preserve the failing point and any safely captured remainder.
- INVALID: operational inability to obtain complete trustworthy evidence,
  including timeout, build drift, missing sample, ambiguous/dead/replaced PID,
  or collection failure. Nonzero exit, never a softer pass.

If invalidity follows a measured failure, retain BOTH facts and do not erase
the breach; overall nonzero. Exit codes: 0 PASS, 2 FAIL, 1 INVALID unless a
previously established FAIL takes precedence. Flush partial artifacts and stop
only owned processes in every terminal path. Model-visible protocol and
production daemon semantics do not change.

## Historical compatibility and CI adoption

Keep `persistentMemoryVerdict`, v1 constants, the old exit-gate assembly, and
July artifact evaluators unchanged. Do not reinterpret `--exit-gate persistence`
as v2 or use a v2 success to claim the previous performance exit gate passed.

Implement v2 in separate evaluator/runner/test files. Preserve v1 pure predicate
tests and exact historical failure fixtures. The existing live N=12 assertion
must remain runnable under an explicit legacy command that returns nonzero on
its original failure; do not invert it to expect a failure on every machine.

After independent implementation review and a frozen fresh v2 qualification,
explicitly replace only the current CI live-memory acceptance with v2. Retire
the v1 live check from automatic discovery using a clearly named legacy runner,
not a silently skipped test. `pnpm kernel:memory:test` and the workspace suite
must exercise the same v2 contract; the full chain consumes that one owner.
Archive the command-migration diff with the decision. Until adoption actually
lands and passes, the full-kernel gate remains red.

## Required implementation gates

1. Pure evaluator tests: exact boundary equality; capacity breach during startup;
   intermediate-block growth despite a recovered final block; growing synthetic
   series that must fail and slow-growth series that can pass; daemon-only cap
   breach; each invalid-data case; FAIL preserved before invalidity. Literal
   expected values, not the evaluator calling itself as its oracle.
2. Runner tests with controlled process/sampler seams: exact workload/sample
   counts, per-operation and total deadlines, failed publication, PID replacement,
   artifact flush/cleanup on error, binary drift, credential/Node-option hygiene.
3. One real scripted medium run through production semantics, frozen constants
   and digests. No forced collection. Retain failure if any; no tuning or
   automatic rerun. A v2 failure triggers diagnosis, not another gate redesign
   inside the implementation task.
4. Independent integrated review, then serial workspace build/tests and full
   key-free chain. No C/E prerequisite claim before the amended chain passes.

No big1k remeasurement, performance-gate reopening, production cache/GC change,
daemon-retention cleanup, or Item C implementation is included in this slice.

## Independent review record

Read-only `gpt-6-astra` at `xhigh` reviewed the proposed contract and current
sampling, test, and exit-gate paths before implementation. Disposition: support
the prospective bounded-RSS contract with the corrections now incorporated.
Main-agent source checks confirmed: `WARM_HORIZON` is a run-length ceiling,
not a prior warmup policy; the old RSS helper tolerates nonzero `ps` status;
the A3 exit assembly consumes v1 directly and must stay unchanged.

Review-driven requirements: fixed debug/default profile; one inherited lifecycle
deadline; interruptible overall deadline and separate cleanup bound; strict
sampling failures; runtime dependency-closure provenance; all intermediate
blocks gated; explicit small-leak and sampled-capacity limitations. No new
runtime result was used to choose or revise these rules. Design acceptance
does not imply that the future implementation or workload will pass.
