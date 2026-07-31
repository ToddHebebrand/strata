# Review brief: roadmap item B — kernel discovery worldview + full behavioral gate (pre-spec design review)

You are performing an independent, adversarial, READ-ONLY design review BEFORE
a spec is written. Output is archived verbatim; pivotal claims will be
source-verified before acceptance. Severity-ranked findings
(Blocker/Major/Minor) with file:line evidence, explicit answers to the
numbered questions, then an overall verdict.

## What item B is

`docs/product-roadmap.md` item B: "closes the review's two sharpest risks:
coordination agents currently cannot discover node IDs (they were handed them
in Phase 6), and the daemon hard-codes a tsc-only gate weaker than the
product's tsc+vitest. Both are prerequisites for any arbitrary-task
scenario." Item B feeds items D (typed client) and E (scratch-to-release race
scenario). Governing spec:
`docs/superpowers/specs/2026-07-13-multi-agent-coordination-kernel-design.md`.

## Grounding facts (gathered in-session; re-verify what you rely on)

**Discovery today (kernel protocol, 11 request types,**
`crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs:108-142`,
`packages/live-compare/src/protocol.ts:112-147`**):** exactly two discovery
calls. `find_declarations` is global exact-name-only (`kernel.rs:521-573`),
max 64 matches, name required non-empty. `inspect_nodes` requires
caller-supplied IDs; returns bounded relationships (`parent`, `child`,
`outgoing:<kind>`, `incoming:<kind>`, capped) and BLANKS Module payloads
(`session.rs:898-948`). No module listing, no export listing, no search, no
reference query by ID without already holding the ID, no test read. Phase-6
harnesses paste pre-resolved stable IDs into the sealed prompt
(`packages/live-compare/src/tasks.ts:270-276,382-413`) with an appendix
forbidding exploration.

**Product agent worldview (20 `mcp__strata__*` tools,**
`packages/agent/src/tools.ts:556-577`**):** 7 query tools; 5 with no kernel
equivalent: `find_declarations_in_module`, `list_module_exports` (primary
bootstrap), `semantic_search` (embedding-based), `get_references`,
`read_test_file`.

**Behavioral gate today:** the daemon hard-codes
`NodeBridgeConfig::tsc_only` (`main.rs:120-126`); `serve` has no
validation-mode flag and rejects unknown flags. `ValidationProfile::Behavioral`
is declared + schema-validated (`bridge/protocol.rs:457-511`) but never
constructed — a dead variant. The worker branch exists and is tested only
from TS unit tests (`packages/kernel-bridge/src/candidate.ts:124-133`,
fixture trust checks at `:435-468`). The product's gate
(`commitWithBehavioralGate` → `runCorpusAcceptance`,
`packages/verify/src/corpusRun.ts:253-325`) materializes a real temp tree,
spawns real `tsc --noEmit` AND scoped `vitest run`, and fails unless both
pass. Kernel in-process tsc-only candidate validation ≈ 0.38-0.79 s on
medium; the behavioral gate adds process spawns (seconds). Fixture lists are
per-task (`taskBehavioralFixtures.ts:13-18`); an EMPTY fixture list makes
vitest trivially pass (`corpusRun.ts:206-209`) — the recorded gate-1
"tscAndVitestGreen" check reduces to tsc-only for T03 for exactly this
reason (`gate1.ts:199-211`).

**Context that constrains design:** the bridge-persistence slice just closed
(decisions.md 2026-07-25/07-31): candidates are served from a persistent
SQLite mirror under savepoint isolation with a full logical fingerprint;
rendered-tree temp dirs are an accepted out-of-SQLite side effect
(`candidate.ts:326-341`); the exit-gate record (kernel ≈ parity with SQLite)
was measured on the tsc-only profile — in BOTH arms (the SQLite arm's timed
window also used in-process tsc-only `validate+commit`, not the behavioral
gate), so profile parity across arms held. Module payload duality: Module
node payloads exist internally (gate-1's `renderSnapshotToTree` renders by
`module.payload` corpus-relative path, `gate1.ts:159-192`) but are blanked at
the `inspect_nodes` wire; the kernel-child comments claim "Module nodes carry
no path payload" — reconcile which is true at which layer.

## Candidate design under review (proposed, not committed)

**B-1 Discovery (bounded, read-only, deterministic protocol additions):**
1. `list_modules { afterModuleId?, limit<=64 }` → `{ modules: [{ moduleId,
   path, declarationCount }] }` — paginated, id-ordered; exposes the module
   path deliberately (path is render metadata, not filesystem access).
2. `list_module_exports { moduleId }` → bounded `{ exports: [{ nodeId, name,
   kind, exported }] }` (mirrors the product tool).
3. `find_declarations` gains optional `moduleId` scope filter (exact-name
   semantics unchanged; global default unchanged).
4. `get_references { nodeId, limit<=256 }` → incoming references with
   referencing nodeId + kind + moduleId (a first-class version of what
   `inspect_nodes` relationships partially expose).
5. Explicitly DEFERRED: `semantic_search` (embeddings — heavy, and the spec's
   non-goal "porting all twenty structural tools" covers it),
   `read_test_file` (filesystem read on the kernel path — boundary-sensitive;
   adjudicate whether a bounded read of registered test fixtures is needed
   for the arbitrary-task scenario or can wait for item E's spec).
Acceptance: a key-free discovery-bootstrap gate — the scripted coordination
flow resolves its target IDs through the NEW calls only (no IDs in the
prompt/manifest), then publishes; plus schema/bounds/determinism unit gates.
Tool wrappers land in `packages/live-compare/src/tools.ts` alongside the
existing ones.

**B-2 Behavioral gate:**
1. `serve` gains `--validation tsc-only|behavioral` (default tsc-only,
   byte-identical) + `--behavioral-fixture <rel>` (repeatable; validated
   non-empty when mode=behavioral so the gate can never silently reduce to
   tsc-only).
2. Rust constructs `ValidationProfile::Behavioral` (first real constructor)
   and threads it through `NodeBridgeConfig`; the existing worker branch +
   `commitWithBehavioralGate` run unchanged.
3. Candidate-isolation compatibility: the behavioral branch runs inside the
   Task-7 savepoint against the persistent mirror; temp trees remain the
   accepted side effect; the mirror fingerprint assertion is unchanged.
4. Acceptance gates (key-free): a compiles-but-behaviorally-wrong mutation
   (breaks a vitest fixture, passes tsc) is REJECTED on the kernel path and
   the identical mutation is rejected by the product gate (parity); the
   diagnostics surface to `advance_change_set`'s response; a
   behaviorally-clean mutation still publishes; cost measured and DISCLOSED
   (not gated — the exit-gate record was tsc-only-vs-tsc-only and stays
   immutable).

## Hard constraints (kernel design, unchanged)

Clients never open canonical storage; Node workers never mutate redb; TS
semantics stay in Node; validation never bypassed; typed operations infer
reservation scope (agents never enumerate lock keys); deterministic key-free
gates before any keyed spend; SQLite product path remains supported;
structural insert/delete/move concurrency waits for stable logical IDs
(item C — do NOT pull it in); Strata coordinates code activity, never
decomposes/assigns tasks. Bounded responses everywhere (the spec's
"bounded structural context" rule). The recorded gate-3 and exit-gate
artifacts are immutable.

## Do NOT re-propose

Porting all 20 product tools; embeddings/semantic search now; multi-language;
FUSE/git; N>1 worker pools; threshold changes to any recorded gate; item-C
stable-ID work; task orchestration.

## Questions to adjudicate

1. Is the 4-call discovery surface (list_modules, list_module_exports,
   scoped find_declarations, get_references) sufficient for an agent to
   bootstrap the T03-class coordination scenario with ZERO prompt-supplied
   IDs — and for item E's from-scratch scenario? What's missing or
   over-scoped? (Check what the product agent actually uses in recorded
   transcripts/tools if evidence exists.)
2. Module path exposure: is returning the corpus-relative module path over
   the wire consistent with "files are not first-class" and the blanked
   Module-payload precedent — or should discovery expose a non-path module
   identity? Reconcile the payload duality (internal payload vs blanked
   wire).
3. `read_test_file`: needed for B, deferrable to E, or a boundary violation?
   The behavioral gate makes tests part of the contract — can an agent
   reason about failures it cannot read?
4. Behavioral-gate cost: in-process tsc-only ≈0.4-0.8 s vs spawned
   tsc+vitest (seconds) per candidate. Should behavioral mode be per-daemon
   (my proposal), per-change-set, or per-corpus-manifest? Is a per-daemon
   flag honest for the multi-agent scenario (all agents pay it)?
5. Fixture governance: fixture lists live where (serve argv vs a committed
   corpus manifest), who validates them (the existing trust checks), and
   how does an EMPTY-list silent-pass get structurally prevented?
6. Does the behavioral gate interact safely with the persistent-mirror
   savepoint isolation (spawned vitest reads a temp tree while the worker's
   SQLite transaction is open — any deadlock/timeout risk given the 30 s
   bridge deadline at `main.rs:120-126`, which behavioral validation may
   exceed)? What deadline/config changes are needed and are they disclosed
   surface?
7. Gate structure: propose the deterministic key-free gate order for item B
   (unit → discovery-bootstrap → behavioral rejection/parity → chain), and
   whether the discovery-bootstrap gate should REPLACE or SIT BESIDE the
   sealed-prompt manifests (registration digest is frozen —
   `tasks.ts:10-11`; changing prompts breaks the approved digest; adjudicate
   the right relationship).
8. Sequencing: B-1 and B-2 as one slice or two? Which first, and can they
   land independently green?

## Output format

Findings (Blocker/Major/Minor, file:line), answers to the eight questions,
one-paragraph verdict: sound to write the spec from (with corrections), or
re-ground first.
