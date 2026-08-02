# Independent methodology review brief — B-2 implementation plan v1

**Reviewer contract:** read-only, repo-grounded. You are reviewing an
IMPLEMENTATION PLAN's methodology, not re-litigating the chartered design
(`docs/superpowers/specs/2026-07-31-item-b-design.md`, Slice B-2 — its own
independent review is archived beside it). Find defects in the PLAN: wrong
sequencing, tasks that cannot be independently green, missed compile/test
blast radius, contract details contradicting spec or code, test designs
that do not prove their claims, unsound levers.

**The plan under review:**
`docs/superpowers/plans/2026-08-01-item-b2-behavioral-gate-plan.md`

**Baseline:** main at d708662 — B-1 (bounded discovery surface) is merged;
the B-1 plan + its review archive (`2026-08-01-item-b1-plan-review-codex.md`)
document conventions this plan inherits (lockstep dual-language wire tasks,
golden-fixture sweeps, `project_module_path`, worktree/load test caveats in
decisions.md 2026-08-01).

## Context you should trust (verified in-session against source)

- The worker ALREADY types semantic failures:
  `packages/kernel-bridge/src/candidate.ts` throws `CandidateFailure` with
  stage `"validate"` + codes `typescriptFailed`/`behavioralFailed` (with
  normalized diagnostics) and stage-`mutate` errors map to
  `mutationFailed`; `errorPayload` puts stage/code/diagnostics on the
  `CandidateError` bridge response.
- The Rust side collapses them: `into_candidate_result`
  (`crates/strata-kernel/src/bridge/protocol.rs:1084-1095`) bails with a
  formatted string, discarding diagnostics;
  `parse_mirror_candidate_delta` → `MirrorCandidateResponse::Failed`
  (protocol.rs:1272-1341) keeps only stage/code/message.
- The session then fabricates ONE generic `candidate_validation_failed`
  diagnostic for EVERY candidate error
  (`…/strata_kernel_service/session.rs:795-827`), with a cancel follow-up;
  the `OptimisticRetryExhausted` arm above it (762-794) shows the
  established non-terminal-claim precedent.
- `NodeBridgeConfig` has ONE `deadline` (30s from main.rs) used for both
  analyze and candidate on both transports (`process.rs:33,201-203`,
  `router.rs:124-130,179,244,366`); executor.rs:150-157 falls back to
  one-shot on ANY mirror transport error.
- `corpusRun.ts` spawns tsc and vitest via `spawnSync` with NO timeout
  (tsc ~line 116-120, vitest ~225-230); `commitWithBehavioralGate`
  (verify/validate.ts:306+) delegates all validation to the spawned
  processes; the candidate pipeline is fully synchronous
  (better-sqlite3), so async subprocess supervision is a structural
  change, not a drop-in.
- `ValidationProfile` (bridge/protocol.rs:443-517): `Behavioral` variant
  exists, `validate()` never requires non-empty fixtures (only the worker
  checks, candidate.ts:437); `tsc_only()` is the only constructor.
- The argv parser rejects duplicate options (main.rs `parse_named`);
  readiness JSON is `Readiness { protocol_version, socket_path,
  service_epoch, recovered }` (server.rs:20-27) printed before the accept
  loop; seed/refusal would slot between `ServiceSession::open` and
  `bind_private_socket`.
- Client-wire `Ready {}` is field-less; both wire parsers are strict;
  golden fixtures are shared (B-1 conventions).
- `examples/medium` corpus: `greet` is single-site (registered manifest
  invariant: zero incoming references at generation zero);
  `strict_src_only_tsc_scope: true` limits the spawned tsc to `src/**`.

## Already decided — do NOT re-propose

- Slice charter, gate order (a)–(e), seed-green invariant, single
  `--validation-manifest` flag, fixture-reader-in-B-2, no red-by-design
  fixtures, cost disclosure not gating, tsc-only default byte-identical —
  all spec text.
- B-1 conventions: lockstep wire tasks, fixture sweeps, protocol v1
  lockstep, tasks.ts untouched.

## Questions for you (answer each explicitly)

1. **Semantic/operational partition.** The plan classifies
   {validate/typescriptFailed, validate/behavioralFailed,
   mutate/mutationFailed} as semantic (→ ValidationFailed) and EVERYTHING
   else — including unknown future validate-stage codes — as operational
   (fail-closed to `candidate_execution_failed`, retryable, claim
   intact). Sound? Check the worker's actual code inventory
   (candidate.ts) for codes the plan misclassifies. Is `mutationFailed`
   correctly semantic (it includes e.g. rename-target-not-found — should
   THAT cancel the change set as ValidationFailed)?
2. **Claim-intact operational failures.** Task 3 leaves the claim intact
   on operational failure, relying on lease-expiry re-offer (the
   OptimisticRetryExhausted precedent). Trace the actual lease/re-offer
   machinery (coordination/, scheduler): can a claim strand forever on a
   quiet daemon (no further ticks/advances), and is a client-driven
   `advance` able to re-drive it? Is `cancel_change_set` always available
   as the escape hatch? Verdict whether the plan needs an explicit
   re-offer/cancel contract.
3. **Deadline plumbing.** Task 5 adds `candidate_deadline` picked by
   request kind, defaulting to the legacy 30s without a manifest
   (byte-identical argument) and derived (tsc+vitest+30s overhead) with
   one. Check `process.rs`/`router.rs`/`persistent.rs` call paths: is
   per-kind selection implementable where the plan says, and does any
   path (hydrate/sync inside `request_at`) share the deadline in a way
   that breaks the nesting argument? Is the no-replay-on-validation-
   timeout classification (mirror error code vs transport deadline)
   cleanly distinguishable in executor.rs's fallback branch?
4. **Subprocess cleanup mechanism.** Task 5 uses `spawnSync(timeout,
   SIGKILL)` + vitest `--pool=threads` instead of process-group kill,
   arguing single-process children by construction. Is `--pool=threads`
   actually sufficient for vitest 3.x (check the repo's vitest version
   and whether threads pool still spawns tinypool WORKER THREADS not
   processes — and whether anything in the fixtures could spawn its own
   children)? Is tsc single-process? Verdict on the mechanism and on
   flagging it as a decisions divergence.
5. **Seed-green + timeout-gate levers.** Task 6 gates startup on a
   baseline run; Task 8's timeout lever is a fixture that sleeps only
   when the `greet` export DISAPPEARS (so seed-green is fast and the
   mutated candidate times out). Is the export-disappearance lever sound
   (module resolution: does the fixture's static `import * as mod` itself
   fail at vitest time when `greet` is renamed — making it a LOAD error,
   i.e. behavioralFailed-style red, BEFORE the sleep runs)? If the lever
   is broken, propose a deterministic alternative (this is open question
   5 in the plan's self-review).
6. **ValidateBaseline frame.** New internal bridge frame kind vs reusing
   the candidate frame with zero intents (open question 7). Check the
   candidate pipeline (candidate.ts): would a zero-intent candidate run
   materialize+validate cleanly and return an empty delta, or does it
   assert non-empty intents somewhere? Which design is less new surface?
7. **hello Ready fields.** Required+nullable (strict, fixture sweep) vs
   optional. B-1's `hasMore` precedent made the field required. Any
   consumer of `ready` outside the golden fixtures + tests that the plan
   misses (grep for `"ready"` consumers: gate harnesses, service.ts
   readiness parsing is the STDOUT line, not the wire hello — distinct)?
8. **Task granularity + green-state audit.** Walk the 10 tasks: is each
   independently green as sequenced (especially Task 5's two-language
   split with required bridge-wire fields — does adding required
   `tscTimeoutMs` to the profile break Task-1..4-era worker tests or
   recorded frames/fixtures in kernel-bridge tests?), and is Task 10's
   metrics surface right-sized or should disclosure split from
   chain/close?
9. **Missed blast radius.** What does the plan miss? Check specifically:
   (a) `bridge_protocol.rs`/`node_bridge*.rs` tests pinning
   `ValidationProfile` JSON shapes; (b) live-compare/service harness
   assertions on readiness JSON fields; (c) `candidate_validation_failed`
   assertions across the repo (the plan sweeps — verify the sweep is
   listed where needed); (d) persistent-bridge tests pinning
   `request_at` deadline behavior; (e) anything pinning
   `MirrorCandidateResponse`'s shape; (f) audit-schema consumers.
10. **Gate sufficiency.** Do Tasks 7+8 prove spec gates (c)+(d) as
    written (parity, real diagnostics, generation unchanged, savepoint
    rollback, fingerprint equality, cleanup, rehydration, no-replay), or
    is any claim asserted without a discriminating observation?

## Hard constraints on your output

- Verdict line first: PROCEED / PROCEED-WITH-CORRECTIONS / RE-GROUND.
- Ranked findings (Blocker / Major / Minor), exact file:line evidence from
  THIS repo (read it yourself, not from memory).
- Then the ten answers, numbered.
- No new scope (no new endpoints beyond the spec'd surface, no B-3).
- Read-only: modify nothing.
