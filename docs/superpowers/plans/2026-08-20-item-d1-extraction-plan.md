# Item D-1 — Extraction and wire parity: implementation plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** v2, post-review — READY TO EXECUTE. The v1 methodology review
returned **PROCEED-WITH-CORRECTIONS** (archived:
`docs/superpowers/specs/2026-08-20-item-d1-plan-review-codex.md`); every
correction is folded in below, and two of its factual corrections were
re-verified against source before acceptance:

- **v1 overstated the Rust fixture coupling.** There are exactly THREE joins in
  ONE file (`crates/strata-kernel/tests/local_service.rs:48`, `:79`, `:86`), not
  "six Rust test files". `bridge_protocol.rs:42` points at the unrelated
  kernel-bridge fixtures and must not be touched. Verified: one file, three
  occurrences.
- **v1 materially undercounted consumers.** It listed four; there are 14 source
  files and 10 test files. Verified by enumeration; the full list is now in
  Task 4.

Adjudicated open questions (all five answered, adopted as written):
1. The `protocol-v1` fixtures AND `protocol.test.ts` move WITH the package —
   they define the extracted package's wire contract, and leaving them behind
   preserves the wrong ownership boundary. The three Rust joins get updated.
2. Moving `client.test.ts` does not affect the Rust lockstep (it imports
   protocol helpers but reads no fixture files).
3. **No compatibility barrel re-export.** `live-compare` is a private leaf with
   no external consumer; take the import break now rather than carry a shim
   into D-2.
4. Task 2 stays in D-1. The three partitions agree TODAY, so the shared fixture
   is cheap now and prevents drift during D-2, when the handshake changes how
   actions are classified.
5. No additional live bug. The `CoordinationClientApi` mismatch is type-contract
   debt, but a plain assignment or `satisfies` assertion is NOT sufficient —
   method bivariance accepts the drifted shape. Use `Pick<CoordinationClient,
   ...>` or exact per-method type-equality assertions.

Governing spec:
`docs/superpowers/specs/2026-08-20-item-d-design.md` § Slice D-1. Charter:
decisions.md 2026-08-20. Baseline: `main` ≥ d1ab87b.

**Goal:** the typed client becomes a thing someone could embed — its own
workspace package, depending on `node:crypto`, `node:net`, and `zod` and nothing
else — **with no behavior change**, and with the one verified cross-language
defect fixed before extraction freezes the contract.

**Why this slice is first (review-adjudicated):** the provisional plan had
extraction landing together with the wire change. Doing extraction alone, with
v1 one-shot behavior still green, means the package boundary is proven by the
existing suites before protocol v2 starts moving bytes underneath it. A defect
found after extraction has to be fixed in two places.

## Global constraints

- **No behavior change.** Every existing suite passes unchanged, including the
  full key-free chain. The one intentional behavior delta is the intent bound
  (Task 1), which only ever *widens* what the client accepts.
- **v1 one-shot transport stays green.** D-1 does not touch framing, the server,
  connection lifetime, or identity. `client.ts`'s `requestOnce` is moved, not
  rewritten.
- **The MCP tool server does NOT enter the client package.** `tools.ts` couples
  to `@anthropic-ai/claude-agent-sdk@0.2.118`; it stays in `live-compare` for
  this slice. "Thin embeddable client" must stay literally true.
- **`service.ts` is NOT moved.** It carries CJS `__dirname` and hardcoded
  `target/debug` repo-relative paths and is rewritten in D-3.
- **`packages/live-compare/src/tasks.ts` is never staged** (registration digest
  `628bd6da…` stays frozen), and no registered prompt changes.
- The new package stays `private: true` for now. Publication is not D-1's
  business; `packages/cli/package.json` is the template when it becomes so.

---

### Task 1: Fix the intent-bound mismatch, in place

Do this BEFORE any file moves, so it lands as an isolated, reviewable fix
against the current layout.

**The defect (verified):** `packages/live-compare/src/protocol.ts:16` caps
`MAX_OPERATION_INTENTS` at 16. Rust allows 256
(`crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs:31`), matching
`session.rs:30`'s `MAX_INTENTS = 256`, and Rust carries a comment at
`protocol.rs:1375` stating the response bound must track `MAX_INTENTS`. So a
change set with more than 16 intents produces a **valid** `read_operation`
response that the typed client rejects. Latent only because no existing test
builds a change set that large.

**Files:** `packages/live-compare/src/protocol.ts`;
`packages/live-compare/tests/fixtures/protocol-v1/accepted.json`;
`packages/live-compare/tests/protocol.test.ts`;
`crates/strata-kernel/tests/local_service.rs`.

- [ ] **Step 1 (RED, both languages).** Add a golden accepted fixture carrying a
  maximal `read_operation` response — exactly `MAX_INTENTS` (256) intent
  summaries. Assert it parses in TS (`protocol.test.ts`) and in Rust
  (`local_service.rs`, via the shared `protocol-v1` fixture loader). The TS
  assertion must fail before the fix.
- [ ] **Step 2.** Raise the TS bound to 256 and add the same
  "must track `MAX_INTENTS`" comment the Rust side has, naming the constant it
  mirrors. Add a rejected fixture at 257 so the bound is pinned from both sides,
  not merely raised.
- [ ] **Step 3.** Check the neighbouring bounds block
  (`protocol.ts:3-21`) against Rust's (`protocol.rs:13-43`) constant by
  constant and record any further divergence in the plan's Task 2 notes rather
  than silently fixing it — one defect per commit.
- [ ] **Step 4: commit.**

```bash
git add packages/live-compare/src/protocol.ts packages/live-compare/tests
git commit -m "fix(protocol): TS operation-intent bound must track Rust MAX_INTENTS (16 -> 256)"
```

---

### Task 2: One source of truth for the read-only action list

**The hazard:** `client.ts:61-73` decides mutating-ness with a **deny-list of
read-only action types**, so any action added to the protocol is treated as
mutating by default — it gets an idempotency key, and the daemon then rejects it
(`protocol.rs:823`: read-only actions must not carry one). The same partition is
maintained independently in Rust (`is_mutating`, a *positive* list) and in
`protocol.ts`'s `MUTATING_ACTIONS`. Three copies, two languages, no shared
oracle. B-2 added two read actions and had to hand-edit all three.

**Files:** `packages/live-compare/src/{protocol.ts,client.ts}`; a new shared
fixture under `packages/live-compare/tests/fixtures/protocol-v1/`;
`crates/strata-kernel/tests/local_service.rs`;
`packages/live-compare/tests/protocol.test.ts`.

- [ ] **Step 1.** Make `protocol.ts` the single TS authority: derive the
  client's predicate from `MUTATING_ACTIONS` (export a
  `isMutatingAction(type)`) and delete `client.ts`'s independent deny-list.
  Prefer a form where a NEW action that is in neither list fails a type check
  or a test, rather than silently defaulting either way.
- [ ] **Step 2 (dual-language lockstep).** Add a golden fixture enumerating
  EVERY action type with its mutating flag. TS asserts its predicate matches the
  fixture exactly (no missing, no extra); Rust asserts `is_mutating` matches the
  same file. A future action added to one language and not the other fails a
  gate instead of failing in production.
- [ ] **Step 3.** Run the full protocol + client suites; commit.

```bash
git add packages/live-compare/src packages/live-compare/tests crates/strata-kernel/tests/local_service.rs
git commit -m "refactor(protocol): one authority for the mutating/read-only partition, pinned dual-language"
```

---

### Tasks 3+4 are ONE atomic change (review Blocker)

v1 moved the sources in Task 3 and repointed consumers in Task 4, which would
commit a red `live-compare` in between. Scaffold, move, and repoint before a
single commit — or use temporary forwarding files and delete them before it.
The two task bodies below are kept separate for reviewability; the commit at
the end of Task 4 is the only commit for both.

### Task 3: Create `@strata-code/coordination-client`

**Files:** create `packages/coordination-client/{package.json,tsconfig.json,src/index.ts}`;
move `packages/live-compare/src/{protocol.ts,client.ts}` into its `src/`.

**Interfaces:**
- `package.json`: `name: "@strata-code/coordination-client"`, `version: 0.0.0`,
  `private: true`, `main`/`types`/`exports` exactly as `live-compare`'s,
  `scripts: { build: "tsc -b", test: "vitest run" }`. **Dependencies: `zod`
  only.** devDeps `@types/node`, `typescript`, `vitest`. If anything else is
  needed, the cut is wrong — stop and report.
- `tsconfig.json`: mirror `live-compare`'s (`extends ../../tsconfig.base.json`,
  `composite`, `rootDir: src`, `outDir: dist`, `tsBuildInfoFile`). Note
  `live-compare`'s tsconfig has no `references` array; other packages
  (`agent`, `verify`, …) do. Follow whichever the consuming package needs to
  build cleanly and say which you used.
- `src/index.ts`: explicit named re-exports of the client and protocol surface.
  **Not `export *`** — the flat barrel is what made `live-compare` a bag of
  fifteen unrelated modules, and this package's export list is now its public
  contract.

- [ ] **Step 1.** Scaffold the package; `pnpm install` to link the workspace.
- [ ] **Step 2.** `git mv` the two source files (preserve history). Fix relative
  import specifiers (`./protocol.js` stays correct; nothing else should move).
- [ ] **Step 3.** Build the package alone: it must compile with `zod` as its
  only runtime dependency.
- [ ] **Step 4.** Move the wire contract's tests and fixtures WITH the package
  (review, Q1): `git mv` `packages/live-compare/tests/protocol.test.ts` and
  `packages/live-compare/tests/fixtures/protocol-v1/` (including
  `raw-accepted/` and `raw-rejected/`) into
  `packages/coordination-client/tests/`, and update the THREE joins in
  `crates/strata-kernel/tests/local_service.rs` (`:48`, `:79`, `:86`). Do NOT
  touch `crates/strata-kernel/tests/bridge_protocol.rs:42` — that is the
  unrelated kernel-bridge fixture path.
- [ ] **Step 5.** No commit here — see "Tasks 3+4 are ONE atomic change".

---

### Task 4: Re-point consumers; keep `live-compare` green

**Consumers — the complete, enumerated list** (all inside `live-compare`, which
is a private leaf; nothing outside the package imports it). v1's four-item list
was wrong; "gate tests consume the harness" does NOT cover their direct imports.

*Source (14):* `gate1.ts`, `gate2.ts`, `agent.ts`, `liveAdapter.ts`, `tools.ts`,
`client.ts`, `index.ts`, `service.ts`, **`tasks.ts`**, `gate3/characterize.ts`,
`gate3/kernel-child.ts`, `gate3/step0-stage-decomposition.ts`,
`persistence/exit-gate-memory.ts`, `persistence/differential-oracle.ts`.

*Tests (10):* `client.test.ts`, `serviceHarness.ts`, `service.test.ts`,
`behavioralGate.test.ts`, `behavioralTimeout.test.ts`,
`discoveryBootstrap.test.ts`, `gate1Crash.test.ts`, `gate1Intrusion.test.ts`,
`persistenceMemory.test.ts`, `persistentBridge.test.ts`.

**`tasks.ts` is the one to be careful with.** The global constraint says it is
never staged; this slice needs exactly one import-specifier rewrite in it and
nothing else. Diff it before staging and confirm the change is the import line
alone — the registration digest `628bd6da…` must not move.

- [ ] **Step 1.** Add `@strata-code/coordination-client: workspace:*` to
  `live-compare`'s dependencies; re-point every import.
- [ ] **Step 2.** **Do NOT keep a compatibility re-export** (review, Q3).
  Remove the `./client.js` and `./protocol.js` lines from
  `live-compare/src/index.ts` (`:5`, `:12`) and let consumers import from the
  new package directly. The package is a private leaf; taking the break now
  avoids carrying a shim into D-2.
- [ ] **Step 3.** Move `tests/client.test.ts` into the new package (it is the
  client's behavioral spec and must travel with it). This does NOT affect the
  Rust lockstep — it imports protocol helpers but reads no fixture files
  (review, Q2). Reconcile the specifier convention: `src/*` uses `.js` ESM
  specifiers while the test imports extensionless — pick the one that builds and
  say so.
- [ ] **Step 3b (review, missed edge).** Add
  `"references": [{ "path": "../coordination-client" }]` to
  `packages/live-compare/tsconfig.json`, which currently has none. Root gate
  scripts invoke `pnpm --filter @strata-code/live-compare build` directly, so
  without the reference a stale local `dist/` can mask a clean-build failure.
  Prove it: remove both `dist/` directories and build from cold.
- [ ] **Step 4 (the structural-typing hazard).** `tools.ts`'s
  `CoordinationClientApi` (`tools.ts:106-140`) is satisfied by
  `CoordinationClient` **structurally**, with no `implements` clause, and the
  two already disagree: the interface omits the trailing `deadlineMs` and
  widens `findDeclarations`'s `kind` to `string` (`tools.ts:116`) versus the
  client's enum (`client.ts:275`). Runtime input is still enum-constrained
  (`tools.ts:62`), so this is latent type-contract debt, not a live bug.
  **A plain assignment or `satisfies` assertion is NOT sufficient** — method
  parameter bivariance accepts the drifted shape (review, Q5). Either redefine
  `CoordinationClientApi` as `Pick<CoordinationClient, ...>`, or add exact
  per-method type-equality assertions. State which you chose and why.
- [ ] **Step 5.** Green: `pnpm --filter @strata-code/coordination-client test`,
  `pnpm --filter @strata-code/live-compare test`, then
  `PATH=/opt/homebrew/bin:$PATH pnpm kernel:full-key-free:test`.
- [ ] **Step 6: commit.**

```bash
git add packages
git commit -m "refactor(live-compare): consume the extracted coordination client; client spec travels with it"
```

---

### Task 5: Close

- [ ] **Step 1.** Full chain detached (Orca kills harness background tasks) with
  log evidence; workspace sweep with the documented pre-existing exceptions
  (`verify` `extractFunctionCommit`, `agent` `replay`/`labSeam` — both are
  worktree-path-dependent, decisions.md 2026-08-20; run the packages after
  `verify` individually, since `pnpm -r test` fail-fasts there).
- [ ] **Step 2.** decisions.md APPENDED close entry: what moved, the two defects
  fixed (intent bound, partition authority), the export-surface decision, the
  structural-typing assertion, anything discovered. Roadmap: D-1 checked.
  `strata-design.md` untouched.
- [ ] **Step 3: commit.**

```bash
git add decisions.md docs/product-roadmap.md
git commit -m "chore(d1): record D-1 close — client extracted, wire parity pinned"
```

---

## Explicit non-goals

No framing change, no persistent connections, no handshake or identity work, no
daemon lifecycle, no packaging/publication, no `tools.ts` move, no `service.ts`
rewrite, no item-C work, no keyed runs, `tasks.ts` never staged.

## Self-review (v2)

All review corrections mapped: Blocker (red intermediate commit) → the
"Tasks 3+4 are ONE atomic change" note; consumer undercount → Task 4's
enumerated list plus the `tasks.ts` caution; insufficient structural assertion →
Task 4 Step 4; missing project reference → Task 4 Step 3b; fixture ownership →
Task 3 Step 4 with the corrected three-join count; barrel shim → Task 4 Step 2.
Both factual corrections were re-verified by enumeration before adoption.

## Open questions (ANSWERED — retained for the record)

1. **Is the package boundary right?** `protocol.ts` is both the client's wire
   contract AND the daemon's dual-language lockstep partner (Rust tests read
   `packages/live-compare/tests/fixtures/protocol-v1/`). After the move, those
   fixtures live... where? Moving them changes hardcoded paths in six Rust test
   files (`local_service.rs:48`, `:79`, `:86`, and siblings). Leaving them
   behind splits a contract from its fixtures. Which is less bad?
2. **Does `client.test.ts` moving break the Rust-side fixture lockstep?** Task 4
   Step 3 assumes not; confirm.
3. **Should `live-compare`'s barrel re-export at all**, or should D-1 take the
   breaking-import hit now while `live-compare` is still a private leaf, rather
   than carrying a compatibility shim into D-2?
4. **Is Task 2 over-reach for this slice** — is the dual-language partition
   fixture worth its cost now, or does it belong in D-2 where the handshake
   already changes how actions are classified?
5. Anything in the three-copy partition or the structural `CoordinationClientApi`
   that is a live bug today rather than a latent hazard.
