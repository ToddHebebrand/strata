# Validation-Circle Narrowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Independent same-module sibling operations publish concurrently
(mMechanism probe: ready/ready, both publish, zero fresh decisions, both
orders converge) without weakening any qualified R/S/D/G/X protocol outcome.

**Architecture:** Narrow the TS bridge's `validationDependencies` from module
closure to seed-statement subtrees; add intent-content pins (with semantic
namespace membership) for `addParameter`; make validation pins non-reserving
and module parents non-reserved on the Rust side; switch `children:{...}`
membership, clock bumps, and containment parent-coverage to shape-only
semantics; allow a pinned-target endpoint to satisfy new-reference
containment. Spec: `docs/superpowers/specs/2026-07-17-validation-circle-narrowing-design.md`.

**Tech Stack:** Rust (strata-kernel), TypeScript (kernel-bridge,
live-compare), vitest, cargo test.

## Global Constraints

- All work in `/Users/toddhebebrand/Strata/.worktrees/phase6-live-comparison`
  on branch `feature/phase6-live-comparison-design`.
- Every test command that reaches the Node bridge MUST be prefixed
  `PATH=/opt/homebrew/bin:$PATH` (Homebrew node v26 native modules; without
  it daemon tests fail with redacted `request_failed`).
- No wire-protocol field removals; new fields are serde-default (Rust) /
  zod-default (TS) so old durable records parse.
- Every derived list is code-unit sorted and deduped before use or hashing.
- No live model spend anywhere in this plan.
- Baselines already verified green: `cargo test -p strata-kernel` (24 suites),
  live-compare (117 tests), at commit `adc2ae1`.

---

### Task 1: Shape-only membership, clocks, and containment (spec Change 5)

**Files:**
- Modify: `crates/strata-kernel/src/coordination/resources.rs`
  (`children_resource`, `affected_resource_keys`, `add_parent_bucket`)
- Modify: `crates/strata-kernel/src/coordination/analyzer.rs`
  (`required_delta_authority`)
- Modify: `crates/strata-kernel/tests/coordination_resources.rs` (payload-row rewrite)
- Modify: `crates/strata-kernel/tests/coordination_optimistic.rs` (payload invalidator rewrite)

**Interfaces:**
- Produces: `children_resource(graph, parent_id)` hashing sorted
  `(id, kind, child_index)` tuples; `affected_resource_keys` and
  `required_delta_authority` treating "payload-only upsert" (node exists in
  `current` with identical `parent_id`, `child_index`, `kind`) as requiring
  no parent bucket/coverage.

- [ ] **Step 1: Write failing unit tests** in `coordination_resources.rs`:
  a payload-only upsert must NOT contain `children:{parent}` in
  `affected_resource_keys`; a `child_index` change and a fresh insert MUST;
  `children_resource` version must be identical before/after a payload-only
  mutation and differ after an insert. In `analyzer.rs` tests: payload-only
  upsert passes containment without `node:{parent}` in reservation keys; an
  insert without parent reservation still fails.

```rust
// coordination_resources.rs (new rows, names indicative)
#[test]
fn payload_only_upsert_does_not_bump_parent_membership() { /* build G0 with
    statement S under module M; delta upserts S with changed payload only;
    assert !keys.contains("children:{M}") && keys.contains("node:{S}") */ }
#[test]
fn shape_change_bumps_parent_membership() { /* delta inserts new node under M;
    assert keys.contains("children:{M}") */ }
#[test]
fn children_resource_is_payload_insensitive_but_shape_sensitive() { /* two
    graphs differing only in S.payload → equal version; differing by an
    added child → different version */ }
```

- [ ] **Step 2: Run to verify the new rows fail** (`cargo test -p
  strata-kernel --test coordination_resources`): payload row fails on the
  old full-record hash / unconditional parent bump.

- [ ] **Step 3: Implement.** In `resources.rs`:

```rust
pub(crate) fn children_resource(graph: &GraphGeneration, parent_id: &str) -> Result<ResourceVersion> {
    let mut members: Vec<(String, String, u64)> = graph
        .snapshot()
        .nodes
        .into_iter()
        .filter(|node| node.parent_id.as_deref() == Some(parent_id))
        .map(|node| (node.id, node.kind, node.child_index))
        .collect();
    members.sort();
    hashed_resource(format!("children:{parent_id}"), &members)
}
```

  In `affected_resource_keys`, for `UpsertNode`: compute
  `payload_only = current.node(&node.id).is_some_and(|old| old.parent_id == node.parent_id && old.child_index == node.child_index && old.kind == node.kind)`
  and call `add_parent_bucket` only when `!payload_only` (old and new parent
  buckets, as today). `DeleteNode` keeps its bucket. In
  `required_delta_authority`, apply the same `payload_only` predicate to skip
  the two `reservation_coverage.insert(node_key(parent))` calls for
  `UpsertNode`.

- [ ] **Step 4: Rewrite the two payload-reliant tests** flagged by review
  finding 6: `coordination_resources.rs:23-45` (expects a rename payload
  update to affect a `children:*` key — change the fixture to an insert or
  assert the node key instead, matching the row's documented purpose) and
  `coordination_optimistic.rs:778-810` (uses a payload patch as its
  `children:*` invalidator — switch the invalidator to a `child_index`
  change or insert). Preserve each test's original intent in its comment.

- [ ] **Step 5: Full kernel suite green:**
  `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel` → all suites ok.

- [ ] **Step 6: Commit** `feat(kernel): shape-only membership, clocks, and containment`

### Task 2: Pinned-target endpoint coverage for new references (spec Change 6)

**Files:**
- Modify: `crates/strata-kernel/src/coordination/analyzer.rs`
  (`validate_delta_containment`, `materialized_identifier_children` or a
  sibling helper)
- Test: same file's `mod tests`

**Interfaces:**
- Produces: `validate_delta_containment(current, delta, scope)` accepting an
  `UpsertReference` whose source is a materialized identifier under an
  authorized writable statement when `node:{to}` appears in
  `scope.read_set` or `scope.validation_set` (exact key), even though
  `node:{to}` is not in `reservation_keys`.

- [ ] **Step 1: Write failing tests:** (a) positive: delta has
  `UpsertReference { from: new identifier under write-authorized statement,
  to: T }`, scope has `node:{T}` only in `validation_set`, no `node:{T}`
  reservation → containment passes; (b) negative: same delta with no
  `node:{T}` pin anywhere → containment fails with the endpoint message;
  (c) regression: reference retarget whose source is NOT materialized still
  requires the reservation (existing rows at `analyzer.rs:584-594` stay).

- [ ] **Step 2: Verify (a) fails today** (endpoint coverage missing).

- [ ] **Step 3: Implement:** in `validate_delta_containment`, build
  `pinned_nodes: BTreeSet<&str>` from `scope.read_set` ∪
  `scope.validation_set` keys with prefix `node:`; when filtering
  `missing_reservations`, additionally allow a key if it is the `node:{to}`
  endpoint of an `UpsertReference` whose `from` is in
  `materialized_children` AND the key is in `pinned_nodes`. Compute the set
  of such allowed endpoint keys once from the delta, don't loosen other keys.

- [ ] **Step 4: Kernel suite green; commit**
  `feat(kernel): pinned-target endpoint coverage for materialized references`

### Task 3: Semantic clock bumps from the write set only (spec Change 2b)

**Files:**
- Modify: `crates/strata-kernel/src/coordination/publication.rs`
  (`semantic_index_keys` collection, currently
  `fresh_scope.write_set.iter().chain(&fresh_scope.validation_set)`)
- Test: `crates/strata-kernel/tests/coordination_publication.rs`

- [ ] **Step 1: Failing test:** publish a claim whose scope carries a
  `namespace:demo:Name` resource ONLY in `validation_set`; assert the
  resource clock for that key is unchanged after publication, while a
  write-set `namespace:` key still bumps.

- [ ] **Step 2: Verify it fails** (validation-set key currently bumps).

- [ ] **Step 3: Implement:** drop the `.chain(&fresh_scope.validation_set)`
  from the `semantic_index_keys` collection (write-set only).

- [ ] **Step 4: Kernel suite green; commit**
  `fix(kernel): bump semantic clocks from write-set keys only`

### Task 4: Intent-content dependency pins for addParameter (spec Changes 2/2a)

**Files:**
- Modify: `packages/kernel-bridge/src/analyze.ts` (`analyzeAddParameter`
  gains `typeText`/`defaultValue`; new `resolveIntentContentDependencies`)
- Modify: `packages/kernel-bridge/src/protocol.ts` (`semanticFactsSchema`
  addParameter arm gains `contentDependencyDeclarationIds: z.array(z.string()).default([])`)
- Modify: `crates/strata-kernel/src/bridge/protocol.rs` (`SemanticFacts::AddParameter`
  gains `#[serde(default)] content_dependency_declaration_ids: Vec<String>`)
- Modify: `crates/strata-kernel/src/bridge/provider.rs` (addParameter arm
  consumes the field: validation pins + `semantic_name_resources` into the
  validation set only)
- Modify: `packages/kernel-bridge/tests/analyze.test.ts`,
  `packages/kernel-bridge/tests/fixtures/protocol-v1/analyze-response.json`,
  `crates/strata-kernel/tests/bridge_protocol.rs` (golden + rejected rows for
  the new field, mirroring the 4dd020d renamedSymbols fixture pattern)

**Interfaces:**
- Produces (TS): `analyzeAddParameter(db, functionId, typeText, defaultValue)`
  returning facts with `contentDependencyDeclarationIds: string[]` — the
  code-unit-sorted, deduped IDs of every module-level declaration resolved
  from the expression/type text (all same-named declarations, merged
  interfaces included).
- Produces (Rust): the provider validation-pins, for each content
  declaration D: `node:{D}`, `node:{D.nameIdentifier}`, D's statement subtree
  membership (`children:{D}`), and `semantic_name_resources(graph, D.parent,
  D.kind, [name])` — all into `validation_set` only, no reservations, no
  write entries.

- [ ] **Step 1: Failing TS tests** in `analyze.test.ts`:
  (a) `defaultValue: "UserTypes.displayUser(user)"` on the medium corpus
  resolves the namespace import and returns `displayUser`'s declaration id
  in `contentDependencyDeclarationIds`; (b) bare identifier resolving to a
  same-module declaration is pinned; (c) a name declared twice
  (interface merging fixture: `interface A` + `interface A`) returns BOTH
  ids, sorted; (d) unresolved name (`Nonexistent.foo`) contributes nothing
  and analysis still succeeds; (e) omitted defaultValue/typeText → `[]`.

- [ ] **Step 2: Verify they fail** (field absent).

- [ ] **Step 3: Implement TS resolution** in `analyze.ts` (pure graph +
  single-file expression parse; no program build):

```ts
function resolveIntentContentDependencies(
  db: Db, moduleIdOfFunction: string, texts: readonly (string | undefined)[]
): string[] {
  const names = new Set<{ root: string; member?: string }>-collected-by-walk;
  // ts.createSourceFile over `const __probe = (${text});` for values and
  // `type __Probe = ${text};` for types; walk for Identifiers and
  // PropertyAccess/QualifiedName roots (root identifier + first member).
  // Resolution per name:
  //  - module-level declarations of the function's module whose
  //    declaration name === root  → pin ALL of them
  //  - import bindings of the module: named import of `root` → pin every
  //    module-level declaration named `root` in the source module;
  //    namespace import of `root` → pin every module-level declaration
  //    named `member` in the source module.
  // Return canonicalIds(pinnedDeclarationIds).
}
```

  Wire into `analyzeAddParameter` and spread into the returned facts;
  include each content declaration's statement subtree in the
  `validationDependencies` seed list so Change 1's narrowed walk pins it.

- [ ] **Step 4: Implement Rust consumption** in `provider.rs` addParameter
  arm: for each id, `require_node`, `ensure!(is_declaration)`, push
  `node_resource`, name-identifier resource, `children_resource(graph, id)`
  into `validation_set`; compute `declaration_name` and push
  `semantic_name_resources(graph, container, &node.kind, [name])` into
  `validation_set` (via a validation-only push, NOT `write_and_validate`).
  No reservations.

- [ ] **Step 5: Fixture rows:** extend `analyze-response.json` golden with
  the new field; add a rejected row (non-array) in both `bridge_protocol.rs`
  and the TS worker/protocol tests, following the existing renamedSymbols
  row pattern.

- [ ] **Step 6: Interface-merging regression (spec Change 2a) as a kernel
  test** in `crates/strata-kernel/tests/coordination_optimistic.rs` (or a
  new `coordination_content_pins.rs`): sibling rename `B → A` (merging) must
  invalidate a claimed addParameter whose facts carry `A`'s declaration ids —
  the rename's `namespace:{module}:A` write drifts the pinned namespace
  version → `MateriallyChanged`/clock mismatch → not published.

- [ ] **Step 7: Full TS + Rust suites green
  (`PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata/kernel-bridge test`,
  `... cargo test -p strata-kernel`); commit**
  `feat(kernel): pin addParameter intent-content dependencies with namespace membership`

### Task 5: Narrow the circle and flip the sealed assertions (spec Changes 1/3/4)

One commit — the three mechanism edits and the assertion flips are a single
semantic change; intermediate states are deliberately not committed.

**Files:**
- Modify: `packages/kernel-bridge/src/analyze.ts` (`validationDependencies`)
- Modify: `crates/strata-kernel/src/bridge/provider.rs`
  (`add_validation_facts`, `reserve_node_and_parent`)
- Modify: `packages/kernel-bridge/tests/analyze.test.ts` (closure assertions)
- Modify: `packages/live-compare/tests/serviceHarness.ts` (`probeSameModulePair`)
- Modify: `packages/live-compare/tests/mMechanism.test.ts` (the flip)
- Modify: `packages/live-compare/tests/dynamicPreflight.test.ts` (M + X rows)

**Interfaces:**
- Produces (TS): `validationDependencies(db, seedNodeIds)` returning the
  union over seeds of: enclosing module-level statement node + full
  descendant subtree; references from pinned nodes. No module nodes, no
  module closure, no program build (delete `buildProgramDependencies` if
  now unused).
- Produces (Rust): `add_validation_facts` with no `reserve` calls;
  `reserve_node_and_parent` skipping the parent key when
  `graph.node(parent).kind == "Module"`.
- Produces (harness): `probeSameModulePair(corpusRoot, a, aNew, b, bNew)` →
  `{ orders: [{ submitStates, firstState, secondState, freshDecisions,
  finalGraphDigest }, …both orders…] }`, each order on a fresh corpus copy.

- [ ] **Step 1: RED — extend the probe and flip the pin.**
  `probeSameModulePair` runs both advance orders (fresh service + corpus
  copy per order), counts `needs_decision` occurrences as `freshDecisions`,
  and records the final published graph digest per order (the daemon's
  publication gate tsc-validates every candidate, so `published` implies
  green). Rewrite `mMechanism.test.ts`:

```ts
const result = await probeSameModulePair(copy, "probeAlpha", "probeAlphaRenamed", "probeBeta", "probeBetaRenamed");
for (const order of result.orders) {
  expect(order.submitStates).toEqual(["ready", "ready"]);
  expect(order.firstState).toBe("published");
  expect(order.secondState).toBe("published");
  expect(order.freshDecisions).toBe(0);
}
expect(result.orders[0]!.finalGraphDigest).toBe(result.orders[1]!.finalGraphDigest);
```

  Update the header comment: this IS the narrowing iteration's acceptance.

- [ ] **Step 2: Run it, verify RED for the current reasons** — submitStates
  `["ready","queued"]` and a needs_decision:
  `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata/live-compare test -- mMechanism`

- [ ] **Step 3: Implement Change 1** — replace `validationDependencies`:

```ts
function validationDependencies(db: Db, seedNodeIds: readonly string[]) {
  const graph = buildGraphIndex(db);
  const pinned = new Set<string>();
  for (const seedId of seedNodeIds) {
    let current = graph.nodeById.get(seedId);
    if (!current) throw new AnalyzeFailure(/* unresolvedReference, as today */);
    while (current.parentId !== null &&
           graph.nodeById.get(current.parentId)?.kind !== "Module") {
      current = graph.nodeById.get(current.parentId)!;
    }
    if (current.parentId === null) throw new AnalyzeFailure(/* node has no module */);
    // current is the enclosing module-level statement: pin its subtree.
    const stack = [current.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (pinned.has(id)) continue;
      pinned.add(id);
      for (const child of graph.nodes) if (child.parentId === id) stack.push(child.id);
    }
  }
  const validationDependencyNodeIds = canonicalIds([...pinned]);
  const selected = new Set(validationDependencyNodeIds);
  const validationDependencyReferenceFromNodeIds = canonicalIds(
    graph.references.filter((r) => selected.has(r.fromNodeId)).map((r) => r.fromNodeId)
  );
  return { validationDependencyNodeIds, validationDependencyReferenceFromNodeIds };
}
```

  (Keep `buildGraphIndex`; use a child index map instead of the O(n²) scan
  if the medium corpus makes it slow. Delete `buildProgramDependencies` +
  `moduleSpecifierOf` if no other caller remains.)

- [ ] **Step 4: Implement Changes 3+4** in `provider.rs`: delete the
  `reserve_node_and_parent`/`reserve` calls inside `add_validation_facts`
  (keep every `validation_set.push`); change `reserve_node_and_parent` to:

```rust
fn reserve_node_and_parent(&mut self, node: &NodeRecord) {
    self.reserve(format!("node:{}", node.id));
    if let Some(parent_id) = &node.parent_id {
        let parent_is_module = self
            .graph
            .node(parent_id)
            .is_some_and(|parent| parent.kind == "Module");
        if !parent_is_module {
            self.reserve(format!("node:{parent_id}"));
        }
    }
}
```

- [ ] **Step 5: mMechanism green:** rerun the Step-2 command → both orders
  ready/ready, both publish, zero decisions, equal digests.

- [ ] **Step 6: Flip the sealed M and X rows** in
  `dynamicPreflight.test.ts` (cite the spec in comments):
  - M row: `submittedStates` → `["ready", "ready"]` in both orders;
    `freshDecisions` → `0`; keep green/generation-2/digest-equality and the
    final-source assertions; update the header comment (restores the
    original pre-amendment M clause).
  - X rows: `submittedStates` → `["ready", "ready"]` in both orders; keep
    `scope_expanded` + `intent_ready` (X2-first), keep
    `staleX2State === "needs_decision"` + the exact `renamedSymbols` payload
    + `derivedFreshValue` (X1-first), keep cross-order digest equality.
    If `scopeExpandedBeforePublishAdvance` changes observable timing (the
    expansion now fires during X1's first advance), adjust that single
    boolean's derivation with a comment — the event must still precede the
    publishing advance.
  - D/R/S/G rows: unchanged — they must pass as-is; if any fails, STOP and
    re-diagnose before touching them (that is a design defect, not a test
    update).

- [ ] **Step 7: Update `analyze.test.ts` closure assertions** to the
  narrowed semantics (arity statements still contained; the disjointness
  rows still pass; module-closure-specific expectations become
  statement-subtree expectations). Run
  `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata/kernel-bridge test`.

- [ ] **Step 8: Full verification for the task:**
  `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel` and
  `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata/live-compare test`
  (full suite, both green).

- [ ] **Step 9: Commit**
  `feat(kernel): narrow the validation circle to statement subtrees`

### Task 6: Kernel-side same-module acceptance row (review finding 9)

**Files:**
- Modify: `crates/strata-kernel/tests/full_key_free_acceptance.rs` (new row)

- [ ] **Step 1:** Add a row (ignored-gated like its siblings, run via
  `pnpm kernel:full-key-free:test`) driving the real Node bridge: fixture
  with two disjoint same-module function declarations; submit both change
  sets, assert both offers are READY simultaneously (both claims capturable
  before either publication), publish both, assert generation 2, no
  `IntentNeedsDecision` event, and both `OperationRecord`s present.

- [ ] **Step 2:** `PATH=/opt/homebrew/bin:$PATH pnpm kernel:full-key-free:test`
  → all rows including the new one green.

- [ ] **Step 3: Commit** `test(kernel): prove same-module concurrent publication through the bridge`

### Task 7: Requalification, decisions.md, pointers

**Files:**
- Modify: `decisions.md` (new entry, newest at top)
- Modify: `docs/superpowers/specs/2026-07-16-phase-6-live-comparison-design.md`
  (M section + validation-circle pointer)
- Modify: `docs/product-roadmap.md` (M parenthetical)

- [ ] **Step 1: Full-tree verification:**
  - `PATH=/opt/homebrew/bin:$PATH cargo test -p strata-kernel`
  - `PATH=/opt/homebrew/bin:$PATH pnpm kernel:full-key-free:test`
  - `PATH=/opt/homebrew/bin:$PATH pnpm -r test` — expected: everything green
    except @strata/agent's two documented `5073ecfb56151b41` replay-fixture
    failures (the accepted baseline).

- [ ] **Step 2: decisions.md entry** covering: the narrowing (four pinch
  points + Changes 1–6), the M restoration to its original clause, the X
  submit-state change, the review findings folded in (endpoint coverage,
  namespace pins, write-set clocks), the future-intent constraint (ops that
  change name resolution without rewriting dependent statements must extend
  validation pinning), and the registration-impact note: any live retry
  needs a fresh operator approval file (new sourceCommit, digests) — and if
  the strata system prompt or task registration changed, re-freeze digests;
  otherwise state explicitly that they did not change.

- [ ] **Step 3: Amend the two pointer docs** (one-paragraph pointers to the
  decisions entry; do not rewrite history).

- [ ] **Step 4: Commit** `docs(kernel): record the validation-circle narrowing`
