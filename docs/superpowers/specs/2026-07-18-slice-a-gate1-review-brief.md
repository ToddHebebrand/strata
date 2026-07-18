# Review brief: Iteration 6 slice A design + gate-1 implementation plan

You are an independent reviewer. Read-only. Repo-grounded: verify claims
against the code and cite file:line. Deliverable: a blunt review of the two
documents below — wrong assumptions, missing work, sequencing hazards, and
anything that would make gate 1 pass while measuring the wrong thing.

## Documents under review

1. `docs/superpowers/specs/2026-07-18-iteration6-slice-a-convergence-design.md`
2. `docs/superpowers/plans/2026-07-18-iteration6-slice-a-gate1.md`

## Authority context (read first, do not re-litigate)

- The acceptance frame is fixed: the verified convergence review
  `docs/superpowers/specs/2026-07-18-kernel-convergence-review-codex.md` §4
  (five ordered gates) and §5 (six falsifiers). Slice definition is its
  "smallest honest first slice". Do not propose a different slice.
- Refuted/settled — do not re-propose: a solo fast-path bypass (refuted:
  storage.rs rejects empty reservation scope; N=1 is not stable); content-
  addressed identity; stateless full-history re-ingest recovery; SQLite as a
  second canonical mutation engine; task orchestration inside Strata.
- Operator constraints: deterministic key-free gates before any keyed spend;
  full coordination semantics always (no semantic skipping); SQLite product
  path stays supported; falsifiers kill "converge" rather than delay it.

## What to attack hardest

1. **Parity oracle validity.** The plan asserts node/reference byte-equality
   between the SQLite arm export (`packages/kernel-bridge/src/snapshot.ts`
   exportSnapshot) and the kernel's `export-snapshot` of `GraphSnapshot`.
   Verify the two shapes actually align byte-for-byte (field names, ordering,
   generation field, payload blanking, module nodes) or name every
   transformation the harness must apply. Check whether the kernel-arm rename
   (via kernel-bridge candidate worker) produces byte-identical payloads to
   the SQLite-arm `rename_symbol` — same code path or not?
2. **`find_declarations` on the kernel** (plan Task 2): the proposed scan uses
   `bridge::declaration_name` per candidate node. Check hidden costs
   (`graph.snapshot()` clones per call — see provider.rs
   declaration_name_identifier), correctness vs the SQLite
   `find_declarations` (store/src/queries.ts) including the JSDoc-identifier
   pitfall it guards against, and whether kind vocabulary mapping matches.
3. **`OperationRecord.intents` extension** (Task 1): digest/serialization
   blast radius — which persisted records, digests, or byte-exact replay
   tests hash serialized OperationRecord JSON and would legitimately change
   vs illegitimately be "updated to pass"? Is `#[serde(default)]` sufficient
   for old redb records?
4. **Behavioral profile in the daemon** (Task 4): is enabling tsc+vitest in
   candidate validation for the kernel arm actually equivalent to the SQLite
   arm's `commitWithBehavioralGate`? Same fixture semantics, same tsc scope
   (`strictSrcOnlyTscScope`), same vitest invocation? Any asymmetry poisons
   the parity claim.
5. **Crash-injection reachability** (Task 8): can `PublishFailpoint` actually
   be threaded from the daemon into the coordinated publication path
   (`publish_claimed_inner`) as the plan assumes, or only into the
   non-coordinated `publish` path? Check how
   `tests/support/full_key_free.rs` row 8 injects it. Also: are the plan's
   five ServiceFailpoint journal stages actually reachable during a
   `advance_change_set` mutation, and is "complete old XOR complete new
   export" the right oracle at every one of the nine points?
6. **Second-client intrusion determinism** (Task 9): the daemon serializes
   requests how? (one request per connection; is there real concurrency in
   the service loop, or does the "concurrent advance" case reduce to
   sequential handling?) Is the "one of the two serial outcomes" oracle
   sound given the scheduler's fairness rules?
7. **Scope integrity:** anything in the design/plan that silently weakens
   coordination semantics, opens a second canonical store, or pulls slice
   B/C/D work in beyond the two declared narrow advances (behavioral
   plumbing, minimal discovery).

## Output format

Numbered findings, each: severity (blocker / major / minor), the claim in the
plan, what the code actually shows (file:line), and the smallest fix. End
with: (a) the three most load-bearing empirical claims in your review that we
must verify before accepting it; (b) an overall verdict: proceed / proceed
with changes / stop.
