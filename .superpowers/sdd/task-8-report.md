# Task 8 — Second-client intrusion (stage-specific FIFO oracles): report

**Status: BLOCKED (new falsifier — the CONCURRENT-ADVANCE oracle this time).**

The corrected pre-submit oracle is sound and its three stages pass exactly as
the regenerated brief specifies. Five of the six cases (pre-submit ×3,
after_submit, disjoint ×4, ownership) are fully implemented with strong,
deterministic, no-either-order oracles and **pass**. The sixth case,
**concurrent advances**, is DETERMINISTICALLY falsified: the brief requires the
older ticket A (earlier durable submit) to win, but the kernel deterministically
lets the *younger* ticket B win and forces the older A into `validation_failed`.

Per the task's explicit instruction — "If observed daemon behavior contradicts
the CORRECTED brief oracle too, that is major signal — report BLOCKED with
observed vs expected; do not weaken assertions to pass." — I did not weaken the
concurrent assertion and did not commit. The implemented suite is left in the
working tree (uncommitted) with the concurrent case documenting the
contradiction in-line.

---

## What was implemented

- **`packages/live-compare/src/gate1.ts`** — one additive change: the Task-6
  `onStage` hook context now exposes `socketPath: string` (added to the ctx type
  and to all four call sites: after_discovery / after_begin / after_add_intent /
  after_submit). This lets an `onStage` callback construct a second
  `CoordinationClient` against the same daemon. No behavior change for existing
  callers (the crash suite passes `onStage: undefined`); purely additive.

- **`packages/live-compare/tests/gate1Intrusion.test.ts`** (new) — the intrusion
  suite. Serial (single describe, vitest default in-file serial). Each case
  ≤600 s. Deadlines: SUBMIT 120 s (≥30.1 s), ADVANCE 180 s (≥60.1 s). Key-free
  (`credentialFreeEnv`), no persisted SQLite (kernel arm never opens SQLite).

  Architecture: **disjoint** and **ownership** drive A through the real
  `runKernelArmT03` product helper and inject B via the `onStage` socketPath hook
  (B's intrusion completes while the service is alive). **pre-submit**,
  **after_submit**, and **concurrent** use bespoke two-client choreography
  (they need the daemon alive across A's advance and beyond — `runKernelArmT03`
  stops the service before returning). All three bespoke cases route A through
  the full kernel path (begin → add_intent → submit → advance), so there is no
  solo bypass of scope inference / analysis / validation / reservations / fenced
  publication.

## Case-by-case results

| Case | Oracle | Result |
|---|---|---|
| pre-submit @ after_discovery | A→published, renamedSymbols `[]`, B `User→Client`@genN, A `Client→Account`@genN+1 (same declId), tree green, name Account, digest==publicationDigest | **PASS** |
| pre-submit @ after_begin | same | **PASS** |
| pre-submit @ after_add_intent | same | **PASS** |
| after_submit overlap | B submit `queued`; A→published; B→needs_decision naming `User→Account` (`nodeId=declId`), B operationId null (no overwrite); tree green | **PASS** |
| disjoint @ all 4 stages | B renames `formatTimestamp`→`formatTimestampAudit` (different module than `User`, asserted via moduleId); both land; A published; tree green; final tree contains both renames, no bare `formatTimestamp` | **PASS** (4/4) |
| ownership | B `advance_change_set`/`cancel_change_set` on A's change-set id both throw `CoordinationClientError` code `request_failed`; A still publishes; A tree green | **PASS** |
| **concurrent advances** | **A must win (older submit), B→needs_decision** | **FAIL — oracle falsified (see below)** |

The disjoint target `formatTimestamp` (function, `src/lib/format.ts`) exists in
the current corpus and is in a different module than `User` (interface,
`src/types/user.ts`) — confirmed via `find_declarations` moduleId inequality in
the test. Ownership error code is `request_failed`, as the prior dispatch
predicted.

## The concurrent-advance falsifier (observed vs expected)

Choreography: A submits `User→Account` first (older), B submits `User→Client`
after (younger), then both advance via `Promise.allSettled`.

| Firing | A (older) | B (younger) |
|---|---|---|
| Brief's required outcome | `published` (wins) | `needs_decision` |
| **Observed, array `[A,B]`** (3/3) | **`validation_failed`** @gen 0 | **`published`** @gen 1 |
| **Observed, array `[B,A]`** (2-3/3) | **`validation_failed`** @gen 0 | **`published`** @gen 1 |
| Observed, A given a 1-advance head start (3/3) | `published` @gen 1 | `needs_decision` |
| Sequential control (advance A fully, then B) | `published` @gen 1 | `needs_decision` |

So the winner is determined by **claim-race order, not durable submit order**.
Under a truly simultaneous dead-heat the younger B wins; the older A loses via
`candidate_validation_failed`. Even a one-advance head start for A restores the
brief's FIFO outcome — proving the effect is a genuine concurrency race, not a
stable property of submit order.

### Root cause (kernel source, deterministic, not a harness artifact)

- The daemon spawns **one thread per connection**
  (`crates/strata-kernel/src/bin/strata_kernel_service/server.rs:49-56`,
  `thread::spawn(... handle_connection ...)`), so A's advance and B's advance run
  on separate threads concurrently.
- `claim_ready` uses optimistic concurrency with a scheduler-revision CAS and
  retries (`coordinator.rs:319-363`).
- The FIFO older-overlap protection
  (`scheduler.rs:291`, `older_overlap = self.tickets.range(..sequence).any(... state ∈ {Queued,Ready} && key overlap)`)
  only blocks a younger ticket **within a single `select_ready` call**. It reads
  ticket state that a racing thread has already mutated: once A's thread moves A
  out of Queued/Ready (or B's thread schedules B before A's does), the rule no
  longer holds across the two threads. The older loser's gen-0 candidate is then
  fenced out as `validation_failed` rather than being routed to the clean
  `needs_decision` the younger loser receives in the sequential/staggered paths.

### Why this is BLOCKED, not weakened

- Safety is preserved even when B wins: exactly one rename commits, no silent
  overwrite, final tree green with one rename. But the brief's specific,
  no-either-order claim — **"B submitted after A ⇒ A must win"** — is false.
- The kernel's outcome IS deterministic (B wins), so one *could* satisfy the
  "not either-order" spirit by asserting B wins — but that contradicts the
  letter of the corrected brief and would be unilaterally re-shaping a falsified
  oracle to pass. The prior dispatch established (and the operator ratified) the
  precedent: a falsified oracle is escalated for an owner decision, not
  re-shaped in place. The same precedent applies here. The task instruction
  pre-authorized exactly this: report BLOCKED with observed vs expected.

## Decision needed from the owner

Is the concurrent dead-heat behavior (younger-wins; older loser →
`validation_failed`) an **acceptable contract**, or a **kernel FIFO defect**?

- **Option A (oracle correction, mirrors the 2026-07-18 pre-submit fix):** the
  durable submit order does not govern the winner under simultaneous advance;
  the guarantee is only "exactly one wins safely, convergence holds." Then the
  concurrent oracle should assert the deterministic observed outcome (B wins, A
  loses cleanly) — but note the *rougher* loser state (`validation_failed` vs
  `needs_decision`) may itself warrant a fix so the older loser converges via a
  clean fresh decision instead of a validation failure.
- **Option B (kernel defect):** the older-overlap FIFO rule is meant to hold
  under concurrency; it does not because it reads cross-thread-mutated ticket
  state. Fix would serialize claim scheduling (or make the older-overlap check
  atomic w.r.t. the scheduler revision) so the older ticket wins deterministically.

Because this is a decision-grade concurrency finding (high blast radius), I
recommend an independent expert review of the mechanism (Codex xhigh, read-only,
repo-grounded) before choosing A vs B — the reproduction and source references
above are the self-contained brief for it.

## TDD evidence

**RED** (hook wiring). With the `gate1.ts` socketPath change stashed, the
disjoint case fails at second-client construction because `ctx.socketPath` is
undefined:

```
$ pnpm exec vitest run gate1Intrusion -t "disjoint intrusion at after_discovery"
FAIL tests/gate1Intrusion.test.ts > ... disjoint intrusion at after_discovery
ZodError: [ { "expected": "string", "code": "invalid_type",
  "path": [ "socketPath" ], "message": "Invalid input: expected string, received undefined" } ]
 ❯ new CoordinationClient src/client.ts:179:51
 ❯ Object.onStage tests/gate1Intrusion.test.ts:308:23
 ❯ runKernelArmT03 src/gate1.ts:335:20
```

**GREEN** (after restoring the `gate1.ts` hook wiring), full new suite:

```
$ pnpm exec vitest run gate1Intrusion
 ✓ pre-submit overlap at after_discovery ...            6465ms
 ✓ pre-submit overlap at after_begin ...                6218ms
 ✓ pre-submit overlap at after_add_intent ...           6807ms
 ✓ after_submit overlap: A commits first; B needs_decision ...  4831ms
 ✓ disjoint intrusion at after_discovery ...            6177ms
 ✓ disjoint intrusion at after_begin ...                8002ms
 ✓ disjoint intrusion at after_add_intent ...           6312ms
 ✓ disjoint intrusion at after_submit ...               6874ms
 × concurrent advances: durable-queue order forces A to win ... 11015ms
     → expected 'validation_failed' to be 'published'
 ✓ ownership: B's advance/cancel on A's change set is rejected ...  4217ms
 Tests  1 failed | 9 passed (10)
```

The single failure is the falsified concurrent oracle, not a harness defect.

## Two bugs found and fixed in the harness while implementing (both mine)

1. **Double-stop hang.** `service.stop` awaits `child.once("exit")`
   unconditionally; a second call after the child already exited hangs forever.
   Fixed with a single-shot `makeStop` guard in the bespoke cases (mirrors
   `runKernelArmT03`'s internal guard).
2. **Fixed-count advance polling.** A fixed 8-shot advance loop exhausts before a
   queued ticket becomes claimable under concurrency. Changed
   `advanceUntilTerminal` to poll on a 120 s wall-clock budget with a 250 ms
   sleep between non-terminal advances.

## Files changed

- `packages/live-compare/src/gate1.ts` — additive: `socketPath` on the `onStage`
  ctx (type + 4 call sites).
- `packages/live-compare/tests/gate1Intrusion.test.ts` — new intrusion suite.

Not committed (BLOCKED). No Rust changes. `decisions.md` / plan / spec edits in
the working tree are the operator's pre-existing 2026-07-18 design-correction
changes, untouched by me.

## Self-review

- **Completeness:** all six brief cases present; disjoint exercised at every
  stage (4). No case silently skipped — the concurrent case is present and
  documents its falsification in-line.
- **Assertion strength:** no either-order acceptances. FIFO winners asserted
  explicitly; `read_operation` generations/renames/intent declId checked;
  digest==publicationDigest cross-check on every exporting case; cross-module
  moduleId inequality for disjoint; explicit `request_failed` code for ownership.
- **Hygiene:** serial, deterministic (each oracle reproduced across repeats),
  pristine output, per-test cleanup + afterAll sweep, no persisted SQLite, no
  keys.
- **Scope:** only the single additive `gate1.ts` change the brief allowed; no
  restructuring of `runKernelArmT03` or its return contract.

## Reproduction of the falsifier

Scratch scripts (not committed) under this session's scratchpad:
`concurrent-diag.mjs` (4× concurrent + sequential control) and
`concurrent-diag2.mjs` (array-order and head-start variants). Run against
`packages/live-compare/dist` after
`pnpm --filter @strata-code/live-compare build`.

## Fix round (review findings)

Three review findings fixed in `packages/live-compare/tests/gate1Intrusion.test.ts`
following the kernel FIFO fix in 502a43e (planner age-only reconsideration
idempotence + daemon `OptimisticRetryExhausted` taxonomy; decisions.md
2026-07-19), which resolved the concurrent-advance starvation defect
documented below in "Reproduction of the falsifier."

1. **Stale comment (important), concurrent-advance case:** replaced the
   `*** FALSIFIED (2026-07-19) ... status BLOCKED ***` block with a short,
   accurate comment: the required winner derives from durable submit order
   (older A wins, younger B gets `needs_decision`); this exact case used to
   expose a poll-driven starvation defect — blocked-ticket age bumps churned
   the scheduler revision until the older claim's optimistic publication
   retries exhausted, mislabeled as `candidate_validation_failed` — fixed in
   502a43e. No assertions changed.
2. **Duplicate module read (minor), `exportRenderVerify`:** dropped the second
   `readModuleMap(rendered)` call and the unused `modules` field from the
   return type; `criteria` still computed from a single `readModuleMap` call.
3. **Tautological flag (minor), disjoint-intrusion case:** replaced
   `intruderPublished = committed.submitState !== undefined` (always true —
   `submitState` is always populated) and its `expect(intruderPublished).toBe(true)`
   with real postcondition checks on `commitIntruder`'s result:
   `intruderOperationId` (non-empty string) and `intruderGeneration` (string
   type) captured from `committed.operationId` / `committed.generation`,
   asserted directly.

Verification:

```
PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/kernel-bridge build
PATH=/opt/homebrew/bin:$PATH cargo build -p strata-kernel --bin strata-kernel-service
PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare build
cd packages/live-compare && PATH=/opt/homebrew/bin:$PATH pnpm exec vitest run gate1Intrusion
```

Result: `Test Files  1 passed (1)` / `Tests  10 passed (10)`, 60.65s, including
the concurrent-advances case (durable-queue order forces A to win, B yields
`needs_decision`) — no longer falsified.

Committed as `be5ffeb`, scoped to the single test file:
`test(gate1): correct stale concurrent-case comment post-502a43e; drop
duplicate module read and tautological flag`.
