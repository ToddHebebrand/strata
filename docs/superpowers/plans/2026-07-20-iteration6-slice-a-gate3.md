# Iteration 6 slice A — gate 3 (unkeyed noninferiority) Implementation Plan — v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**v2 (2026-07-20):** revised after the independent Codex review (gpt-5.6-sol,
xhigh, read-only; report at
`docs/superpowers/specs/2026-07-20-slice-a-gate3-review-codex.md`, brief at
`...-review-brief.md`). All 9 findings — 5 blockers, 3 majors, 1 minor — were
source-verified by the requesting session and incorporated. The load-bearing
corrections, each verified against code:
- **Timing is metrics-OFF for both arms** (B1): metrics-on adds an extra
  full-snapshot serialize + JSONL flush per bridge call (`provider.rs:40`,
  `executor.rs:108`, `session.rs`), so the dispositive caller-wall schedule runs
  with `--metrics` off; a separate metrics-on run characterizes server stages +
  RSS. Server wall never substitutes for caller wall.
- **Symmetric windows** (B2, verified `replay.test.ts:40` + `gate1.ts:222` +
  `candidate.ts:121`): the real product SQLite lifecycle calls `validate` then
  `commit` after the draft; the timed SQLite window is therefore
  `validate + commit`, the kernel window `submit + advance`. Lifecycle parity
  (4 vs 4) is derived from a runtime call trace, not a hand-list. The kernel
  candidate validates once, so the corrected runtime model has SQLite doing
  *more* tsc per mutation, not less.
- **Statistical rigor** (B3): balanced paired AB/BA seeded scheduling; N sized
  by a pilot; the gate passes only when a one-sided 95% bootstrap upper
  confidence bound on the paired p95 ratio is ≤1.25; a CI straddling 1.25 is
  **INCONCLUSIVE**, never PASS or falsifier-FAIL.
- **Corpus layout + count** (B4, verified `tasks.ts` scans `corpusRoot/src`,
  `examples/medium/src` = 22 modules): copies live under `outDir/src/copyNN/**`;
  ×46 = 1012 modules to honestly meet the design's "~1000" (the operator
  approved medium-replication ×~40; 46 is the arithmetic to hit the spec
  target). Full-scale typecheck + real serialized bridge-frame bound check
  preflight before any measurement.
- **Memory predicate redesign** (B5): RSS measured during the real cold + full
  warm schedules with per-iteration high-water marks; headline is combined
  daemon+active-worker; the 8× total ratio is replaced by a pre-registered
  absolute 1k capacity cap + baseline-adjusted component growth against a
  tiny-corpus control; the falsifier applies to kernel memory (an exploding
  SQLite control invalidates the comparison, it is not a kernel fail).
- **Symmetric process-cold** (Major 6): every cold sample runs in a fresh
  isolated child for BOTH arms; warm arms run in two persistent isolated
  processes, interleaved per the balanced schedule; first-half vs last-half p95
  + trend reported; a finite pre-registered warm horizon (no "unbounded" N).
- **Bound every metric to its sample** (Major 7): server-wall records are
  bracketed to each iteration by JSONL offset/sequence (exactly one new submit +
  one publishing advance); server-wall distributions retained;
  caller−server = total client/framing/scheduling overhead.
- **Provenance + machine-enforced tri-state** (Major 8): the operator big run
  exits 0/2/1 (PASS / measured-FAIL / infra-or-INCONCLUSIVE), writes the
  artifact first, and records HEAD + dirty state + harness/binary digests +
  corpus digest/count + OS/CPU + Node/Rust versions + schedule seed + N +
  metrics mode; a cheap CI test validates the committed artifact and its
  decision-source commit.

Pressure checks the review upheld (kept as v2 rationale): caller-side wall is
the honest primary (one-request-per-connection is the real client today,
`client.ts:95`); identical copies get no tsc incremental-program caching (fresh
`Program` each validate, `validate.ts:92`); the ×46 snapshot (~9.5 MB measured)
is safely under the 32 MiB bridge frame (`process.rs:51`); medium-in-CI +
operator-big is acceptable once provenance is bound.

**Goal:** Land gate 3 of the convergence slice: a key-free, statistically honest, cross-arm noninferiority measurement — kernel arm vs SQLite product arm — over `examples/medium` (22 modules) and a ~1012-module replicated corpus, producing a **tri-state** verdict (PASS / FAIL-falsifier-5 / INCONCLUSIVE) on whether the kernel keeps `p95 mutation wall ≤ 1.25× SQLite` (one-sided 95% UCB), with bounded (baseline-adjusted, capped) peak memory and exact 4-vs-4 lifecycle-call parity.

**Architecture:** A new `packages/live-compare/src/gate3/` module. All timing runs in **isolated child processes** (process-cold symmetry) with `--metrics` OFF: a per-arm child performs one mutation and reports its caller wall (`hrtime.bigint` around kernel `submit+advance` / SQLite `validate+commit`) plus its own `resourceUsage().maxRSS`. A **balanced paired scheduler** (seeded AB/BA) drives cold (fresh child per sample) and warm (two persistent per-arm children, interleaved, finite horizon) modes over each corpus, retaining raw per-sample data bound to pair-id/order/iteration. A **bootstrap** computes the one-sided 95% UCB of the paired p95 wall ratio → tri-state verdict. A **separate metrics-on characterization** run captures server-stage distributions and per-iteration daemon+worker RSS high-water. Memory is judged against a pre-registered absolute cap plus baseline-adjusted growth using a tiny control corpus. A provenance-bound, machine-enforced operator script produces the committed ~1k-corpus evidence; the vitest gate runs the full schedule on `examples/medium`.

**Tech Stack:** TypeScript (vitest, zod, `process.hrtime.bigint`, `process.resourceUsage`, `node:child_process`, seeded PRNG), the existing `@strata-code/{ingest,store,render,verify,kernel-bridge,live-compare}` packages, and the `strata-kernel-service` daemon.

**Design:** Gate 3 of `docs/superpowers/specs/2026-07-18-kernel-convergence-review-codex.md` §4 item 3, §5 falsifier 5 (line 130); gate map `docs/superpowers/specs/2026-07-18-iteration6-slice-a-convergence-design.md:311-314`. Consumes gate-2 instrumentation (decisions.md 2026-07-20) and the gate-1 arms (2026-07-19).

## Global Constraints

- **The gate is tri-state, and every state is honest.** PASS (UCB of p95 ratio ≤1.25 on a corpus), FAIL (lower confidence bound > 1.25 → falsifier-5: kernel is a coordination proof, not the product core), INCONCLUSIVE (CI straddles 1.25 → measure more, do not claim either). A threshold breach is recorded and STOPS the slice — **never** weaken a threshold, drop the 1k corpus, shrink N to hide variance, substitute server wall for caller wall, or "fix" the kernel by letting Node workers mutate canonical storage / moving TS semantics into Rust / bypassing validation. Anyone tempted to make a red gate green must escalate instead.
- **Timing is dispositive only with metrics OFF, both arms.** No `--metrics` on any timed run. Metrics-on runs are a separate characterization for server stages + RSS and never feed the wall verdict.
- **Symmetric timed windows.** Kernel wall = `submit_change_set` + `advance_change_set`(→published). SQLite wall = `validate(db,tx,root)` + `commit(db,tx,root)` (the product's explicit pre-commit validate + commit, per `replay.test.ts:40`). Draft steps excluded both sides (kernel begin_change_set/add_intent; SQLite begin/rename_symbol).
- **Process-cold symmetry.** Every cold sample and every warm arm runs in an isolated child process for BOTH arms — never an in-process SQLite mutation inside the already-warm harness/vitest process.
- **Balanced, seeded, paired schedule.** Arm order alternates AB/BA by a seeded PRNG; every sample retains `{pairId, order, iteration, arm, corpus, mode}`. No unpaired per-arm sweeps.
- **Confidence, not point estimates.** The verdict uses a one-sided 95% bootstrap UCB on the paired p95 wall ratio (kernel/SQLite). Nearest-rank p95 (`redb_spike.rs:258` semantics) is a descriptive stat; the gate is the UCB. N is sized by a non-dispositive pilot to keep the CI narrow enough to decide, and pre-registered before the dispositive run.
- **Distributions for every timed quantity.** Caller wall AND server wall (metrics-on run) each report n/min/p50/p95/p99/max/mean with raw samples retained in JSON. Server records are bound to their iteration by JSONL offset/sequence (exactly one new submit + one publishing advance per mutation) — never summed by action name across an accumulating file.
- **Same corpus-input domain both arms** via `buildCorpusInputs(corpusRoot)` (scans `corpusRoot/src/**`, corpus-relative POSIX paths — node IDs hash the path; absolute/relative must never mix). SQLite `ingestBatch(...)`; kernel `createQualifiedKernelSnapshot(...)` → daemon seed.
- **Lifecycle parity from a runtime trace.** Both scripted arms are wrapped so the actual mutation-lifecycle calls are recorded (kernel: begin_change_set, add_intent, submit_change_set, advance_change_set; SQLite: begin, rename_symbol, validate, commit); the parity assertion compares the traced counts (4 == 4), so a future call-structure change cannot silently disagree with a hand-list.
- **Real-code corpus.** ~1012 modules by replicating `examples/medium`'s 22 real modules ×46 into path-distinct copies under `outDir/src/copyNN/**`, one designated `User`→`Account` target in one copy. Generated deterministically at harness time (not committed as 1012 files). A tiny control corpus (1 copy, or empty-but-valid) is generated the same way for baseline RSS.
- **Memory predicate (pre-registered).** For each arm, `peakRss(big1k)` must satisfy BOTH: (a) an absolute cap `KERNEL_1K_RSS_CAP` / `SQLITE_1K_RSS_CAP` (set from the pilot, stated in the artifact); (b) baseline-adjusted growth `(peak(big1k) − peak(baseline)) / (peak(medium) − peak(baseline)) ≤ GROWTH_FACTOR` where `GROWTH_FACTOR` is pre-registered (candidate 4×; the reviewer adjudicates). Headline = combined daemon+active-worker for the kernel, child maxRSS for SQLite. The memory falsifier applies to KERNEL memory; if the SQLite control itself grows explosively the comparison is INCONCLUSIVE, not a kernel fail.
- **Provenance-bound artifacts.** Every committed artifact records: HEAD sha + dirty flag, harness bundle digest, `strata-kernel-service` binary sha, corpus digest + module count, OS/CPU, Node + Rust versions, schedule seed + realized order, N per (corpus,mode,arm), metrics mode, and the tri-state verdict with its measured UCB/LCB. A cheap CI test validates the committed artifact's schema and that its `head` matches the commit that records the gate.
- **Machine-enforced operator run.** The big-corpus script exits 0 (PASS), 2 (measured FAIL), or 1 (infrastructure error OR INCONCLUSIVE), writing the artifact before exiting.
- **Key-free:** no model calls, no API keys. Pure measurement.
- **No semantic-boundary change.** Measure the architecture as it is (full snapshot serialized to the worker per analysis/candidate call). Do not alter what crosses the bridge, what the worker validates, or where canonical state lives, to improve a number.
- **Commands:** `PATH=/opt/homebrew/bin:$PATH` prefix. The gate-2 build prelude (kernel-bridge build, live-compare build, daemon debug + `--features redb-spike-api`) is a prerequisite. Long runs foreground with generous timeouts.
- Commit after every task; push after every 2–3 tasks.

## Shared vocabulary

- **`Sample`**: one timed mutation — `{ arm:"kernel"|"sqlite", corpus:"medium"|"big1k"|"baseline", mode:"cold"|"warm", pairId:number, order:"AB"|"BA", iteration:number, callerWallNs:number, childMaxRssBytes:number, published:true }`.
- **`ServerSample`** (metrics-on run): `{ iteration, submitWallNs, advanceWallNs, daemonPeakRssBytes, workerPeakRssBytes, changeSetId }` — bound to iteration by JSONL offset.
- **`WallDistribution`**: `{ n, min, p50, p95, p99, max, mean, samples:number[] }` (nearest-rank).
- **`RatioVerdict`**: `{ p95Kernel, p95Sqlite, pointRatio, ucb95, lcb95, state:"PASS"|"FAIL"|"INCONCLUSIVE" }` — bootstrap paired UCB/LCB on the p95 ratio; PASS iff `ucb95 ≤ 1.25`, FAIL iff `lcb95 > 1.25`, else INCONCLUSIVE.
- **`MemoryVerdict`**: `{ arm, medium, big1k, baseline, absoluteCapPass, growthAdjusted, growthPass, state }`.
- **`Gate3CorpusReport`**: per corpus — `{ cold:RatioVerdict, warm:RatioVerdict, warmTrend:{firstHalfP95Ratio,lastHalfP95Ratio}, memory:{kernel:MemoryVerdict,sqlite:MemoryVerdict}, lifecycle:{kernel:number,sqlite:number}, server?:ServerCharacterization }`.
- **`Gate3Report`**: `{ provenance, medium:Gate3CorpusReport, big1k?:Gate3CorpusReport, verdict:"PASS"|"FAIL"|"INCONCLUSIVE" }` (overall = worst state across corpora present).

---

### Task 1: Corpus builders (×46 big, tiny control) under `src/copyNN`, with full-scale preflight

**Files:**
- Create: `packages/live-compare/src/gate3/corpus.ts`
- Test: `packages/live-compare/tests/gate3Corpus.unit.test.ts`

**Interfaces:**
- `buildReplicatedCorpus(sourceCorpusRoot: string, outDir: string, copies: number): ReplicatedCorpus` where `ReplicatedCorpus = { corpusRoot, moduleCount, copies, renameTarget:{ modulePath, declarationName:"User", newName:"Account" }, corpusDigest:string }`. Writes copies under `outDir/src/copyNN/**` (NN zero-padded), a root `tsconfig.json` cloning `examples/medium/tsconfig.json` options with `include:["src/**/*.ts"]`, and a `package.json`. `moduleCount = copies * <medium src module count>`. `renameTarget.modulePath` is the corpus-relative POSIX path of `User`'s module inside one fixed copy (e.g. `src/copy07/types/user.ts`). `corpusDigest` = sha256 over sorted `{relPath: sha256(text)}`.
- `MEDIUM_SRC_MODULE_COUNT` constant derived by scanning, not hard-coded.
- Defaults exposed: `BIG1K_COPIES = 46` (→ ~1012), `BASELINE_COPIES = 1`.

- [ ] **Step 1: Write the failing unit test**: build with `copies=2` into a tmpdir. Assert: layout is `<out>/src/copy00/**` and `src/copy01/**` (NOT `<out>/copy00/src`); `buildCorpusInputs(corpusRoot)` (from `tasks.ts`, which scans `corpusRoot/src`) returns exactly `2 * MEDIUM_SRC_MODULE_COUNT` inputs, all corpus-relative POSIX, none containing `..`; `renameTarget.modulePath` is among them and its text contains `interface User`; the root tsconfig has `include:["src/**/*.ts"]`. Determinism: two builds → identical `{relPath→sha}` (dir prefix aside) and identical `corpusDigest`.
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement `corpus.ts`.** Enumerate the source `src/**/*.ts` exactly as `buildCorpusInputs` does; write each into every `src/copyNN/`. Verify `examples/medium` compiles standalone first (it does — ESM modules, `moduleResolution: bundler`, so replicated `User` declarations are module-scoped and do not collide).
- [ ] **Step 4: Full-scale preflight (not just 2 copies).** Add a slower test (or a guarded step) that builds `copies=BIG1K_COPIES`, runs `validate()`/`tscNoEmit` (`@strata-code/verify`) over the whole 1012-module corpus and asserts zero diagnostics, AND serializes the kernel snapshot (`createQualifiedKernelSnapshot`) and asserts its byte length < 32 MiB (the bridge `max_request_bytes`, `process.rs:51`) with the measured size logged. **If the 1012-module corpus does not typecheck clean or the snapshot exceeds the frame, that is a Task-1 blocker — report it; do not paper over.**
- [ ] **Step 5: Baseline control.** `buildReplicatedCorpus(medium, out, BASELINE_COPIES)` (1 copy = 22 modules) is the RSS baseline; assert it builds and typechecks.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(live-compare): gate-3 replicated corpora (~1012 big + baseline) under src/copyNN, full-scale preflight"`

---

### Task 2: Isolated-child mutation workers, both arms, metrics-off timing + child RSS

**Files:**
- Create: `packages/live-compare/src/gate3/sqlite-child.ts`, `packages/live-compare/src/gate3/kernel-child.ts`
- Create: `packages/live-compare/src/gate3/child-protocol.ts` (request/result zod schemas)
- Modify: `packages/live-compare/src/gate1.ts` (export SQLite-arm helpers if private; export-only)
- Test: `packages/live-compare/tests/gate3Child.test.ts`

**Interfaces:**
- Each child is a compiled entrypoint driven over stdin/stdout with a JSON request `{ corpusRoot, target, mode:"cold"|"warm", iterations }` and streams one `ChildResult` line per completed mutation: `{ callerWallNs, childMaxRssBytes, published:true, lifecycle:string[] }`, then a terminal `{ done:true }`.
  - **sqlite-child**: ingests the corpus into `:memory:` once (cold: one mutation then exit; warm: `iterations` alternating renames on the persistent db), timing ONLY `validate(db,tx,root)` + `commit(db,tx,root)` per mutation via `hrtime.bigint`; records the lifecycle trace `["begin","rename_symbol","validate","commit"]` from actual wrapped calls; reports `resourceUsage().maxRSS*1024` after each mutation.
  - **kernel-child**: starts a `--metrics`-OFF daemon on the corpus (cold: fresh daemon+seed, one mutation, stop; warm: persistent daemon, `iterations` alternating renames), timing ONLY `submit_change_set` + `advanceUntilPublished` per mutation; lifecycle trace `["begin_change_set","add_intent","submit_change_set","advance_change_set"]`; `childMaxRssBytes` = the child harness process maxRSS (the daemon RSS is captured separately in the metrics-on run — Task 7).
- `RenameTarget` resolution: `find_declarations` by name returns all copies' `User`; filter to `target.modulePath`'s module so the correct copy is renamed. Warm alternation flips `User`↔`Account` each iteration.
- Consumes: Task 1 corpus; gate1 SQLite helpers; gate2 `startKernelService`/`CoordinationClient`.

- [ ] **Step 1: Write the failing test** on `examples/medium` (fast): spawn sqlite-child `mode:cold, iterations:1`, assert one `ChildResult` with `callerWallNs>0`, `childMaxRssBytes>1MB`, `lifecycle==["begin","rename_symbol","validate","commit"]`, `published`. Same for kernel-child with `lifecycle==["begin_change_set","add_intent","submit_change_set","advance_change_set"]`. Warm `iterations:3`: exactly 3 results, and the alternation is observable (post-run target name reflects 3 flips). Assert each mutation actually renamed (re-open/inspect, so a no-op can't score `callerWallNs`).
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** both children + protocol. Children must build to `dist/` (spawned as compiled JS — ensure included in the package build). Wrap the arm calls so the lifecycle trace is the real call sequence, not a literal.
- [ ] **Step 4: Run** → PASS; `pnpm --filter @strata-code/live-compare build`.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(live-compare): isolated-child metrics-off mutation workers (validate+commit vs submit+advance) with lifecycle trace"`

---

### Task 3: Balanced paired scheduler + nearest-rank + bootstrap UCB tri-state

**Files:**
- Create: `packages/live-compare/src/gate3/stats.ts` (nearest-rank, seeded PRNG, paired bootstrap), `packages/live-compare/src/gate3/schedule.ts` (balanced AB/BA driver)
- Test: `packages/live-compare/tests/gate3Stats.unit.test.ts`, `packages/live-compare/tests/gate3Schedule.test.ts`

**Interfaces:**
- `nearestRankDistribution(samples:number[]): WallDistribution` — p_k = ascending-sorted value at 1-indexed rank `ceil(k·n)` (matches `redb_spike.rs`); edge cases n=1/2 unit-tested.
- `seededRng(seed:number): () => number` — deterministic PRNG (e.g. mulberry32).
- `pairedP95RatioBootstrap(pairs:{kernel:number,sqlite:number}[], seed:number, resamples=10000): { pointRatio, ucb95, lcb95 }` — resample pairs with replacement, each resample compute `p95(kernel)/p95(sqlite)`, return the point ratio and the 95%/5% percentiles of the resampled ratio distribution (one-sided UCB = 95th pct, LCB = 5th pct).
- `ratioVerdict(pairs, seed): RatioVerdict` — PASS iff `ucb95 ≤ 1.25`, FAIL iff `lcb95 > 1.25`, else INCONCLUSIVE.
- `runBalancedSchedule(opts:{ corpus, mode, n, seed, runPair:(order)=>Promise<{kernel:Sample,sqlite:Sample}>}): Promise<{pairs, samples}>` — for i in 0..n, pick order AB/BA by the seeded rng, run both arms in that order (each a fresh isolated child for cold; the two persistent children interleaved for warm), tag `{pairId:i, order, iteration}`.
- Consumes: Task 2 children.

- [ ] **Step 1: Failing stats unit tests**: `nearestRankDistribution([1..10]).p95` = rank `ceil(9.5)=10` → 10; `[5]` → p95 5; bootstrap on synthetic pairs where kernel≈1.2×sqlite deterministically (fixed seed) yields `ucb95` in a asserted band and `state` per the thresholds (construct one PASS set, one FAIL set with kernel≈1.5×, one INCONCLUSIVE set straddling); bootstrap is deterministic for a fixed seed.
- [ ] **Step 2: Failing schedule test** on medium, `n=4`: `runBalancedSchedule` returns 4 pairs, orders include both AB and BA for a seed that produces a mix, every sample carries pairId/order/iteration, all `callerWallNs>0`.
- [ ] **Step 3: Run to verify failure** → FAIL.
- [ ] **Step 4: Implement** `stats.ts` + `schedule.ts`.
- [ ] **Step 5: Run** both → PASS.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(live-compare): balanced paired scheduler + bootstrap p95-ratio UCB tri-state verdict"`

---

### Task 4: Cold + warm run drivers with per-iteration RSS high-water and warm-trend

**Files:**
- Modify: `packages/live-compare/src/gate3/schedule.ts` (or a new `runners.ts`)
- Test: `packages/live-compare/tests/gate3Runners.test.ts`

**Interfaces:**
- `runCold(corpus, {n, seed}): Promise<{pairs, samples}>` — each sample a fresh isolated child per arm (process-cold both arms), balanced-paired.
- `runWarm(corpus, {n, seed, warmHorizon}): Promise<{pairs, samples, trend}>` — two persistent per-arm children (started once), N interleaved balanced-paired iterations up to the pre-registered `warmHorizon`; retains per-iteration `childMaxRssBytes` high-water; `trend = { firstHalfP95Ratio, lastHalfP95Ratio }` so drift between early/late samples is visible (nonexchangeability check).
- Consumes: Tasks 2–3.

- [ ] **Step 1: Failing test** on medium: `runCold(medium,{n:3,seed})` → 3 pairs, and assert the three kernel samples came from three DISTINCT child PIDs (fresh process each) while `runWarm(medium,{n:4,seed,warmHorizon:8})` reuses ONE kernel child PID and ONE sqlite child PID across its 4 iterations; `trend` present with both halves computed; warm per-iteration RSS is non-decreasing high-water.
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement.** Cold spawns per sample; warm spawns two long-lived children and streams iterations. Expose child PID in `ChildResult` for the distinctness assertion.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(live-compare): cold (fresh-child) + warm (persistent-child, trend) run drivers with per-iteration RSS"`

---

### Task 5: Metrics-on characterization + memory predicate (baseline-adjusted, capped)

**Files:**
- Modify: `packages/live-compare/src/gate3/` (a `characterize.ts` + memory predicate in `stats.ts`)
- Test: `packages/live-compare/tests/gate3Memory.test.ts`, `packages/live-compare/tests/gate3Characterize.test.ts`

**Interfaces:**
- `characterizeKernelServer(corpus, {n, seed}): Promise<{ submit:WallDistribution, advance:WallDistribution, daemonRss:number, workerRss:number }>` — a SEPARATE metrics-ON kernel run; parses the JSONL binding each iteration's submit + publishing-advance `request.wallNs` by file offset/sequence (exactly one new submit + one publishing advance per iteration — never sum-by-action across the accumulating file); daemon/worker RSS = per-iteration high-water max.
- `memoryVerdict(arm, { medium, big1k, baseline }, caps, growthFactor): MemoryVerdict` — `absoluteCapPass = big1k ≤ cap`; `growthAdjusted = (big1k−baseline)/(medium−baseline)`; `growthPass = growthAdjusted ≤ growthFactor`; `state = PASS` iff both, else FAIL; if the SQLite control's own `growthAdjusted` is itself explosive the KERNEL comparison is flagged INCONCLUSIVE (documented).
- Pre-registered constants (stated in the artifact, adjudicated by review; final values set from the Task 9 pilot): `KERNEL_1K_RSS_CAP`, `SQLITE_1K_RSS_CAP`, `GROWTH_FACTOR` (candidate 4).
- Consumes: gate-2 metrics sink parser; Tasks 2–4.

- [ ] **Step 1: Failing memory-predicate unit test** with fixtures: baseline 200 MB, medium 260 MB, big1k 380 MB → growthAdjusted `(380−200)/(260−200)=3.0` ≤ 4 → growthPass; big1k 900 MB → 11.7 > 4 → FAIL; absolute cap breach → FAIL regardless; an explosive SQLite control → INCONCLUSIVE flag.
- [ ] **Step 2: Failing characterize test** on medium: `characterizeKernelServer` returns submit/advance distributions (`n` samples each, p95 ordered) and daemon/worker RSS > 1 MB; assert each iteration's server records are bound to exactly one submit + one advance (no cross-iteration bleed) by constructing a 2-iteration run and checking the second iteration's submitWallNs is not the first's.
- [ ] **Step 3: Run to verify failure** → FAIL.
- [ ] **Step 4: Implement** characterization (offset-bound JSONL parsing) + memory predicate.
- [ ] **Step 5: Run** both → PASS.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(live-compare): metrics-on server characterization (iteration-bound) + baseline-adjusted capped memory predicate"`

---

### Task 6: Lifecycle-call parity from the runtime trace

**Files:**
- Modify: `packages/live-compare/src/gate3/` (parity in an existing file)
- Test: `packages/live-compare/tests/gate3Lifecycle.test.ts`

**Interfaces:**
- `lifecycleParity(kernelTrace:string[], sqliteTrace:string[]): { kernel:number, sqlite:number, equal:boolean }` — consumes the ACTUAL traces the Task-2 children recorded (not a hand-list), asserts kernel 4 == sqlite 4 and that the traces equal the expected canonical sequences; `equal` gates parity.
- Consumes: Task 2 `ChildResult.lifecycle`.

- [ ] **Step 1: Failing test**: given the real traces from a medium cold run of both children, `lifecycleParity` returns `{kernel:4, sqlite:4, equal:true}`; a synthetic 5-call kernel trace → `equal:false`; the canonical sequences are asserted exactly.
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** (compare traces; the counts come from the traces, so a call-structure change in Task 2 propagates here automatically).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(live-compare): lifecycle-call parity derived from runtime traces (4 vs 4)"`

---

### Task 7: Gate-3 report builder, provenance, tri-state, artifact writer

**Files:**
- Create: `packages/live-compare/src/gate3/report.ts`, `packages/live-compare/src/gate3/provenance.ts`
- Test: `packages/live-compare/tests/gate3Report.unit.test.ts`

**Interfaces:**
- `collectProvenance(): Provenance` — `{ headSha, dirty, harnessDigest, daemonBinarySha, os, cpu, nodeVersion, rustVersion, scheduleSeed?, timestamp? }` (timestamp injected by caller, not `Date.now()` inside pure code). `harnessDigest` = sha over the built `dist/gate3/**`. Reads versions via `process.version` and a cheap `rustc --version` / git rev-parse.
- `buildGate3CorpusReport(inputs): Gate3CorpusReport` — assembles cold/warm `RatioVerdict`s, warm trend, memory verdicts, lifecycle, optional server characterization.
- `buildGate3Report(provenance, { medium, big1k? }): Gate3Report` — overall verdict = worst of the corpus states present (FAIL ≺ INCONCLUSIVE ≺ PASS; a FAIL anywhere → overall FAIL; else any INCONCLUSIVE → INCONCLUSIVE; else PASS). Overall PASS requires BOTH corpora present and PASS.
- `writeGate3Artifacts(report, outDir, {deterministicName?}): {jsonPath, markdownPath}` — JSON retains all raw samples + provenance; Markdown: provenance header, one row per (corpus, mode) with n/p50/p95, the UCB/LCB and tri-state, memory block, lifecycle, and a verdict banner. `docs/spikes/gate3-noninferiority-profile.{json,md}` when deterministic.
- Consumes: Tasks 3–6.

- [ ] **Step 1: Failing unit test** with fixtures: a PASS corpus (ucb95 1.18), a FAIL corpus (lcb95 1.4), an INCONCLUSIVE corpus (ci straddles) → overall verdict resolves per the precedence; medium-only report → overall never PASS (big1k absent → INCONCLUSIVE at best); artifacts written; Markdown banner names the verdict + measured UCB literally; provenance fields present and non-empty (mock the collectors).
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** report builder, provenance collector, artifact writer.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(live-compare): gate-3 report builder, provenance binding, tri-state artifact writer"`

---

### Task 8: Pilot to size N; acceptance suite (medium); operator big script (machine-enforced); artifact CI check; scripts

**Files:**
- Create: `packages/live-compare/tests/gate3Noninferiority.test.ts` (medium, CI-bounded), `packages/live-compare/tests/gate3Artifact.ci.test.ts` (validates committed artifact)
- Create: `packages/live-compare/src/gate3/run-big.ts` (operator, tri-state exit)
- Modify: root `package.json` (`kernel:gate3:test`, `kernel:gate3:big`, extend `kernel:full-key-free:test` with the medium test + artifact check only)

**Interfaces:**
- **Pilot (Step 1):** a non-dispositive run on medium to size N/timeouts — record the observed per-sample wall spread and pick `N_medium`, `N_big1k`, and the pre-registered `warmHorizon`, `GROWTH_FACTOR`, RSS caps; write them as named constants + record the pilot numbers in the plan's decisions entry. The pilot is NOT the gate.
- **Acceptance test:** runs cold+warm on `examples/medium` with the pre-registered N and seed, builds a medium-only `Gate3Report`, and asserts: `medium.cold.state !== "FAIL"` AND `medium.warm.state !== "FAIL"` AND lifecycle 4/4. On medium, a PASS or INCONCLUSIVE both allow the suite to pass (medium is small; the decisive corpus is big1k, operator-run) — but a medium **FAIL** (kernel > 1.25× SQLite with confidence even on 22 modules) fails the suite as a genuine finding → STOP + report. Memory: assert both arms' RSS captured > 0 (bounded-growth verdict needs big1k, produced by the operator run). No retries, no tolerance widening.
- **`run-big.ts`:** builds the ×46 corpus + baseline, runs cold+warm+characterization+memory on medium AND big1k, writes `docs/spikes/gate3-noninferiority-profile.{json,md}` FIRST, then exits: 0 if overall PASS, 2 if overall FAIL, 1 if any corpus INCONCLUSIVE or an infra error. Prints the verdict + UCB/LCB.
- **Artifact CI test:** validates `docs/spikes/gate3-noninferiority-profile.json` against the zod schema and asserts its `provenance.headSha` equals the commit recording the gate (read from a small sibling marker or the decisions entry) — cheap, runs in the chain.
- Scripts: `kernel:gate3:test` mirrors `kernel:gate2:test`'s prelude ending `test gate3Noninferiority`; `kernel:gate3:big` runs the prelude then `node packages/live-compare/dist/gate3/run-big.js`; append `&& pnpm kernel:gate3:test` to `kernel:full-key-free:test` (big stays operator-only).

- [ ] **Step 1: Run the pilot** (foreground, medium + a small big1k probe): record spreads, set `N_medium`/`N_big1k`/`warmHorizon`/`GROWTH_FACTOR`/RSS caps as constants; note them for the decisions entry. Correct the runtime model (kernel 1 tsc via candidate; SQLite 2 tsc via validate+commit).
- [ ] **Step 2: Write the acceptance test + artifact CI test**; wire scripts.
- [ ] **Step 3: Build + run the acceptance test.** Gate-2 prelude, then `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test -- gate3Noninferiority`. Outcomes: PASS/INCONCLUSIVE on medium → proceed; medium **FAIL** → STOP, capture numbers, report BLOCKED for operator decision. Never weaken the test.
- [ ] **Step 4: Full verification.** `PATH=/opt/homebrew/bin:$PATH pnpm kernel:full-key-free:test` (now incl. gate3 medium + artifact check) + `pnpm -r test`, foreground ≥40-min timeouts → green (medium not-FAIL) OR recorded medium FAIL → BLOCKED.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "test(gate3): pilot-sized medium acceptance suite, machine-enforced operator big script, artifact CI check, scripts"`

---

### Task 9: Produce big-corpus evidence and record the gate (tri-state)

**Files:**
- Create: `docs/spikes/gate3-noninferiority-profile.{json,md}` (committed, provenance-bound)
- Modify: `decisions.md`, `docs/product-roadmap.md`, `docs/superpowers/specs/2026-07-18-iteration6-slice-a-convergence-design.md`

- [ ] **Step 1: Run the operator big measurement.** `PATH=/opt/homebrew/bin:$PATH pnpm kernel:gate3:big` foreground, generous timeout (≥90 min; 1012-module tsc runs repeatedly). Capture the exit code (0/2/1) and full verdict. This writes the committed artifact.
- [ ] **Step 2: Decide the gate from the machine verdict** (do not re-interpret by eye):
  - **exit 0 / overall PASS** (both corpora UCB ≤1.25, memory bounded, lifecycle 4/4): record **Gate 3 PASS** → gate 4 next.
  - **exit 2 / overall FAIL** (big1k LCB > 1.25 or memory explosive — the expected-risk case): record **Gate 3 FAIL / falsifier-5** with exact UCB/LCB, ratios, and RSS growth. Legitimate research outcome; do NOT attempt kernel changes to rescue it here — log and STOP; operator decides (narrow scope / bridge optimization within the semantic boundary as a new reviewed slice / accept provisional SQLite-authority split).
  - **exit 1 / INCONCLUSIVE**: record **Gate 3 INCONCLUSIVE** with the CI; recommend a larger pre-registered N re-run before any keyed spend. Do not claim PASS or FAIL.
- [ ] **Step 3: decisions.md entry** (top, dated): the gate-3 contract (review §4 item 3 quoted); the methodology (metrics-off caller wall primary + symmetric validate+commit vs submit+advance windows; balanced paired schedule; bootstrap 95% UCB tri-state; ×46 real-code corpus under src/copyNN; isolated-child process-cold both arms; baseline-adjusted capped memory; provenance binding); the independent review round (5 blockers + 3 majors + 1 minor, all source-verified — link brief + Codex output); the pilot-set constants (N, warmHorizon, caps, GROWTH_FACTOR); the measured UCB/LCB/ratios/RSS for both corpora; and the **tri-state verdict with its consequence**. No keyed spend used.
- [ ] **Step 4: Roadmap + design-doc lines.** Roadmap: a `Gate 3 <PASS|FAIL|INCONCLUSIVE>` line under Gate 2 with evidence path + the UCB. Design-doc gate-map Gate 3 bullet: append the outcome + plan link. Slice-A checkbox stays unchecked.
- [ ] **Step 5: Commit + push.** `git add -A && git commit -m "docs: gate 3 (unkeyed noninferiority) recorded — <PASS gate4 next | FAIL falsifier-5 slice paused | INCONCLUSIVE re-measure>" && git push`

## Addendum (2026-07-22, operator-approved deviation)

Task 8's acceptance run produced a **confident medium noninferiority FAIL**
(cold ratio 3.99 / lcb95 3.917; warm 4.78 / 4.78 — mechanism: fixed ~2 s
per-mutation bridge-worker spawn/IPC vs a ~0.3 s medium tsc; see decisions.md
2026-07-22). Per Task 8 Step 3 the build STOPPED and the operator decided:
**complete the big1k evidence run anyway.** Amendments in force:

- Task 8's acceptance suite pins the RECORDED medium verdict (FAIL states,
  lifecycle 4/4, RSS>0) instead of asserting not-FAIL; thresholds, windows,
  N, seeds, bootstrap unchanged. The chain includes it plus the artifact check.
- Task 9 proceeds knowing the overall machine verdict will be FAIL by
  precedence (medium FAIL is present); the big1k leg is evidence about
  amortization at ~1k modules, recorded in the same artifact. Task 9 Step 2's
  exit-2 branch (record FAIL / falsifier-5, log, STOP the slice) is the
  expected terminal outcome unless the machinery itself errors (exit 1).
- The three Task-7 review obligations (provenance fields for corpus digest +
  module count + metrics mode; mandatory raw pairs/N on the real artifact
  path; lifecycle parity dispositive in the machine verdict) are closed in
  Task 8's continuation before the first committed artifact.

## Self-review notes (v2)

- All 9 review findings mapped: B1→metrics-off timing (global constraint, Task 2) + separate characterization (Task 5); B2→symmetric validate+commit vs submit+advance windows (Task 2) + runtime-trace parity (Task 6); B3→balanced paired schedule + bootstrap UCB tri-state (Task 3); B4→`src/copyNN` layout + ×46 + full-scale preflight (Task 1); B5→baseline-adjusted capped memory + real-schedule high-water (Tasks 4,5); Major 6→isolated-child cold both arms + warm trend/horizon (Tasks 2,4); Major 7→iteration-bound server records + retained server distributions (Task 5); Major 8→provenance + machine-enforced tri-state exit + artifact CI check (Tasks 7,8); Minor 9→corrected runtime model + pilot (Task 8).
- The verdict is tri-state everywhere; a FAIL is the falsifier-5 outcome and is recorded, never engineered around (Global Constraints; Task 8 Step 3; Task 9 Step 2).
- Pre-registered constants (N, warmHorizon, GROWTH_FACTOR, RSS caps) are set by the Task-8 pilot and stated in the artifact before the dispositive run — not tuned to the result.
- Type consistency: `Sample`/`ServerSample`/`WallDistribution`/`RatioVerdict`/`MemoryVerdict`/`Gate3CorpusReport`/`Gate3Report` names used identically across tasks; nearest-rank + bootstrap semantics fixed once in Task 3.
