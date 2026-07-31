# Item B — kernel discovery worldview + full behavioral gate (design, post-review)

**Status:** chartered 2026-07-31 (see decisions.md entry). Independent design
review completed BEFORE this spec was written: brief at
`2026-07-31-item-b-review-brief.md`, Codex gpt-5.6-sol xhigh read-only output
archived at `2026-07-31-item-b-review-codex.md`. All pivotal review claims
source-verified in-session (diagnostics discard, generic-diagnostic
fabrication, duplicate-flag parser, empty-fixture permissiveness, whole-suite
satisfiability history, absolute Module payloads). The review's verdict
("re-ground first") is honored: its three contract corrections are
constitutive of this spec, not follow-ups. Implementation plans: not yet
written — this spec governs them.

## Why item B exists

Roadmap item B closes the kernel review's two sharpest risks: (1)
coordination agents cannot discover node IDs — the protocol's only discovery
is exact-name `find_declarations` (global, max 64, fails outright past the
cap) plus IDs-only `inspect_nodes`; Phase-6 harnesses pasted pre-resolved
stable IDs into sealed prompts. (2) The daemon hard-codes
`NodeBridgeConfig::tsc_only`; `ValidationProfile::Behavioral` is a dead
variant, so the kernel's commit gate is strictly weaker than the product's
tsc+vitest gate. Both are prerequisites for items D (typed client) and E
(scratch-to-release race scenario).

## Structure: TWO independently green slices, B-1 first

Adjudicated by the review (Q8): B-1 (discovery) is additive protocol/query
work and unblocks item D; B-2 (behavioral gate) carries the larger
correctness surface (failure taxonomy, subprocess lifetime, savepoint
recovery, fixture governance) and lands separately with the tsc-only default
byte-identical throughout.

## Slice B-1 — bounded discovery surface

New read-only protocol requests, all with the **collection contract**: every
collection response carries `graphGeneration`, deterministic ID ordering, an
explicit cursor + `hasMore` continuation (no more fail-past-the-cap), and
documented bounds. Clients restart pagination when the generation changes.

1. `list_modules { afterModuleId?, limit≤64 }` → `{ modules: [{ moduleId,
   path, declarationCount }], hasMore, graphGeneration }`. **Path projection
   contract (review Major, verified):** Module payloads may be physical
   ABSOLUTE paths; the endpoint derives a corpus-relative POSIX display path
   validated against the configured corpus root and FAILS CLOSED on escape
   or non-representable payloads — the raw payload is never exposed;
   `inspect_nodes`' Module-payload blanking is unchanged; `moduleId` remains
   the sole authority and mutation key. `declarationCount` counts the same
   supported top-level declaration-kind set the product's discovery uses.
2. `list_module_declarations { moduleId, afterNodeId?, limit≤64 }` →
   declarations including non-exported ones, `name` nullable — the product's
   actual `list_module_exports` semantics under an honest name (review
   Minor). Fields: `{ nodeId, name|null, kind, exported }`.
3. `find_declarations` gains optional `moduleId` scope; global exact-name
   semantics and default unchanged; the 64-match failure mode is replaced by
   the collection contract (cursor + hasMore).
4. `get_references { nodeId, afterReferenceKey?, limit≤256 }` → incoming
   references `{ fromNodeId, kind, moduleId }` — the pageable replacement
   for `inspect_nodes`' relationships-over-bound failure.

Client wrappers land beside the existing ones
(`packages/live-compare/src/client.ts`, `tools.ts`). Deferred, recorded:
`semantic_search` (embeddings; spec non-goal), general file reads.
Registered-fixture reading belongs to B-2 (it is bound to the validation
profile), per review Q3/Q8.

**B-1 gates (deterministic, key-free, in order):** (a) dual-language
schema/unit gates: bounds, pagination/cursor determinism, generation
stamping, path projection incl. absolute-payload and escape fail-closed
cases, scoped find, reference paging; (b) **zero-ID discovery-bootstrap
gate**: the scripted coordination flow resolves its T03-class target through
`list_modules → list_module_declarations`/scoped `find_declarations` →
`get_references` with NO IDs in prompt or manifest and no global name
lookup, then publishes; runs BESIDE the sealed Phase-6 manifests (their
registration digest stays frozen — prompts are not touched); (c) the full
existing key-free chain green.

## Slice B-2 — behavioral gate, honestly wired

1. **Typed candidate rejection (review Blocker 1, verified).** The bridge
   returns a typed `CandidateRejected { diagnostics: bounded[] }` distinct
   from operational failure (timeout/crash/invariant). Only `CandidateRejected`
   produces `ValidationFailed` with the worker's REAL bounded diagnostics
   (including a `modulePath` mapping added to the service diagnostic
   schema); operational failures surface as their own error taxonomy and are
   NEVER auto-replayed through the one-shot fallback when the failure is a
   known validation timeout. The current generic
   `candidate_validation_failed` fabrication is retired.
2. **Committed, digested validation manifest (review Blocker 2, verified
   against the recorded whole-suite satisfiability failure).** A per-corpus
   manifest file defines: mode (`tsc-only`|`behavioral`), normalized unique
   fixture entries + their content digests, strict tsc scope, and subprocess
   deadlines (`tscTimeoutMs`, `vitestTimeoutMs`). `serve` takes ONE
   `--validation-manifest <path>` option (the argv parser rejects repeated
   flags — verified). Rust validates the manifest before binding the
   service; behavioral mode is UNCONSTRUCTIBLE with zero fixtures (Rust
   construction invariant + startup check + the existing worker check).
   **Seed-green invariant:** the daemon runs the manifest's suite once
   against generation zero at startup and REFUSES to serve if the shared
   regression suite is red — the manifest is a shared seed-green regression
   gate; red-by-design task fixtures are a task-scoping concern that stays
   OUT of this slice (recorded house history). The manifest digest is
   recorded in startup/audit/`hello` metadata and in artifacts.
3. **Deadline nesting (review Major, verified).** Inner tsc/vitest timeouts
   (from the manifest) < a distinct behavioral-candidate bridge deadline
   (covers materialization + both subprocesses + rollback + fingerprint +
   cleanup) < client deadline + queue allowance. The fast analyze deadline
   stays separate. Subprocess cleanup kills the spawned process groups.
4. **Savepoint compatibility:** vitest reads a materialized temp tree, never
   the mirror; the Task-7 savepoint + full-fingerprint assertion is
   unchanged. Timeout-recovery gates prove: generation unchanged, savepoint
   rolled back, fingerprint equality, temp/process cleanup, healthy
   rehydration.
5. **Registered-fixture reader:** `list_validation_fixtures` and a bounded,
   chunked `read_validation_fixture { fixtureId, offset, length }` pinned to
   the manifest digest — the agent can read the tests that define its
   contract; NOT a general filesystem tool; source files stay
   non-first-class.
6. **Cost disclosure, not gating:** behavioral-mode runs disclose validation
   duration, persistent-worker queue wait (head-of-line under N=1),
   fallback/rehydration and timeout counts. The recorded exit-gate artifacts
   (tsc-only vs tsc-only, both arms) are immutable and not re-adjudicated.

**B-2 gates (deterministic, key-free, in order):** (a) unit gates: manifest
parsing/digesting, empty-fixture unconstructibility, deadline-nesting
arithmetic, typed-rejection taxonomy incl. diagnostics propagation with
modulePath; (b) startup seed-green gate (red manifest suite → daemon refuses
to serve; green → serves); (c) behavioral rejection/parity gate: a
compiles-but-behaviorally-wrong mutation is REJECTED on the kernel path with
the worker's real diagnostics AND rejected identically by the product gate;
a behaviorally-clean mutation publishes; (d) timeout/savepoint recovery
gates (point 4); (e) full key-free chain + fixture-reader schema gates.

## Hard boundaries (unchanged)

Clients never open canonical storage; workers never mutate redb; TS
semantics stay in Node; validation never bypassed; typed operations infer
reservation scope; bounded responses everywhere; deterministic key-free
gates before any keyed spend; SQLite product path fully supported; item-C
stable-ID work stays out; Strata never decomposes/assigns tasks; recorded
gate artifacts immutable; tsc-only remains the default and byte-identical.

## Process

Each slice gets its own implementation plan (v1 → independent methodology
review → v2) before any build, gate-3-style. B-1's plan first.
