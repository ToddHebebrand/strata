# Iteration 6 slice A — gate 1 (key-free semantic parity) Implementation Plan — v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**v2 (2026-07-18):** revised after the independent Codex review (gpt-5.6-sol,
xhigh; output in the session artifact, findings logged in decisions.md). All
five blockers, both majors, and the minor are incorporated. The behavioral-
profile task was **removed** (the shipped T03 gate is tsc-only by registration
— `packages/verify/src/taskBehavioralFixtures.ts` maps `T03: []`); crash
choreography, parity conventions, audit comparison, and intrusion oracles were
rewritten per the review.

**Goal:** Land gate 1 of the convergence slice: a fresh-store, rename-only, N=1 T03 flow on the Rust kernel (redb sole durable authority, full coordination semantics) that is semantically parity-checked against the SQLite product arm, survives crash injection at every reachable durable boundary with a full atomic-state oracle, and honors FIFO under second-client intrusion at every nominal "solo" stage.

**Architecture:** Extend the daemon's wire protocol with the minimal T03 product surface (`find_declarations`, `read_operation`), make the canonical `OperationRecord` self-contained (per-intent typed parameters), add an offline `export-snapshot` oracle with an atomic-state projection, then drive both arms from a key-free vitest parity/crash/intrusion suite in `packages/live-compare`. Both arms run the task-registered T03 validation profile (tsc-only); the harness additionally runs tsc **and** vitest externally on both rendered corpora.

**Tech Stack:** Rust (redb, serde), TypeScript (pnpm workspaces, vitest, zod, better-sqlite3 in-memory only), existing `@strata-code/{ingest,store,render,verify}` packages.

**Design:** `docs/superpowers/specs/2026-07-18-iteration6-slice-a-convergence-design.md` (D1–D9, as amended for v2). Acceptance frame: gate 1 of `docs/superpowers/specs/2026-07-18-kernel-convergence-review-codex.md` §4.

## Global Constraints

- **No solo bypass:** no change may skip scope inference, fresh analysis, validation binding, reservations, or fenced publication. If a task cannot pass otherwise, STOP and log a decision (falsifier 1).
- **No persisted SQLite in the kernel arm:** better-sqlite3 only via `openDb(":memory:")`.
- **Key-free:** no model calls, no API keys anywhere in this plan.
- **No new digest updates:** graph, source, task-registration, delta, and event digests must not be "updated to pass" — a digest change is a finding, not a fixture refresh. Only expectations that hash newly *written* `OperationRecord` bytes may change (Task 1), and each such change must be named in the commit message.
- **Validation profile:** gate 1 uses T03's registered profile — tsc-only — in BOTH arms (`taskBehavioralFixtures.ts` `T03: []`). No whole-suite vitest autodiscovery inside any commit gate. The daemon stays `tsc_only`.
- **Green claims** only via `PATH=/opt/homebrew/bin:$PATH pnpm kernel:full-key-free:test` plus `pnpm -r test` (Homebrew node ABI; bare `cargo test` skips feature-gated suites).
- **Feature matrix for Rust changes:** run `cargo test -p strata-kernel`, `--features coordination-test-api`, AND `--features redb-spike-api` (OperationRecord literals exist outside the first two).
- **Deadlines:** harness requests must budget ≥30.1 s remaining for `submit_change_set`, ≥60.1 s for `advance_change_set` (`session.rs:27-29`).
- **Long commands:** run test suites foreground with explicit generous timeouts (the supervisor kills detached harness background tasks).
- Commit after every task; push after every 2–3 tasks.

## Shared conventions (referenced by Tasks 6–9)

- **One corpus-input builder for both arms** (review blocker 2): module paths are corpus-relative POSIX (`src/...`), exactly like `createQualifiedKernelSnapshot` (`packages/live-compare/src/tasks.ts:495-506`). The SQLite arm ingests the SAME relative-path inputs — never `packages/cli/src/commands/t03.ts`'s absolute-path `collectTsFiles`. Node IDs hash the module path (`packages/store/src/ids.ts:9`), so this is what makes "same ingest, same IDs" true.
- **Generation normalization:** Rust `GraphSnapshot.generation` serializes as a JSON number; `KernelSnapshotV1` uses a canonical decimal string. The harness parses the Rust export with a lenient schema and converts generation via one helper (`canonicalGenerationString(value: number): string`, the inverse of Task 6's `boundedGenerationNumber`). Node/reference parity never involves the generation field.
- **Normalized audit projection** (review major 5): the cross-arm audit comparison compares exactly `{ actor, taskContext, operationClass: "RenameSymbol", declarationId, oldName, newName, renamedIdentifierIds: string[] }`. SQLite source: `operations` row (`params_json` snake_case `declaration_id/old_name/new_name`, `affected` = semantic Identifier IDs, `reasoning` null) joined with its transaction's prompt (`packages/store/src/rename.ts:61-80`, `transactions.ts:59-78`). Kernel source: `read_operation` (actor, change-set reasoning as taskContext, `parametersJson`, `renames`) with `renamedIdentifierIds` = the Identifier-kind subset of `affectedNodeIds`. The kernel's full delta-derived `affectedNodeIds` (superset incl. statement nodes) is asserted separately as non-empty and containing every projected identifier — it is documented as intentionally broader, never "equal".

---

### Task 1: Self-contained canonical operation record (`OperationRecord.intents`)

**Files:**
- Modify: `crates/strata-kernel/src/model.rs` (after `OperationRename`, ~line 76)
- Modify: `crates/strata-kernel/src/coordination/publication.rs:575-587` (operation construction)
- Test: `crates/strata-kernel/src/model.rs` (new `#[cfg(test)] mod tests`); one old-record recovery fixture test (below)

**Interfaces:**
- Produces: `pub struct OperationIntentRecord { pub kind: String, pub parameters_json: String }`; `OperationRecord` gains `#[serde(default)] pub intents: Vec<OperationIntentRecord>`. Tasks 3 and 6 rely on these exact names.

- [ ] **Step 1: Write the failing serde-compat test** in `model.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_record_without_intents_field_deserializes_with_empty_intents() {
        let legacy = r#"{"operationId":"op-1","changeSetId":"cs-1","actor":"a",
            "kind":"RenameSymbol","reasoning":"r","affectedNodeIds":[],"renames":[]}"#;
        let record: OperationRecord = serde_json::from_str(legacy).unwrap();
        assert!(record.intents.is_empty());
    }

    #[test]
    fn operation_intent_record_round_trips_parameters_json() {
        let record = OperationIntentRecord {
            kind: "RenameSymbol".into(),
            parameters_json: r#"{"type":"renameSymbol","declarationId":"d","newName":"n"}"#.into(),
        };
        let json = serde_json::to_string(&record).unwrap();
        assert_eq!(serde_json::from_str::<OperationIntentRecord>(&json).unwrap(), record);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p strata-kernel operation_record_without_intents`
Expected: compile FAIL (`intents` / `OperationIntentRecord` not defined).

- [ ] **Step 3: Implement the model change** in `model.rs`:

```rust
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationIntentRecord {
    /// Intent kind, e.g. "RenameSymbol".
    pub kind: String,
    /// Canonical JSON of the typed intent parameters, embedded at publication
    /// so canonical history stays auditable without joining coordination tables.
    pub parameters_json: String,
}
```

and on `OperationRecord` (below `renames`):

```rust
    /// Typed per-intent parameters embedded at publication. Absent on records
    /// written before this field.
    #[serde(default)]
    pub intents: Vec<OperationIntentRecord>,
```

Export `OperationIntentRecord` from `lib.rs` next to `OperationRecord`'s existing re-export.

- [ ] **Step 4: Populate at publication.** In `publication.rs`, the `OperationRecord` literal at ~line 575 sits in `publish_claimed_inner`, which already holds the change set's `intents` (used by `intent_kind(&intents[0])` and `operation_renames(&graph, &intents)`). Confirm the element type at that call site and add, before the literal:

```rust
        let operation_intents = intents
            .iter()
            .map(|intent| {
                Ok(crate::OperationIntentRecord {
                    kind: intent_kind(intent).to_owned(),
                    parameters_json: serde_json::to_string(intent_parameters(intent))?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
```

where `intent_parameters` is whatever accessor yields the `IntentParameters` value on that element type (identity if the elements are `IntentParameters` — inline it). Then set `intents: operation_intents` in the literal. Fix every other `OperationRecord` literal the compiler reports with `intents: Vec::new()`.

- [ ] **Step 5: Old-record recovery fixture.** Add a test (in the file that owns storage round-trip tests, e.g. next to the existing recovery tests) that writes an `operations`-table value using the LEGACY JSON (no `intents` key, as in Step 1) through the storage layer's raw table API or a serialized fixture, reopens the store, and asserts recovery succeeds and `operation(generation)` returns the record with empty `intents`. This pins "old redb records stay readable" as a test, not an assumption.

- [ ] **Step 6: Run the full feature matrix**

Run: `cargo test -p strata-kernel && cargo test -p strata-kernel --features coordination-test-api && cargo test -p strata-kernel --features redb-spike-api`
Expected: PASS. Graph/source/delta/event digest expectations must be UNTOUCHED. If a test hashes newly-written serialized `OperationRecord` bytes (e.g. a whole-table digest), updating that expectation is legitimate — name each one in the commit message. Any other digest change: STOP, investigate.

- [ ] **Step 7: Commit**

```bash
git add -A crates/strata-kernel && git commit -m "feat(kernel): embed typed intent parameters in canonical OperationRecord"
```

---

### Task 2: `find_declarations` — kernel method + wire request + client/tool

**Files:**
- Modify: `crates/strata-kernel/src/kernel.rs` (new public method near `snapshot()`, ~line 319)
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs` (RequestAction ~line 100, ResponseResult ~line 233)
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/session.rs` (`execute_read` ~line 665)
- Modify: `packages/live-compare/src/protocol.ts`, `client.ts`, `tools.ts`
- Test: `crates/strata-kernel/tests/local_service.rs`; live-compare protocol test file

**Interfaces:**
- Consumes: `bridge::declaration_name` internals — but NOT per-candidate (see Step 3); `declaration_name_token(declaration)` (`provider.rs:719`) is the payload-only name derivation.
- Produces:
  - Rust: `Kernel::find_declarations(&self, name: &str, kind: Option<&str>) -> Result<Vec<DeclarationMatch>>` with `pub struct DeclarationMatch { pub node_id: String, pub kind: String, pub name: String, pub module_id: String }`, capped at `MAX_DECLARATION_MATCHES = 64` (error, fail-closed, if exceeded).
  - Wire: request `{"type":"find_declarations","name":...,"kind":...?}`, kind ∈ `interface|type-alias|class|function|variable`; result `{"type":"declarations","graphGeneration":...,"declarations":[{nodeId,kind,name,moduleId}]}`.
  - TS: `client.findDeclarations(name, kind?)`; tool `find_declarations`.
- Kind mapping (same as `packages/store/src/queries.ts:28-34`): interface→InterfaceDeclaration, type-alias→TypeAliasDeclaration, class→ClassDeclaration, function→FunctionDeclaration, variable→FirstStatement.
- **Failure semantics (review major 4):** a candidate whose name cannot be derived (malformed payload, missing/ambiguous name identifier) is SKIPPED, exactly like the SQLite `find_declarations` filter (`queries.ts:44-56` returns false on parse failure) — never an error for the whole query.
- **Complexity bound (review major 4):** ONE graph pass total. Take one snapshot; build one `parent_id → Vec<&NodeRecord (Identifier)>` map; then for each kind-matching candidate derive `declaration_name_token` from its payload and confirm against the prebuilt identifier map (text + offset, unique). Do NOT call `declaration_name`/`declaration_name_identifier` per candidate (each clones the full node set — O(declarations × nodes)). This needs a small `pub(crate)` refactor in `provider.rs` to expose `declaration_name_token` and the identifier-confirmation logic against a caller-supplied map; keep `declaration_name`'s existing behavior for its current callers.

- [ ] **Step 1: Write the failing Rust service test** in `crates/strata-kernel/tests/local_service.rs`, following that file's existing spawn/request helpers and fixture corpus:

```rust
#[test]
fn find_declarations_returns_named_interface_and_rejects_unknown_kind() {
    // spawn service exactly as the sibling tests do, then:
    // 1) {"type":"find_declarations","name":"User","kind":"interface"}
    //    -> exactly one match with nodeId/kind=="interface"/name=="User"/moduleId
    // 2) {"type":"find_declarations","name":"NoSuchSymbol"} -> empty list, ok
    // 3) kind "enum" -> protocol error response
    // 4) JSDoc regression: a fixture module whose declaration has a JSDoc
    //    @param tag identifier BEFORE the declaration name must still return
    //    the declaration name, not the JSDoc identifier (mirror the pitfall
    //    guarded in packages/store/src/queries.ts:38-56). Use a real corpus
    //    module containing JSDoc (examples/medium has JSDoc-bearing modules —
    //    the T03 criteria include jsdocReferencesRenamed) or add one to the
    //    test fixture the way the file builds snapshots.
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p strata-kernel --test local_service find_declarations`
Expected: FAIL (unknown request type).

- [ ] **Step 3: Implement kernel method** in `kernel.rs` (one pass, skip-on-unnameable):

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeclarationMatch {
    pub node_id: String,
    pub kind: String,      // product vocabulary: interface | type-alias | ...
    pub name: String,
    pub module_id: String,
}

pub const MAX_DECLARATION_MATCHES: usize = 64;

pub fn find_declarations(
    &self,
    name: &str,
    kind: Option<&str>,
) -> Result<Vec<DeclarationMatch>> {
    let graph = self.snapshot();
    let snapshot = graph.snapshot(); // ONE clone for the whole query
    let statement_kinds: Vec<(&str, &str)> = match kind {
        Some(k) => vec![(k, product_kind_to_statement_kind(k)?)],
        None => PRODUCT_KINDS.to_vec(),
    };
    // one pass: identifier children grouped by parent
    let mut identifiers: BTreeMap<&str, Vec<&NodeRecord>> = BTreeMap::new();
    for node in &snapshot.nodes {
        if node.kind == "Identifier" {
            if let Some(parent) = node.parent_id.as_deref() {
                identifiers.entry(parent).or_default().push(node);
            }
        }
    }
    let mut matches = Vec::new();
    for node in &snapshot.nodes {
        let Some((product_kind, _)) = statement_kinds
            .iter()
            .find(|(_, statement)| *statement == node.kind)
        else { continue };
        // payload-only token; SKIP candidates that cannot be named
        let Ok(Some(candidate_name)) =
            crate::bridge::confirmed_declaration_name(node, &identifiers)
        else { continue };
        if candidate_name != name { continue; }
        let Some(module_id) = node.parent_id.clone() else { continue };
        matches.push(DeclarationMatch {
            node_id: node.id.clone(), kind: (*product_kind).to_string(),
            name: candidate_name, module_id,
        });
        ensure!(matches.len() <= MAX_DECLARATION_MATCHES,
            "declaration matches exceed {MAX_DECLARATION_MATCHES} bound");
    }
    Ok(matches)
}
```

with `PRODUCT_KINDS`/`product_kind_to_statement_kind` as module-level items (the five-pair table above), and in `provider.rs` a new
`pub(crate) fn confirmed_declaration_name(declaration: &NodeRecord, identifiers_by_parent: &BTreeMap<&str, Vec<&NodeRecord>>) -> Result<Option<String>>`
that: calls `declaration_name_token(declaration)` (returns `Ok(None)` on any token-derivation error — skip semantics), then confirms exactly one Identifier child in `identifiers_by_parent[&declaration.id]` matches text+offset (`Ok(None)` if zero or ambiguous). Re-export via `bridge/mod.rs` beside `declaration_name`.

- [ ] **Step 4: Wire protocol + session.** `protocol.rs`: add to `RequestAction`:

```rust
    FindDeclarations {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        kind: Option<String>,
    },
```

add to `ResponseResult`:

```rust
    Declarations {
        graph_generation: WireU64,
        declarations: Vec<DeclarationSummary>,
    },
```

```rust
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DeclarationSummary {
    pub(super) node_id: String,
    pub(super) kind: String,
    pub(super) name: String,
    pub(super) module_id: String,
}
```

`session.rs` `execute_read` (classified read-only exactly like `InspectNodes`, including the client-side `isMutating` list):

```rust
            RequestAction::FindDeclarations { name, kind } => {
                // enforce the same 512-char bound the tool schema uses
                let matches = self.kernel.find_declarations(name, kind.as_deref())?;
                Ok(ResponseResult::Declarations {
                    graph_generation: WireU64::new(self.kernel.snapshot().generation()),
                    declarations: matches.into_iter().map(|m| DeclarationSummary {
                        node_id: m.node_id, kind: m.kind, name: m.name, module_id: m.module_id,
                    }).collect(),
                })
            }
```

- [ ] **Step 5: Run Rust tests**

Run: `cargo build -p strata-kernel && cargo test -p strata-kernel --test local_service find_declarations && cargo test -p strata-kernel`
Expected: PASS.

- [ ] **Step 6: TS protocol + client + tool (failing test first).** Protocol test:

```typescript
it("round-trips find_declarations request and declarations result", () => {
  const action = requestActionSchema.parse({
    type: "find_declarations", name: "User", kind: "interface"
  });
  expect(action).toEqual({ type: "find_declarations", name: "User", kind: "interface" });
  const result = responseResultSchema.parse({
    type: "declarations", graphGeneration: "3",
    declarations: [{ nodeId: "a", kind: "interface", name: "User", moduleId: "m" }]
  });
  expect(result.type).toBe("declarations");
});
```

Run live-compare tests → FAIL. Then `protocol.ts`:

```typescript
export const declarationKindFilterSchema = z.enum([
  "interface", "type-alias", "class", "function", "variable"
]);
// requestActionSchema union gains:
z.object({
  type: z.literal("find_declarations"),
  name: boundedText(512), // reuse the file's existing bounded-string helper/limit
  kind: declarationKindFilterSchema.optional()
}).strict(),
// responseResultSchema union gains:
z.object({
  type: z.literal("declarations"),
  graphGeneration: canonicalU64Schema,
  declarations: z.array(z.object({
    nodeId: opaqueIdSchema, kind: declarationKindFilterSchema,
    name: z.string().min(1), moduleId: opaqueIdSchema
  }).strict()).max(64)
}).strict(),
```

`client.ts`: add `"find_declarations"` to the `isMutating` read list and:

```typescript
  findDeclarations(
    name: string,
    kind?: z.infer<typeof declarationKindFilterSchema>,
    deadlineMs = DEFAULT_REQUEST_DEADLINE_MS
  ): Promise<CoordinationResult> {
    return this.request({ type: "find_declarations", name, ...(kind ? { kind } : {}) }, deadlineMs);
  }
```

`tools.ts`: schema + tool + `CoordinationClientApi.findDeclarations` + name lists (first position):

```typescript
  find_declarations: z.object({
    name: z.string().min(1).max(MAX_ID_CHARS),
    kind: z.enum(["interface", "type-alias", "class", "function", "variable"]).optional()
  }).strict(),
```

```typescript
    strictTool(
      "find_declarations",
      "Find declarations by exact name, optionally narrowed by kind (interface, type-alias, class, function, variable). Returns stable node IDs with their module. This is your discovery entry point: use it to locate the declaration to change, then inspect_nodes on the returned IDs before mutating.",
      COORDINATION_TOOL_INPUT_SCHEMAS.find_declarations,
      async ({ name, kind }) => textResult(await client.findDeclarations(name, kind))
    ),
```

- [ ] **Step 7: Run TS tests**

Run: `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare build && PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A crates/strata-kernel packages/live-compare && git commit -m "feat(kernel): find_declarations discovery request — minimal T03 product surface"
```

---

### Task 3: `read_operation` — auditable canonical history over the wire

**Files:**
- Modify: `crates/strata-kernel/src/storage.rs` (operation lookup by ID), `crates/strata-kernel/src/kernel.rs` (`operation_by_id`)
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs`, `session.rs`
- Modify: `packages/live-compare/src/protocol.ts`, `client.ts`, `tools.ts`
- Test: `crates/strata-kernel/tests/local_service.rs`; live-compare protocol test file

**Interfaces:**
- Consumes: Task 1's `OperationRecord.intents`; `Kernel::generation_digest(u64)` (`kernel.rs:327`).
- Produces:
  - Rust: `Kernel::operation_by_id(&self, operation_id: &str) -> Result<Option<(u64, OperationRecord)>>`.
  - Wire: request `{"type":"read_operation","operationId":...}`; result:

```json
{"type":"operation","graphGeneration":"4","operationId":"...","changeSetId":"...",
 "actor":"...","kind":"RenameSymbol","reasoning":"<original task context>",
 "affectedNodeIds":["..."],"renames":[{"nodeId":"...","fromName":"User","toName":"Account"}],
 "intents":[{"kind":"RenameSymbol","parametersJson":"{...}"}],
 "publicationDigest":"<generation digest>"}
```

  - TS: `client.readOperation(operationId)`; tool `read_operation`.

- [ ] **Step 1: Failing Rust test** in `local_service.rs`: full rename lifecycle through the daemon, capture `operationId` from the `change_set` result, then `read_operation` and assert: actor, reasoning == the `begin_change_set` reasoning, kind `RenameSymbol`, `affectedNodeIds.len() > 1`, renames `[{fromName:"User",toName:"Account",..}]`, `intents == [{kind:"RenameSymbol", parametersJson parsing to {declarationId,newName:"Account"} in the camelCase tagged form}]`, `publicationDigest` 64-hex; unknown operationId → error response.

Run: `cargo test -p strata-kernel --test local_service read_operation` → FAIL.

- [ ] **Step 2: Storage + kernel lookup.** In `storage.rs`, beside the per-generation operation read: iterate the `operations` table range, deserialize, return first record whose `operation_id` matches, with its generation key. Linear in history; gate 2 measures. `kernel.rs`:

```rust
pub fn operation_by_id(&self, operation_id: &str) -> Result<Option<(u64, OperationRecord)>> {
    self.store.operation_by_id(operation_id)
}
```

- [ ] **Step 3: Wire + session (read path).** `RequestAction::ReadOperation { operation_id: String }`; `ResponseResult::Operation { ... }` with the exact fields above (renames/intents as camelCase structs mirroring `OperationRename`/`OperationIntentRecord`). `execute_read` arm:

```rust
            RequestAction::ReadOperation { operation_id } => {
                let Some((generation, record)) = self.kernel.operation_by_id(operation_id)? else {
                    bail!("operation {operation_id} does not exist");
                };
                let digest = self.kernel.generation_digest(generation)?;
                Ok(ResponseResult::Operation { /* map fields 1:1 */ })
            }
```

Classify `read_operation` read-only in both Rust routing and the TS `isMutating` list.

- [ ] **Step 4: Run Rust test** → PASS.

- [ ] **Step 5: TS side** (failing schema test → implement, mirroring Task 2): `operation` result variant (`intents` max 16, `parametersJson` string), `read_operation` request, client method `readOperation(operationId)`, tool:

```typescript
    strictTool(
      "read_operation",
      "Read the canonical audit record of one committed operation by its operation ID: actor, the original task reasoning, typed intent parameters, affected node IDs, and rename transitions. Use the operation ID returned by advance_change_set or read_events.",
      COORDINATION_TOOL_INPUT_SCHEMAS.read_operation,
      async ({ operation_id }) => textResult(await client.readOperation(operation_id))
    ),
```

Run live-compare build+test → PASS.

- [ ] **Step 6: Commit**

```bash
git add -A crates/strata-kernel packages/live-compare && git commit -m "feat(kernel): read_operation audit request — params and reasoning readable over the wire"
```

---

### Task 4: `export-snapshot` offline oracle with atomic-state projection

**Files:**
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/main.rs` (new subcommand)
- Modify: `crates/strata-kernel/src/kernel.rs` / `storage.rs` only if a needed read accessor is missing (prefer existing `test_*` accessors gated `redb-spike-api`)
- Test: `crates/strata-kernel/tests/local_service_recovery.rs` (or new `tests/export_snapshot.rs`)

**Interfaces:**
- Produces: `strata-kernel-service export-snapshot --db PATH --out PATH [--state-out PATH]`.
  - `--out`: canonical `GraphSnapshot` JSON (camelCase; generation is a JSON number — the harness normalizes, see Shared conventions). Stdout: `{"generation":"<u64>","digest":"<64-hex>"}`.
  - `--state-out` (compiled only under `redb-spike-api`): the **atomic-state projection** used as the crash oracle (review blocker 8) — a canonical JSON object containing, at minimum: ordered operation records, delta count and per-generation digests, graph event records, ticket records, change-set records (id/state/actor/reasoning/intent ids), intent records, idempotency keys with their generations, publication attempts, fence/resource-clock state, scheduler revisions, and table counts. Reuse the SAME accessors row 8's `CanonicalFinalState::capture` uses (`tests/support/full_key_free.rs`, `full_key_free_acceptance.rs:309-389`) — move/share that capture logic into a `redb-spike-api`-gated library function (e.g. `Kernel::test_atomic_state_projection()`) rather than duplicating it, then have BOTH row 8 and this subcommand call it.
- Consumes: `Kernel::open(path)` (`kernel.rs:183`) — the normal recovery path (digest-verified).

- [ ] **Step 1: Failing test:** seed a service, run one rename, stop the daemon, run `export-snapshot`: exit 0; out-file parses; payloads contain `Account`; stdout digest equals a fresh `Kernel::open`'s digest; with `--state-out` (feature build) the projection file contains exactly one operation with kind `RenameSymbol` and one committed change set; nonexistent db → non-zero exit.

Run: `cargo test -p strata-kernel --features redb-spike-api --test local_service_recovery export_snapshot` → FAIL.

- [ ] **Step 2: Implement** the subcommand (open via the same no-bridge open the recovery tests use; export performs no validation):

```rust
        Some("export-snapshot") => export_snapshot(&remaining),
```

```rust
fn export_snapshot(arguments: &[OsString]) -> Result<()> {
    let values = parse_named(arguments)?;
    reject_unknown(&values, &["--db", "--out", "--state-out"])?;
    let db_path = required_path(&values, "--db")?;
    let out_path = required_path(&values, "--out")?;
    anyhow::ensure!(db_path.exists(), "database {} does not exist", db_path.display());
    let (kernel, _report) = strata_kernel::Kernel::open(&db_path)?;
    let graph = kernel.snapshot();
    std::fs::write(&out_path, serde_json::to_vec_pretty(&graph.snapshot())?)?;
    #[cfg(feature = "redb-spike-api")]
    if let Some(state_out) = values.get("--state-out") {
        std::fs::write(
            std::path::PathBuf::from(state_out),
            serde_json::to_vec_pretty(&kernel.test_atomic_state_projection()?)?,
        )?;
    }
    #[cfg(not(feature = "redb-spike-api"))]
    anyhow::ensure!(values.get("--state-out").is_none(),
        "--state-out requires a redb-spike-api build");
    println!("{}", serde_json::json!({
        "generation": graph.generation().to_string(),
        "digest": graph.digest(),
    }));
    Ok(())
}
```

The `test_atomic_state_projection` extraction refactors row 8's capture into the library under `redb-spike-api`; row 8's tests keep passing against the shared function. Update `print_help`.

- [ ] **Step 3: Run** the feature matrix (all three combos) → PASS. **Step 4: Commit**

```bash
git add -A crates/strata-kernel && git commit -m "feat(kernel): export-snapshot oracle with redb-spike-api atomic-state projection"
```

---

### Task 5: Service harness lifecycle — preserve/reuse the redb, seed bound

**Files:**
- Modify: `packages/live-compare/src/service.ts` (`startKernelService`, `stop`)
- Modify: `packages/live-compare/src/tasks.ts:495-506` + design doc D1 wording
- Modify: `packages/live-compare/src/client.ts` (optional idempotency-key override for the crash suite)
- Test: live-compare test files (service lifecycle + conversion helpers)

**Interfaces (review blocker 1):**
- `startKernelService(corpusRoot, options?)` gains: `directory?: string` (reuse an existing service directory — when its `kernel.redb` exists the daemon takes the recovery branch and `--snapshot` is ignored), `binaryPath?`, `extraArgs?: string[]` (for Task 7's failpoint flags), and `stop(options?: { preserveDirectory?: boolean })`. Default behavior unchanged (fresh tmpdir, full cleanup).
- `boundedGenerationNumber(generation: string): number` (fail-closed safe-integer parse) used by `createQualifiedKernelSnapshot`; `canonicalGenerationString(value: number): string` (inverse, rejects unsafe integers) for parsing Rust exports.
- `CoordinationClient.request(action, deadlineMs, options?: { idempotencyKey?: string })` — exposes the key so the crash suite can REPLAY the exact request identity and assert the cached journal response (review blocker 8). Mutating retries keep generating a fresh random key by default.

- [ ] **Step 1: Failing tests:** (a) `stop({ preserveDirectory: true })` leaves `kernel.redb` on disk; a second `startKernelService(corpus, { directory })` against it reaches readiness (recovery branch) and `inspect_nodes` serves the previous generation; (b) `boundedGenerationNumber("9007199254740993")` throws; `boundedGenerationNumber("0")` → 0; `canonicalGenerationString(3)` → `"3"`; (c) a mutating request with an explicit `idempotencyKey` sent twice returns byte-identical results.

- [ ] **Step 2: Implement.**

```typescript
export function boundedGenerationNumber(generation: string): number {
  const value = Number(generation);
  if (!Number.isSafeInteger(value) || String(value) !== generation) {
    throw new Error(`snapshot generation ${generation} exceeds the safe seeding bound`);
  }
  return value;
}
export function canonicalGenerationString(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`generation ${value} is not a canonical unsigned safe integer`);
  }
  return String(value);
}
```

`service.ts`: honor `options.directory` (skip snapshot write + seed when `kernel.redb` already exists — still pass `--snapshot` pointing at the existing file, the daemon ignores it on the recovery branch; write it only when absent), append `options.extraArgs` to the spawn argv, and:

```typescript
    async stop(stopOptions?: { preserveDirectory?: boolean }) {
      if (child.exitCode === null) child.kill("SIGTERM");
      await new Promise<void>((resolveStop) => child.once("exit", () => resolveStop()));
      if (!stopOptions?.preserveDirectory) rmSync(directory, { recursive: true, force: true });
    }
```

`client.ts`: thread `options?.idempotencyKey` through `request` for mutating actions (default stays `randomUUID()`), and amend the design doc's D1 hardening sentence (fail-closed bound instead of string wire format).

- [ ] **Step 3: Run** live-compare build+test → PASS. **Commit:**

```bash
git add -A packages/live-compare docs/superpowers/specs && git commit -m "feat(live-compare): service dir reuse + preserve, fail-closed generation bounds, idempotency-key override"
```

---

### Task 6: Gate-1 parity harness (both arms, six assertions)

**Files:**
- Create: `packages/live-compare/src/gate1.ts`
- Test: `packages/live-compare/test/gate1Parity.test.ts` (follow the package's test layout)
- Modify: root `package.json` (`kernel:gate1:test`, folded into `kernel:full-key-free:test`)

**Interfaces:**
- Consumes: Tasks 2–5; `@strata-code/store` product flow (`openDb(":memory:")`, `insertNodes`, `insertReferences`, `find_declarations`, `begin`, `rename_symbol`); `commit` + `validate` from `@strata-code/verify` (the T03-registered gate — tsc-only, exactly the `packages/cli/src/commands/t03.ts` product flow); `exportSnapshot` from `packages/kernel-bridge/src/snapshot.ts`; the Shared conventions block (corpus builder, generation normalization, audit projection).
- Produces (for Tasks 7–8):

```typescript
export type Gate1Stage = "after_discovery" | "after_begin" | "after_add_intent" | "after_submit";
export interface SqliteArmOutcome { snapshot: KernelSnapshotV1; audit: NormalizedAudit; renderedRoot: string; }
export interface KernelArmOutcome {
  snapshot: KernelSnapshotV1; audit: NormalizedAudit; rawAffectedNodeIds: string[];
  renderedRoot: string; directory: string; operationId: string; changeSetId: string;
}
export interface NormalizedAudit {
  actor: string; taskContext: string; operationClass: "RenameSymbol";
  declarationId: string; oldName: string; newName: string; renamedIdentifierIds: string[];
}
export function buildCorpusInputs(corpusRoot: string): { path: string; text: string }[]; // corpus-relative POSIX paths, same walk as createQualifiedKernelSnapshot
export function runSqliteArm(corpusRoot: string): Promise<SqliteArmOutcome>;
export function runKernelArmT03(corpusRoot: string, options?: {
  directory?: string; extraArgs?: string[];
  onStage?: (stage: Gate1Stage, ctx: { client: CoordinationClient; changeSetId?: string; declarationId?: string }) => Promise<void>;
  stopAfterSubmit?: boolean;   // Task 7 crash choreography: prep only, clean stop, no advance
  preserveDirectory?: boolean;
}): Promise<KernelArmOutcome>;
export function renderSnapshotToTree(snapshot: KernelSnapshotV1, corpusRoot: string, outDir: string): string;
export function exportKernelSnapshot(directory: string, options?: { stateOut?: string }): { snapshot: KernelSnapshotV1; generation: string; digest: string };
export function tscAndVitestGreen(treeRoot: string): Promise<boolean>; // reuse @strata-code/verify's corpusRun runner (export it if not exported); vitest runs the corpus's own test files identically on both trees — a HARNESS check, not a commit gate
```

- [ ] **Step 1: Write the failing parity test** (gate 1's acceptance shape, all six assertions):

```typescript
describe("gate 1: key-free semantic parity (kernel vs SQLite product arm)", () => {
  it("produces equivalent nodes, references, rendered TS, tsc+vitest, criteria, and audit", async () => {
    const corpus = resolve(repoRoot, "examples/medium");
    const sqlite = await runSqliteArm(corpus);
    const kernel = await runKernelArmT03(corpus);
    // 1+2: canonical node/reference byte equality (same corpus-relative ingest => same IDs;
    //      compare Module records explicitly too — payloads must be identical, no blanking on either side)
    expect(canonicalJson(kernel.snapshot.nodes)).toBe(canonicalJson(sqlite.snapshot.nodes));
    expect(canonicalJson(kernel.snapshot.references)).toBe(canonicalJson(sqlite.snapshot.references));
    // 3: rendered corpus byte equality, module by module
    expect(treeDigest(kernel.renderedRoot)).toBe(treeDigest(sqlite.renderedRoot));
    // 4: tsc --noEmit + vitest green on BOTH rendered corpora (harness check, identical invocation)
    expect(await tscAndVitestGreen(kernel.renderedRoot)).toBe(true);
    expect(await tscAndVitestGreen(sqlite.renderedRoot)).toBe(true);
    // 5: T03 text criteria pass on both
    expect(evaluateT03TextCriteriaOnTree(kernel.renderedRoot)).toMatchObject(ALL_TRUE);
    expect(evaluateT03TextCriteriaOnTree(sqlite.renderedRoot)).toMatchObject(ALL_TRUE);
    // 6: normalized audit projection equality (Shared conventions) + kernel superset property
    expect(kernel.audit).toEqual({ ...sqlite.audit, actor: kernel.audit.actor });
    expect(kernel.audit.renamedIdentifierIds).toEqual(sqlite.audit.renamedIdentifierIds);
    for (const id of kernel.audit.renamedIdentifierIds) {
      expect(kernel.rawAffectedNodeIds).toContain(id);
    }
  }, 600_000);
});
```

(`actor` differs by construction — SQLite arm's transaction actor vs kernel clientId; assert both are non-empty and record the mapping in the harness. `taskContext` must be the same string: pass the same task prompt to `begin(db, prompt)` and `beginChangeSet(prompt)`.)

- [ ] **Step 2: Run to verify failure**: `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test -- gate1` → FAIL (drivers missing).

- [ ] **Step 3: Implement `gate1.ts`.**
- `buildCorpusInputs`: the exact walk `createQualifiedKernelSnapshot` uses (corpus-relative POSIX paths) — refactor that function to call this builder so there is literally one input domain.
- `runSqliteArm`: `ingestBatch(buildCorpusInputs(corpus))` → `openDb(":memory:")` → insert → `find_declarations({name:"User",kind:"interface"})` (assert exactly 1) → `begin(db, TASK_PROMPT)` → `rename_symbol` → `commit(db, tx)` (assert ok) → post-commit `validate` on a throwaway tx (assert clean) → `exportSnapshot(db)` → audit: read the `operations` row (snake_case params, affected Identifier IDs) + transaction prompt → `NormalizedAudit` → render tree.
- `runKernelArmT03`: `startKernelService(corpus, {...})` (daemon stays tsc_only — the T03-registered profile) → `findDeclarations("User","interface")` (assert exactly 1; assert nodeId === the SQLite arm's declaration id) → `beginChangeSet(TASK_PROMPT)` → `addIntent(rename→"Account")` → `submitChangeSet` → `advanceChangeSet` (assert `committed`, capture operationId) → `readOperation` → `NormalizedAudit` (renamedIdentifierIds = Identifier-kind members of affectedNodeIds, resolved against the export) → `stop({ preserveDirectory: true })` → `exportKernelSnapshot(directory)` (normalize generation via `canonicalGenerationString`) → render tree → cleanup respecting `preserveDirectory`.
- Deadlines: ≥120 s submit, ≥180 s advance.
- Build order: `pnpm --filter @strata-code/kernel-bridge build && pnpm --filter @strata-code/live-compare build && cargo build -p strata-kernel`.

- [ ] **Step 4: Run to verify pass** (600 s). If parity fails on payload bytes: STOP and diagnose; a fix that weakens kernel semantics is falsifier 1 — log a decision instead.

- [ ] **Step 5: Wire scripts.** Root `package.json`:

```json
"kernel:gate1:test": "pnpm --filter @strata-code/kernel-bridge build && pnpm --filter @strata-code/live-compare build && cargo build -p strata-kernel && cargo build -p strata-kernel --features redb-spike-api && pnpm --filter @strata-code/live-compare test -- gate1",
```

append `&& pnpm kernel:gate1:test` to `kernel:full-key-free:test`. The parity test runs against the DEFAULT-features binary; only the crash suite (Task 7) uses the `redb-spike-api` binary — parameterize via env `STRATA_KERNEL_SERVICE_BIN` with the default binary as fallback.

- [ ] **Step 6: Commit**

```bash
git add -A packages/live-compare package.json && git commit -m "test(gate1): key-free semantic parity harness — kernel arm vs SQLite product arm"
```

---

### Task 7: Crash injection reaching the advance publication, full-state oracle

**Files:**
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/main.rs` + `session.rs` (accept `--test-publish-failpoint <camelCase boundary>` under `redb-spike-api`; when set, the advance path publishes via `execute_claimed_with_failpoint` (`coordination/publication.rs:118`) instead of `execute_claimed` — same claim, same arguments, failpoint only)
- Create: `packages/live-compare/test/gate1Crash.test.ts`

**Interfaces:**
- Consumes: Task 6's `runKernelArmT03(corpus, { stopAfterSubmit: true, preserveDirectory: true })`, `startKernelService(corpus, { directory, extraArgs })`, `exportKernelSnapshot(dir, { stateOut })`, client `advanceChangeSet` with explicit `idempotencyKey`.
- Produces: daemon flag `--test-publish-failpoint beforeRedbTransaction|insideRedbTransaction|afterRedbCommitBeforeMemoryPublish|afterMemoryPublish` (exact `PublishFailpoint::boundary_name` strings, `kernel.rs:69-81`); `--test-failpoint` (existing five journal stages, `coordination-test-api`) reused unchanged.

**Choreography (review blocker 7):** the failpoints are global per-mutating-request, so the T03 prep must happen WITHOUT them:

1. `runKernelArmT03(corpus, { stopAfterSubmit: true, preserveDirectory: true })` — begin/add/submit committed to durable state, daemon stopped cleanly, redb preserved. Record `changeSetId` and the declaration id.
2. Restart the SAME directory with the failpoint flag (`startKernelService(corpus, { directory, extraArgs: [flag, value] })`, `redb-spike-api` binary via `STRATA_KERNEL_SERVICE_BIN`).
3. Issue ONLY `advance_change_set` with a recorded `idempotencyKey`; expect the daemon to abort (client sees `connection_lost`/`request_timeout`; assert the child exited abnormally).
4. Restart the same directory WITHOUT failpoints; run the oracle.

- [ ] **Step 1: Failing TS test** — for each of the nine injection points (5 journal stages × the advance request only, 4 publish boundaries):

```typescript
for (const stage of ["after_pending","after_effect","after_prepared","after_follow_up","after_completed"])
  test(`journal ${stage} at advance`, () => runCrashCase({ flag: "--test-failpoint", value: stage }), 600_000);
for (const boundary of ["beforeRedbTransaction","insideRedbTransaction","afterRedbCommitBeforeMemoryPublish","afterMemoryPublish"])
  test(`publish ${boundary}`, () => runCrashCase({ flag: "--test-publish-failpoint", value: boundary }), 600_000);
```

`runCrashCase` implements the choreography, then the oracle:

```typescript
  const after = await reopenAndExport(directory, { stateOut: true });
  // graph: exactly complete-old XOR complete-new
  expect([canonicalJson(preAdvanceExport), canonicalJson(referenceNewExport)])
    .toContain(canonicalJson(after.snapshot));
  // atomic-state projection: equals the reference projection for whichever side the graph landed on
  // (reference projections captured once per suite from an uninjected prep-only run and an
  //  uninjected completed run on separate directories)
  expect(normalizeProjection(after.state)).toEqual(
    landedOld ? normalizeProjection(prepOnlyState) : normalizeProjection(completedState));
  // exact idempotent replay: re-send advance_change_set with the SAME idempotencyKey;
  // if landedNew, the journal must return the cached committed response (same operationId);
  // if landedOld, the advance completes now and the graph must equal referenceNewExport byte-for-byte.
```

`normalizeProjection` strips only fields that legitimately differ across runs (service epoch, wall-clock-free tick counters if present, socket-scoped ids) — every stripped field must be listed in one place with a comment; history, tickets, change sets, events, idempotency records, attempts, clocks, and counts all compare.

- [ ] **Step 2: Run** → FAIL (flag unknown). **Step 3: implement the flag** (feature-gated arg in `main.rs` mirroring the existing `--test-failpoint` block, threading a `PublishFailpoint` into `ServiceConfig` and into the advance path's publish call). **Step 4: run** → PASS (nine daemon lifecycles ×2 restarts; serial).

- [ ] **Step 5: Commit**

```bash
git add -A crates/strata-kernel packages/live-compare && git commit -m "test(gate1): crash injection reaching advance publication, full atomic-state oracle"
```

---

### Task 8: Second-client intrusion — stage-specific FIFO oracles

**Files:**
- Create: `packages/live-compare/test/gate1Intrusion.test.ts`
- Modify (only if needed): `packages/live-compare/src/gate1.ts` (the `onStage` hook from Task 6)

**Interfaces:**
- Consumes: Task 6 drivers; a second `CoordinationClient` (distinct `clientId`).
- **Pre-registered disjoint target (review blocker 9):** the disjoint intrusion renames the `formatTimestamp` function declaration (present in `examples/medium`; used by the Phase-6 D/G scenarios) to `formatTimestampAudit` — discovered via `find_declarations("formatTimestamp","function")`, asserted to live in a different module than `User`. If that name is absent from the current corpus, pick at plan-execution time ONE named function declaration in a different module, record it in the test as a constant with a comment, and never discover it dynamically.

**Stage-specific expectations (review blocker 9 — FIFO is the contract, either-order is a bug; pre-submit oracle corrected 2026-07-18 after the probe falsified the review's mechanism claim — see decisions.md and design D8):**

- **after_discovery / after_begin / after_add_intent** (A holds no submitted scope): overlapping B (rename `User`→`Client`) may submit, advance, and commit FIRST. A then submits/advances and MUST publish deterministically **without** a `needs_decision` round-trip (scope is pinned at submit — A's submit-time analysis already sees the post-B graph): assert A's terminal state is `published` with `renamedSymbols` empty, a two-operation sequential history (B `User`→`Client` at generation N, A `Client`→`Account` at N+1, both auditable via `read_operation`), never a silent overwrite. Final: rendered tree green, text criteria pass with the final name `Account`.
- **after_submit** (A is queued/ready): B's overlapping submission must NOT pass A (`scheduler.rs:277` older-overlap rule). A's advance commits; B's advance then yields `needs_decision` (fresh state naming `User`→`Account`) or a fresh re-analysis ordering B strictly after A. Assert A's operation is the earlier generation and B never silently overwrote.
- **disjoint at every stage:** B's disjoint rename commits independently regardless of A's stage; both land; final export contains both renames; tree green.
- **concurrent advances** (A and B overlapping, both submitted, fired with `Promise.allSettled`): derive the REQUIRED winner from the durable queue order (B submitted after A ⇒ A must win; assert via each arm's result states and `read_operation` generations). Do not accept "either serial outcome".
- **ownership:** B calling `advance_change_set`/`cancel_change_set` on A's change-set id gets an authorization error.
- **every terminal state auditable:** each committed operation has a `read_operation` record whose projection matches its arm's intent; final `export-snapshot` digest equals the stdout digest.

- [ ] **Step 1: Write the failing suite** with the exact cases above (each case ≤600 s; suite serial). **Step 2: Run** → FAIL (hook wiring). **Step 3: implement.** **Step 4: run** → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/live-compare && git commit -m "test(gate1): second-client intrusion with stage-specific FIFO oracles"
```

---

### Task 8b: Kernel fix — poll-driven starvation of the older validating ticket (added 2026-07-19; see decisions.md entry of that date and `2026-07-19-concurrent-advance-fifo-review-codex.md`)

**Defect (verified):** a queued `advance_change_set` runs `reconsider_tickets`; every blocked scheduling pass increments the skipped ticket's `age_rounds`; `CoordinationTicket` derives `PartialEq` including `age_rounds`, so the age-only diff is a ticket update that bumps the scheduler revision (`planner.rs:276-287`); the older claim's publication demands exact revision + whole-scheduler equality and exhausts its 3 optimistic attempts (`publication.rs:695-727`); the daemon's `Err(_)` catch-all then fabricates `candidate_validation_failed` and cancels the claim (`session.rs:652-682`), letting the younger overlapping ticket win. This violates the kernel spec's FIFO/anti-starvation contract (design spec lines 151-176).

**Files:**
- Modify: `crates/strata-kernel/src/coordination/planner.rs` (fix a)
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/session.rs` (fix b)
- Test: `crates/strata-kernel/tests/coordination_optimistic.rs` (deterministic regression)

**Fix (a) — age-only passes must be observationally idempotent:** a reconsideration pass whose lifecycle diff consists ONLY of `age_rounds`-only ticket updates (no offer, no scope, no state, no claim, no event, no change-set change) must not persist those diffs and must not advance the scheduler revision. `plan_readiness` already receives the transition cause (currently discarded, `let _ = snapshot.cause;`) — use it and/or classify the diff set. Aging MUST still occur on real scheduling transitions (submission, publication, cancellation, expiry, scope requeue) so anti-starvation priority ordering keeps working; do not remove aging wholesale.

**Fix (b) — the daemon must not mislabel scheduler contention:** in the advance publication-outcome handling, match `CoordinationError::OptimisticRetryExhausted` (downcast) BEFORE the catch-all: no `validation_failed` audit event, no fabricated `candidate_validation_failed` diagnostic, no `CancelChangeSet` follow-up. The operation must remain completable — either retry publication internally against the fresh scheduler state or return the current non-terminal change-set state so the client's advance polling loop completes it. Investigate which is minimal and correct given how `advance` treats an already-claimed change set; genuine candidate/tsc validation failures keep the existing path.

**Deterministic regression (TDD, feature `coordination-test-api`):** using the existing `before_final_check`-style test hooks (`tests/coordination_optimistic.rs:1392-1439` pattern): claim older A, queue overlapping younger B, invoke `reconsider_tickets` repeatedly from A's before-final-check hook (more times than `MAX_OPTIMISTIC_RETRIES`), then assert: (i) the age-only passes do not change the scheduler revision; (ii) A publishes successfully; (iii) B subsequently yields `NeedsDecision`, never a publication. Write it first, watch it fail via `OptimisticRetryExhausted`, then implement (a); extend the daemon-layer coverage for (b) at the session/protocol test layer if one exists, else document why the TS concurrent case is the (b) coverage.

- [ ] **Step 1: failing regression test.** **Step 2: implement (a).** **Step 3: implement (b).** **Step 4: full feature matrix** — `cargo test -p strata-kernel`, `--features coordination-test-api`, `--features redb-spike-api` — all green, plus `PATH=/opt/homebrew/bin:$PATH pnpm kernel:full-key-free:test` (existing suites must stay green unmodified).

- [ ] **Step 5: Commit**

```bash
git add -A crates/strata-kernel && git commit -m "fix(kernel): age-only reconsideration passes no longer starve older validating claims; OptimisticRetryExhausted is not a validation failure"
```

---

### Task 9: Full green run, decision log, roadmap check-off, push

**Files:**
- Modify: `decisions.md` (new top entry), `docs/product-roadmap.md` (slice A: gate 1 status), design doc (any execution-forced amendments, each named)

- [ ] **Step 1: Full verification (foreground, chunked):**

```bash
PATH=/opt/homebrew/bin:$PATH pnpm -r build
PATH=/opt/homebrew/bin:$PATH pnpm kernel:full-key-free:test   # includes kernel:gate1:test
PATH=/opt/homebrew/bin:$PATH pnpm -r test
```

Expected: all PASS. Any failure: fix before logging anything as done. If a fix would require weakening coordination semantics — STOP, decisions.md entry, falsifier 1.

- [ ] **Step 2: decisions.md entry** (top): gate 1 result; the five surface additions; every adaptation execution forced (Task 1 digest-expectation changes, Task 7 threading outcome, Task 8 disjoint-target choice); what stays open (gates 2–5, gate 2 next).

- [ ] **Step 3: Roadmap:** under Iteration 6 slice A, record "gate 1 PASS (key-free) — evidence: `packages/live-compare/test/gate1*.test.ts`, decisions.md <date>" without checking the slice-A box.

- [ ] **Step 4: Commit + push**

```bash
git add -A && git commit -m "docs: gate 1 (key-free semantic parity) recorded — slice A continues at gate 2" && git push
```
