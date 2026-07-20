# Independent review brief — slice A gate 3 (unkeyed noninferiority) plan

**Reviewer task:** adversarially review the implementation plan at
`docs/superpowers/plans/2026-07-20-iteration6-slice-a-gate3.md` before any code
is written. This is a **measurement-methodology** review as much as a code
review: the gate decides, on real numbers, whether the kernel is the
single-agent product core or merely a coordination proof (falsifier 5). A
harness that flatters the kernel — or unfairly penalizes it — corrupts a
decision that gates real spend. Your first duty is to find any way the
methodology could produce a misleading verdict. Report blockers (the plan would
measure the wrong thing, bias the comparison, or let a real fail be hidden),
majors (a real methodology or correctness defect), minors. Cite file:line for
every claim about existing code.

## Governing frame (read these)
1. `docs/superpowers/specs/2026-07-18-kernel-convergence-review-codex.md` §4
   item 3 (the gate-3 contract) and §5 falsifier 5 (line 130).
2. `docs/superpowers/specs/2026-07-18-iteration6-slice-a-convergence-design.md`
   gate map (lines 311-314).
3. `decisions.md` 2026-07-20 (gate-2 instrumentation this plan consumes) and
   2026-07-19 (gate-1 arms this plan reuses).
4. The gate-3 grounding recon is embedded in the plan's file references; verify
   the load-bearing ones (`gate1.ts` runSqliteArm ~203-285 and the `commit()`
   boundary ~228; `gate2.ts` request `wallNs`; `bridge/process.rs:51` 32 MiB
   bridge frame; `examples/medium` module count; `bench/src/metrics.ts`
   percentile helper; `redb_spike.rs:258` nearest-rank).

## What the plan decides (the review targets)
- **Corpus:** ~1000 modules by replicating real `examples/medium` ×40 into
  path-distinct copies, one designated `User`→`Account` rename target
  (operator-approved). Generated at harness time, not committed as 1000 files.
- **Fair mutation-wall comparand:** caller-side wall around kernel
  submit+advance(→published) vs SQLite `commit()`; kernel server-side sink
  `wallNs` reported additionally.
- **Warm/cold:** warm = repeated alternating renames
  (`User`→`Account`→`User`…) on a persistent daemon/db (fixed corpus size,
  unbounded N); cold = fresh process/seed per iteration, first mutation only.
- **Percentiles:** nearest-rank p50/p95/p99, raw samples retained.
- **Memory:** kernel daemon+worker RSS from the gate-2 sink; SQLite RSS from an
  isolated child process reporting its own `maxRSS`; judged by growth
  medium→big1k against an 8× budget.
- **Lifecycle parity:** structural 4-vs-4 assertion.
- **Gate structure:** medium in the automatable vitest gate; the slow 1k run is
  an operator-invoked script; gate recorded PASS only when both corpora pass.
- **A fail is a valid outcome** recorded as falsifier-5, never engineered around.

## Questions we specifically want pressure on
1. **Caller-side wall fairness.** The kernel pays a fresh Unix-socket connect
   per request (`client.ts` opens a new connection each call); SQLite `commit()`
   is a direct in-process call. Is charging the kernel that connect cost fair
   (a real product client would too), or does it bias the ratio? Should the
   comparand be server-side `wallNs`, caller-side, or both with the gate keyed
   to one? Which is the honest primary?
2. **Warm=alternating-rename.** Does alternating `User`↔`Account` create a fair
   steady state for both arms, or does it advantage one (e.g. kernel generation
   growth, SQLite overlay reuse, tsc incremental caching across iterations
   flattering warm numbers)? Is there a hidden per-iteration state drift that
   makes late samples incomparable to early ones?
3. **Memory asymmetry.** Kernel RSS = two processes (daemon + Node worker);
   SQLite RSS = one isolated child. Is comparing these fair for the "bounded not
   corpus-explosive" criterion, and is the 8× growth budget the right honest bar
   (given ~40× module growth)? Should the worker RSS (which hydrates the full
   snapshot) be the headline, and is peak-across-runs the right reduction?
4. **The ×40 replication corpus.** Does replicating medium ×40 faithfully
   exercise the cost falsifier 5 targets (full-snapshot serialization + tsc at
   scale), or does it have an artifact that biases the result — e.g. tsc
   dedup/caching across identical copies making validation artificially cheap,
   or 40 identical `User` declarations changing `find_declarations` cost
   asymmetrically between arms? Does the ~9.5 MB snapshot estimate hold, and
   does it stay safely under the 32 MiB bridge frame?
5. **Medium-only CI + operator big-run.** Is recording the gate PASS from a
   split (automated medium + operator-run 1k) acceptable, or does moving the
   decisive 1k measurement out of the automated suite risk the number never
   being honestly re-run? Is there a bias in which corpus is automated?
6. **Anything that lets a real fail read as a pass** — a percentile edge case,
   an N so small p95 is noise (warmN 25 medium / 12 big1k, coldN 8/4 — are these
   defensible for a p95 gate?), a measurement that silently excludes the
   dominant cost, or a threshold predicate that a corpus-explosive result could
   still satisfy.
7. **Falsifier-5 discipline.** Is the plan's handling of a fail (record + stop,
   never engineer around) correctly placed at every decision point, and is
   there any task where an implementer would be structurally tempted to weaken
   a threshold to get green?

## Output format
Numbered findings, each: severity (Blocker/Major/Minor), claim, evidence
(file:line), concrete plan amendment. End with a verdict: "plan ready" or "plan
needs amendment" and the minimal amendment set. Verify any pivotal empirical
claim about the code against the actual source before asserting it.
