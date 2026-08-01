# Independent methodology review — B-1 implementation plan v1 (Codex output, archived verbatim)

**Model:** gpt-5.6-sol, reasoning `xhigh`, sandbox read-only, repo-grounded.
**Brief:** `2026-08-01-item-b1-plan-review-brief.md`. **Date:** 2026-08-01.
**Plan reviewed:** `docs/superpowers/plans/2026-08-01-item-b1-discovery-plan.md` (v1).
**Tokens used:** 405,633.

**In-session source verification (2026-08-01), per repo rule:**

- Blocker 1 (Task 1 compile break on required `hasMore`) — CONFIRMED from
  `session.rs:823-837` (the `Declarations` constructor carries no
  `has_more`) plus the v1 task text. v2 fix: Task 1 emits a truthful
  `has_more: false` (the pre-B-1 kernel bails past 64, so a successful
  response never has a further page); Task 3 wires the real value.
- Major 2 (`Path::components()` normalizes `.`/`//`) — CONFIRMED, std
  documented behavior. v2 fix: raw string-segment validation before any
  `Path` construction.
- Major 4 (compiler sweep misses tests) — CONFIRMED:
  `packages/live-compare/tsconfig.json` includes only `src`; positional
  `findDeclarations(name, kind, deadline)` calls exist in
  `tests/gate1Intrusion.test.ts` (213, 273, 338-341, 399),
  `tests/persistenceMemory.test.ts:170`, `tests/persistentBridge.test.ts:100`,
  and in compiled sources `src/gate1.ts:351`, `src/gate2.ts:405`.
- Major 5 (self-referential frozen-manifest guard) — CONFIRMED by
  construction of `tasks.ts:499-502`. v2 fix: the bootstrap gate pins the
  approved digest LITERAL, and no commit stages `src/tasks.ts`.
- Minor 6 / Answer 6 — PARTIALLY OVERRIDDEN after verification. The
  review's "compare the reference sets exactly" is only satisfiable under
  subtree reference semantics: `packages/store/src/resolveReferences.ts:61-63`
  shows every reference's `toNodeId` is the declaration's NAME-IDENTIFIER
  child, never the statement node, so direct `references_to(declarationId)`
  is empty for every discovered declaration and the spec's own zero-ID gate
  (`list_modules → list_module_declarations → get_references → publish`)
  would be unsatisfiable under a literal per-node reading. v2 therefore
  defines `get_references` with the manifest's own semantics
  (`tasks.ts:387-390`): references whose target lies in the subtree rooted
  at `nodeId` and whose source lies outside it. The review did not catch
  this; it was found while verifying its suggestion.
- Answer 5 blast-radius claims (request-context forget on bind,
  frame-size headroom ≈37.5KB typical / ≈201KB worst-case vs 256KB bound,
  1ms read budget wildcard, `tools.test.ts` ten-tool snapshot at 65-85,
  `agent.ts`/`liveAdapter.ts` using the concrete client) — spot-checked
  CONFIRMED (`session.rs:179-196`, `tools.test.ts:65-85` read in-session).

Verdict and v1→v2 disposition: PROCEED-WITH-CORRECTIONS honored; all eight
findings addressed in v2; open questions resolved per answers 2/3/6 (fixed
64-page `find_declarations`, required `limit`, no digest-equivalence second
run).

---

PROCEED-WITH-CORRECTIONS

## Ranked findings

1. **Blocker — Task 1 cannot compile as written, and Task 3 would temporarily lie about pagination.** Task 1 makes `ResponseResult::Declarations.has_more` required (`docs/superpowers/plans/2026-08-01-item-b1-discovery-plan.md:229-236`), but its session step only updates the journal arm and destructuring (`...item-b1-discovery-plan.md:339-363`). The existing constructor has no such field (`crates/strata-kernel/src/bin/strata_kernel_service/session.rs:823-837`). Task 3 then explicitly discards the real third return value until Task 4 (`...item-b1-discovery-plan.md:962-970`). Correction: Task 1 must emit `has_more: false` for the unchanged kernel call; Task 3 must replace that placeholder with the real value.

2. **Major — The proposed path projector accepts inputs its tests and contract require it to reject.** Tests require rejection of `src/./x.ts` and empty components (`...item-b1-discovery-plan.md:637-648`), but the implementation checks only wholly empty/backslash input and then iterates `Path::components()` (`...item-b1-discovery-plan.md:692-716`), which normalizes embedded `.` and repeated separators. Validate the raw slash-separated segments before constructing/iterating a `Path`.

3. **Major — Several failing-first steps are not genuine.**
   - Task 1 adds types and validators before writing tests, then says those tests should fail before Steps 2–4 (`...item-b1-discovery-plan.md:229-365`, `:411-413`).
   - Task 2 puts tests in a new `paths.rs`, but does not explicitly declare `mod paths` before running them; without that declaration, the filtered test command can succeed with zero tests (`...item-b1-discovery-plan.md:582-605`, `:663-665`, `:729-742`).
   - Task 4 writes six tests but filters the red run to `list_modules`, excluding the declaration, scoped-find, reference, and idempotency tests (`...item-b1-discovery-plan.md:998-1036`).
   - Task 7 is sequenced after Tasks 1–6 but describes a pre-Task-4 failure that will never occur in that sequence (`...item-b1-discovery-plan.md:1352-1369`, `:1506-1510`).

4. **Major — Task 5’s “compiler-led” call-site sweep does not cover tests.** The package compiler includes only `src` (`packages/live-compare/tsconfig.json:5-10`), while old positional calls remain in tests, for example `packages/live-compare/tests/gate1Intrusion.test.ts:213`, `:273`, `:338-341`, `:399` and `packages/live-compare/tests/persistenceMemory.test.ts:170`. The plan nevertheless relies on the build plus only the filtered client tests (`...item-b1-discovery-plan.md:1151-1156`, `:1223-1235`). Add an explicit repository-wide call search and run the full live-compare suite in Task 5.

5. **Major — The frozen-manifest guard can pass after committed drift.** The test compares calculated registration data with a constant stored in the same file (`packages/live-compare/src/tasks.ts:7-11`, `:483-501`), so changing both can remain green. Task 5 can broadly stage that file (`...item-b1-discovery-plan.md:1237-1241`), and Task 7’s later working-tree `git diff` cannot detect an already committed change (`...item-b1-discovery-plan.md:1512-1515`). Pin the approved digest literal `628bd6…` in the gate or compare `tasks.ts` against the B-1 base revision.

6. **Minor — Task 7 overstates what its bootstrap assertions prove.** Audit records contain an action name but no arguments (`crates/strata-kernel/src/bin/strata_kernel_service/audit.rs:259-275`; `session.rs:1085-1094`), so one `find_declarations` audit event does not prove that call was scoped (`...item-b1-discovery-plan.md:1490-1495`). Also, page helpers overwrite/ignore generations (`:1397-1408`, `:1423-1438`, `:1448-1457`), and the manifest check proves only that returned references are a subset of expected references (`:1477-1481`). Treat the audit assertion as corroboration, enforce one generation across a walk, and compare the reference sets exactly.

7. **Minor — Product-parity edge cases for export detection are unpinned.** The product skips whitespace and both comment forms and intentionally performs a boundary-free `export` prefix check (`packages/store/src/discovery.ts:28-55`). The proposed kernel test exercises only an ordinary exported function and an ordinary non-exported variable (`...item-b1-discovery-plan.md:809-832`). Add parity cases for leading line/block comments, unterminated comments, and the intentional no-word-boundary behavior.

8. **Minor — Task 1’s commit scope omits a file it instructs the implementer to change.** Step 9 requires finding all hand-built declaration results (`...item-b1-discovery-plan.md:555-562`); one exists in `packages/live-compare/tests/tools.test.ts:24-27`. The Task 1 commit stages neither that file nor the whole test directory (`...item-b1-discovery-plan.md:573-577`).

## Eight numbered answers

1. **Task boundaries:** Bundling the Rust schema, TS schema, and shared fixtures is correct because the required `hasMore` addition changes a strict existing response. Tasks 2–4 can remain separate, but not with the current session sequencing. Task 1 must supply a temporary `has_more: false`; Task 3 must wire the real value; Task 4 should add only the three new handlers. Task 2 must declare `mod paths` before its red run.

2. **Cursor and pagination:** The cursor design is sound. Nodes and outgoing references are stored in ordered maps (`crates/strata-kernel/src/graph.rs:7-17`, `:31-47`, `:99-125`); incoming references use an ordered set (`:165-190`); `ReferenceRecord` ordering begins with `from_node_id` (`crates/strata-kernel/src/model.rs:16-22`); and children are ID-ordered (`crates/strata-kernel/src/graph.rs:192-200`). A non-existent cursor is a valid exclusive lower bound. Fixed-size 64 pagination for `find_declarations` is the correct governed contract—the spec deliberately gives it cursor/`hasMore` without adding a limit (`docs/superpowers/specs/2026-07-31-item-b-design.md:54-56`).

3. **Required `limit`:** Defensible and preferable. It mirrors `read_events`, whose wire request requires `limit` (`protocol.rs:131-134`) and validates it explicitly (`protocol.rs:565-568`). Client/tool defaults preserve ergonomics without introducing an ambiguous wire default.

4. **Path projection:** Canonical-root lexical projection, symlink-alias rejection, raw-payload non-disclosure, and whole-request failure are appropriate. The product precedent is more permissive—it strips known roots but otherwise returns the normalized payload (`packages/agent/src/moduleIndex.ts:38-49`)—while the governing B-1 contract explicitly strengthens this to fail closed (`...item-b-design.md:41-49`). Skipping a bad module would silently produce an incomplete zero-ID discovery surface. The daemon remains available because the plan verifies other requests still work (`...item-b1-discovery-plan.md:1023-1029`). The implementation defect in Finding 2 must be fixed.

5. **Blast radius:**
   - Request capacity is not a bootstrap problem: accepted sequential requests are removed from the context before execution (`session.rs:164-188`), despite the 1,024 capacity (`protocol.rs:421-492`).
   - With actual 16-hex-character node IDs (`packages/store/src/ids.ts:9-20`), a 64-item page with 512-byte plain paths serializes to about 37.5 KB; even 512 control bytes escaped by JSON is about 201 KB, below 256 KB (`protocol.rs:10-19`). The server also fails boundedly with `response_too_large` (`server.rs:154-164`). A maximum-page serialization test would usefully pin this assumption.
   - New reads already receive the one-millisecond minimum via the wildcard arm (`session.rs:1313-1320`).
   - Successful reads use `action.name()` for both audit and metrics (`session.rs:225-233`, `:266-287`, `:1078-1095`); Task 1 updates that vocabulary. Existing failed reads are neither audited nor metered (`:235-241`), which is pre-existing behavior.
   - `tools.test.ts` snapshots the exact tool list (`packages/live-compare/tests/tools.test.ts:65-85`). The agent test consumes the generated allowlist (`packages/live-compare/tests/agent.test.ts:108-120`). Task 6’s full-suite run is appropriate.
   - `agent.ts` and `liveAdapter.ts` use the concrete `CoordinationClient`, not object-literal implementations (`packages/live-compare/src/agent.ts:182-186`; `liveAdapter.ts:192-202`). They need no conformance shim. The object-literal fake client does need extension (`tools.test.ts:24-54`).

6. **Bootstrap gate:** It genuinely starts without supplied IDs and delays manifest construction until after publication (`...item-b1-discovery-plan.md:1395-1477`), so the post-publication stable-ID comparison is not circular. The single audit count cannot independently prove scope because arguments are absent; the composite proof must rely on Task 5’s exact serialization test and Task 4’s wrong-module negative control. Strengthen the frozen-digest, generation, and exact-reference assertions as described above. Do not add a second manifest-driven service run: digest equivalence tests mutation parity, not zero-ID discovery, and is unnecessary scope for this gate.

7. **TDD structure:** Task 3, Task 5, and Task 6 have plausible red phases once prerequisite compile states are repaired. Task 1’s red test is ordered after implementation; Task 2’s tests may be undiscovered; Task 4 runs only a subset of its new tests; Task 7 is an acceptance test rather than failing-first TDD. Reorder or relabel those steps and run every claimed red test before implementation.

8. **Anything else:** Kernel-library placement of collection bounds is correct because kernel methods enforce them; keeping the service-only path bound near the wire contract is also reasonable. Mirroring `is_exported_payload` is correct but needs parity tests. The 4,096-level ancestry cap is a sensible cycle/depth fail-safe, though malformed-parent/cycle cases should be covered. Error hygiene is good: the proposed handler adds only the module ID as context (`...item-b1-discovery-plan.md:1047-1051`). Gate-script wiring matches the repository’s existing build-prefix pattern (`package.json:14-21`) and is otherwise sound.
