# Independent methodology review brief — B-1 implementation plan v1

**Reviewer contract:** read-only, repo-grounded. You are reviewing an
IMPLEMENTATION PLAN's methodology, not re-litigating the design. The design
was already independently reviewed and chartered
(`docs/superpowers/specs/2026-07-31-item-b-design.md`, review archived at
`2026-07-31-item-b-review-codex.md`, chartering entry in `decisions.md`
2026-07-31). Your job: find defects in the PLAN — wrong sequencing, tasks
that cannot be independently green, missed compile/test blast radius,
contract details that contradict the governing spec or the actual code,
test designs that do not prove what they claim, and blind spots.

**The plan under review:**
`docs/superpowers/plans/2026-08-01-item-b1-discovery-plan.md`

## Context you should trust (verified in-session against source)

- The wire contract is dual-language and mutually strict: Rust
  `crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs`
  (`deny_unknown_fields` everywhere) and TS
  `packages/live-compare/src/protocol.ts` (`.strict()` everywhere), plus
  shared golden fixtures in
  `packages/live-compare/tests/fixtures/protocol-v1/` consumed by BOTH
  `crates/strata-kernel/tests/local_service.rs` (which compiles protocol.rs
  standalone via `#[path]`) and
  `packages/live-compare/tests/protocol.test.ts`.
- `Kernel::find_declarations` (kernel.rs ~521) currently `ensure!`-bails
  past `MAX_DECLARATION_MATCHES = 64`. No existing test pins that failure
  mode (checked by grep).
- `GraphGeneration` (graph.rs): `nodes` is `BTreeMap<String, NodeRecord>`
  (id-ordered iteration); `references_from: BTreeMap<String,
  ReferenceRecord>` (≤1 outgoing reference per node); `references_to:
  BTreeMap<String, BTreeSet<ReferenceRecord>>` where `ReferenceRecord`
  derives `Ord` with field order `from_node_id, to_node_id, kind`;
  `children_of` lists are sorted by child id.
- The Rust `local_service.rs` harness seeds Module payloads as physical
  ABSOLUTE paths (`localized_source_snapshot` joins the corpus root); the
  TS harness (`packages/live-compare/src/service.ts` +
  `tasks.ts::createQualifiedKernelSnapshot`) seeds corpus-relative POSIX
  payloads. Both projection branches are exercised by existing harnesses.
- Read-path errors surface as error code `request_failed` with a bounded
  anyhow message (session.rs `handle_request` ~225-242).
- `client.ts::isMutating` classifies actions by a NEGATIVE list of
  read-only action names; a new read action not added there would be sent
  WITH an idempotency key and rejected by the server's strict validation.
- The sealed Phase-6 manifest (`packages/live-compare/src/tasks.ts`)
  self-asserts `APPROVED_TASK_REGISTRATION_DIGEST` (`628bd6da…`) inside
  `createQualifiedTaskManifest`; the corpus is `examples/medium`
  (x-namespace-enriched-v1).
- The product semantics being mirrored: `packages/store/src/discovery.ts`
  (`list_module_exports` returns all supported top-level declarations
  incl. non-exported, `name: string | null`, persisted kinds
  `InterfaceDeclaration | TypeAliasDeclaration | ClassDeclaration |
  FunctionDeclaration | FirstStatement`; `isExportedPayload` is a
  comment/whitespace-skipping `export`-prefix text check with no word
  boundary).

## Already decided — do NOT re-propose

- Slice structure (B-1 before B-2), the four-action surface, deferral of
  `semantic_search`/file reads/fixture reader — chartered.
- Collection contract: `graphGeneration` + deterministic ID ordering +
  cursor + `hasMore`, bounds 64/64/256 — spec text.
- Path projection is derived, validated, fail-closed; raw payload never
  crosses the wire; `moduleId` stays the sole mutation key — spec text.
- `inspect_nodes` is untouched (its over-bound failure stays; ADR'd in the
  design review).
- Protocol version stays 1 (lockstep single-repo deployment; the
  `renamedSymbols` field-addition precedent).
- No keyed/live-model spend in this slice; deterministic key-free gates
  only.

## Questions for you (answer each explicitly)

1. **Task boundaries.** Task 1 bundles the entire dual-language wire
   contract (Rust + TS + golden fixtures) because the strict parsers and
   shared fixtures can only move in lockstep. Is that bundling correct, or
   is there a decomposition that keeps every intermediate state green
   without it? Conversely: are Tasks 2–4 (projection / kernel queries /
   session wiring) really independently green as sequenced — check the
   session.rs compile path across Task 1 Step 5, Task 3 Step 4, and Task 4
   Step 3 for a hidden broken intermediate state.
2. **Cursor + pagination semantics.** The plan pages by strictly-ascending
   string ID with `id <= after → skip`, `hasMore` = one-more-exists, cursor
   allowed to be a non-existent ID. Any determinism or correctness trap
   (e.g. `Ord` on `ReferenceRecord`, duplicate from-node keys,
   `children_of` ordering, cursor interaction with the module-scoped find
   path)? Is fixing `find_declarations`' page size at 64 with NO
   client-supplied limit (open question 1 in the plan's self-review) the
   right call, or should it carry `limit` like the other three?
3. **Required vs optional `limit`.** The three new requests make `limit`
   required (mirroring `read_events`). Defensible? (Open question 2.)
4. **Path projection contract.** Lexical-only projection against a
   startup-canonicalized corpus root; absolute payloads must
   `strip_prefix` the canonical root; `.`/`..`/backslash/empty → error;
   symlink-aliased absolute payloads fail closed by design; a single
   non-projectable module fails the WHOLE `list_modules` request (not
   skip-and-continue). Are these the right calls? Does the fail-whole-page
   choice create an availability trap (one bad module blackholes all
   discovery) that the spec's fail-closed language does not actually
   require? Check `packages/agent/src/moduleIndex.ts` for the product's
   normalization precedent before answering.
5. **Blast radius.** What does the plan miss? Specifically check: (a)
   protocol-context request-capacity interaction with the bootstrap gate's
   many paginated requests; (b) `MAX_RESPONSE_FRAME_BYTES` headroom for a
   64-module page of 512-byte paths (worst case ~40KB over the 256KB
   frame? compute it); (c) `minimum_action_budget_ms` for new read
   actions; (d) audit/metrics record paths for new action names; (e) any
   test that snapshots the tool list, allowed tools, or audit action
   vocabulary; (f) `packages/live-compare/src/liveAdapter.ts` /
   `agent.ts` conformance to the extended `CoordinationClientApi`.
6. **Bootstrap gate probative value.** Does Task 7 actually prove the
   spec's gate (b) claim (zero-ID resolution, no global name lookup,
   sealed manifests untouched)? Is the audit-count assertion
   (`find_declarations` appears exactly once, the scoped call) sound given
   the audit records action names without arguments? Is asserting
   `discoveredId === manifest.targets.User.stableId` AFTER publication
   circular in any way? Would you add the digest-equivalence run (open
   question 3) or is it scope creep?
7. **TDD structure.** Are the failing-test-first steps real (does each
   test actually fail for the stated reason at that point in the
   sequence)? Flag any step where the "failing" test would actually pass
   or fail for a different reason.
8. **Anything else** a methodology reviewer should flag: naming, doc
   comments, constants placement (page bounds in the kernel lib vs
   protocol), the `is_exported_payload` byte-for-byte mirroring decision,
   the `module_ancestor` depth bound, error-message hygiene (payload
   never leaked), gate-script wiring.

## Hard constraints on your output

- Verdict line first: PROCEED / PROCEED-WITH-CORRECTIONS / RE-GROUND.
- Findings as a ranked list (Blocker / Major / Minor), each with exact
  file:line evidence from THIS repo (not from memory).
- Then the eight answers, numbered.
- Do not propose new scope (new endpoints, new tools, B-2 work).
- Read-only: do not modify anything.
