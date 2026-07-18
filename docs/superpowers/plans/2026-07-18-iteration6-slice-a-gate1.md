# Iteration 6 slice A — gate 1 (key-free semantic parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land gate 1 of the convergence slice: a fresh-store, rename-only, N=1 T03 flow on the Rust kernel (redb sole durable authority, full coordination semantics) that is semantically parity-checked against the SQLite product arm, survives crash injection at every durable boundary, and is unperturbed by a second client at every nominal "solo" stage.

**Architecture:** Extend the daemon's wire protocol with the minimal T03 product surface (`find_declarations`, `read_operation`), make the canonical `OperationRecord` self-contained (per-intent typed parameters), unlock the already-built behavioral (tsc+vitest) validation profile, add an offline `export-snapshot` oracle, then drive both arms from a key-free vitest parity/crash/intrusion suite in `packages/live-compare`.

**Tech Stack:** Rust (redb, serde), TypeScript (pnpm workspaces, vitest, zod, better-sqlite3 in-memory only), existing `@strata-code/{ingest,store,render,verify}` packages.

**Design:** `docs/superpowers/specs/2026-07-18-iteration6-slice-a-convergence-design.md` (D1–D9). Acceptance frame: gate 1 of `docs/superpowers/specs/2026-07-18-kernel-convergence-review-codex.md` §4.

## Global Constraints

- **No solo bypass:** no change may skip scope inference, fresh analysis, validation binding, reservations, or fenced publication. If a task cannot pass otherwise, STOP and log a decision (falsifier 1).
- **No persisted SQLite in the kernel arm:** better-sqlite3 only via `openDb(":memory:")`.
- **Key-free:** no model calls, no API keys anywhere in this plan.
- **Green claims** only via `PATH=/opt/homebrew/bin:$PATH pnpm kernel:full-key-free:test` plus `pnpm -r test` (repo memory: Homebrew node ABI; bare `cargo test` skips feature-gated suites).
- **Deadlines:** harness requests must budget ≥30.1 s remaining for `submit_change_set`, ≥60.1 s for `advance_change_set` (`session.rs:27-29`).
- **Long commands:** this environment's supervisor can kill background tasks; run test suites foreground with explicit generous timeouts, not detached, except where a step says otherwise.
- Commit after every task; push after every 2–3 tasks.

---

### Task 1: Self-contained canonical operation record (`OperationRecord.intents`)

**Files:**
- Modify: `crates/strata-kernel/src/model.rs` (after `OperationRename`, ~line 76)
- Modify: `crates/strata-kernel/src/coordination/publication.rs:575-587` (operation construction)
- Test: `crates/strata-kernel/src/model.rs` (new `#[cfg(test)] mod tests`)

**Interfaces:**
- Produces: `pub struct OperationIntentRecord { pub kind: String, pub parameters_json: String }`; `OperationRecord` gains `#[serde(default)] pub intents: Vec<OperationIntentRecord>`. Tasks 3 and 7 rely on these exact names.

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

- [ ] **Step 4: Populate at publication.** In `publication.rs`, the `OperationRecord` literal at ~line 575 sits in `publish_claimed_inner`, which already holds the change set's `intents` (used by `intent_kind(&intents[0])` and `operation_renames(&graph, &intents)`). Confirm the element type at that call site (it exposes the typed parameters used by `intent_kind`) and add, before the literal:

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

where `intent_parameters` is whatever accessor yields the `IntentParameters` value on that element type (if the elements *are* `IntentParameters`, it is the identity — inline it). Then set `intents: operation_intents` in the literal. Fix every other `OperationRecord` literal the compiler reports (tests/fixtures) with `intents: Vec::new()`.

- [ ] **Step 5: Run tests**

Run: `cargo test -p strata-kernel && cargo test -p strata-kernel --features coordination-test-api`
Expected: PASS (existing digest tests may fail if any fixture hashes serialized `OperationRecord` JSON — if a digest test fails, that is the serde `default` field changing *serialization* output; verify old records still deserialize, update only fixture expectations that encode the new canonical serialization, and say so in the commit message).

- [ ] **Step 6: Commit**

```bash
git add -A crates/strata-kernel && git commit -m "feat(kernel): embed typed intent parameters in canonical OperationRecord"
```

---

### Task 2: `find_declarations` — kernel method + wire request + client/tool

**Files:**
- Modify: `crates/strata-kernel/src/kernel.rs` (new public method near `snapshot()`, ~line 319)
- Modify: `crates/strata-kernel/src/bridge/provider.rs` (make one helper `pub(crate)`; it already exposes `declaration_name` via `bridge/mod.rs:13`)
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs` (RequestAction ~line 100, ResponseResult ~line 233)
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/session.rs` (`execute_read` ~line 665)
- Modify: `packages/live-compare/src/protocol.ts` (requestActionSchema ~line 102, responseResultSchema ~line 234)
- Modify: `packages/live-compare/src/client.ts` (read-only classification ~line 60, method ~line 255)
- Modify: `packages/live-compare/src/tools.ts` (schema + tool + name lists)
- Test: `crates/strata-kernel/tests/local_service.rs` (new test alongside existing spawn tests); `packages/live-compare/test/` (schema round-trip, colocated with existing protocol tests — follow the existing test file layout in that package)

**Interfaces:**
- Consumes: `bridge::declaration_name(graph, node)` (`provider.rs:667`), `is_declaration` semantics (kind ends with `Declaration` or is `FirstStatement`/`VariableStatement`).
- Produces:
  - Rust: `Kernel::find_declarations(&self, name: &str, kind: Option<&str>) -> Result<Vec<DeclarationMatch>>` with `pub struct DeclarationMatch { pub node_id: String, pub kind: String, pub name: String, pub module_id: String }`, result capped at `MAX_DECLARATION_MATCHES = 64` (error, fail-closed, if exceeded).
  - Wire: request `{"type":"find_declarations","name":...,"kind":...?}`, kind ∈ `interface|type-alias|class|function|variable` (reject others); result `{"type":"declarations","graphGeneration":...,"declarations":[{nodeId,kind,name,moduleId}]}` where `kind` echoes the product vocabulary.
  - TS: `client.findDeclarations(name: string, kind?: DeclarationKindFilter)`; tool `find_declarations`.
- Kind mapping (same as `packages/store/src/queries.ts:28-34`): interface→InterfaceDeclaration, type-alias→TypeAliasDeclaration, class→ClassDeclaration, function→FunctionDeclaration, variable→FirstStatement.

- [ ] **Step 1: Write the failing Rust service test** in `crates/strata-kernel/tests/local_service.rs`, following that file's existing spawn/request helpers (same fixture corpus the neighboring tests use):

```rust
#[test]
fn find_declarations_returns_named_interface_and_rejects_unknown_kind() {
    // spawn service exactly as the sibling tests do, then:
    let found = request_json(&socket, json!({
        "type": "find_declarations", "name": "User", "kind": "interface"
    }));
    // exactly one match; fields nodeId/kind/name/moduleId present; kind == "interface"
    // name mismatch returns an empty list, not an error:
    let none = request_json(&socket, json!({
        "type": "find_declarations", "name": "NoSuchSymbol"
    }));
    // and kind "enum" (unsupported vocabulary) is a protocol error response
}
```

(Adapt to the file's actual helper names — it already builds `LocalServiceRequest` frames; assert on the `declarations` result shape defined above. The fixture must contain an interface named `User`; if the file's standing fixture does not, add a minimal two-module fixture the way its helpers construct snapshots.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p strata-kernel --test local_service find_declarations`
Expected: FAIL (unknown request type / schema rejection).

- [ ] **Step 3: Implement kernel method** in `kernel.rs`:

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
    let statement_kinds: Vec<(&str, &str)> = match kind {
        Some(k) => vec![(k, product_kind_to_statement_kind(k)?)],
        None => PRODUCT_KINDS.to_vec(),
    };
    let mut matches = Vec::new();
    for node in graph.snapshot().nodes {
        let Some((product_kind, _)) = statement_kinds
            .iter()
            .find(|(_, statement)| *statement == node.kind)
        else { continue };
        if crate::bridge::declaration_name(&graph, &node)?.as_deref() != Some(name) {
            continue;
        }
        let module_id = node.parent_id.clone()
            .with_context(|| format!("declaration {} has no parent module", node.id))?;
        matches.push(DeclarationMatch {
            node_id: node.id, kind: (*product_kind).to_string(),
            name: name.to_owned(), module_id,
        });
        ensure!(matches.len() <= MAX_DECLARATION_MATCHES,
            "declaration matches exceed {MAX_DECLARATION_MATCHES} bound");
    }
    Ok(matches)
}
```

with module-level:

```rust
const PRODUCT_KINDS: [(&str, &str); 5] = [
    ("interface", "InterfaceDeclaration"),
    ("type-alias", "TypeAliasDeclaration"),
    ("class", "ClassDeclaration"),
    ("function", "FunctionDeclaration"),
    ("variable", "FirstStatement"),
];

fn product_kind_to_statement_kind(kind: &str) -> Result<&'static str> {
    PRODUCT_KINDS.iter().find(|(product, _)| *product == kind)
        .map(|(_, statement)| *statement)
        .with_context(|| format!("unsupported declaration kind {kind}"))
}
```

Note: `declaration_name` needs `pub(crate)` visibility from the bin — it is a separate binary, so it must go through the *public* kernel API; that is exactly why the scan lives on `Kernel`, not in `session.rs`. `crate::bridge::declaration_name` is already `pub(crate) use`d in `bridge/mod.rs:13`. `graph.snapshot()` clones the node set — acceptable at gate-1 scale; gate 2 measures it (do NOT add an index now, YAGNI).

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

`session.rs` `execute_read` (read-only path — this action must ALSO be added to the read classification wherever the session routes reads vs. the mutation journal; mirror exactly how `InspectNodes` is classified):

```rust
            RequestAction::FindDeclarations { name, kind } => {
                validate_bounded_text(name, "name")?; // reuse the session's existing input bounds helper
                let matches = self.kernel.find_declarations(name, kind.as_deref())?;
                Ok(ResponseResult::Declarations {
                    graph_generation: WireU64::new(self.kernel.snapshot().generation()),
                    declarations: matches.into_iter().map(|m| DeclarationSummary {
                        node_id: m.node_id, kind: m.kind, name: m.name, module_id: m.module_id,
                    }).collect(),
                })
            }
```

(If the session has no shared text-bound helper, enforce the same 512-char bound `tools.ts` uses.)

- [ ] **Step 5: Run Rust test to verify pass**

Run: `cargo build -p strata-kernel && cargo test -p strata-kernel --test local_service find_declarations`
Expected: PASS.

- [ ] **Step 6: TS protocol + client + tool (failing test first).** In live-compare's existing protocol test file add:

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

Run: `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test` → FAIL. Then implement — `protocol.ts`:

```typescript
export const declarationKindFilterSchema = z.enum([
  "interface", "type-alias", "class", "function", "variable"
]);
// requestActionSchema union gains:
z.object({
  type: z.literal("find_declarations"),
  name: boundedText(MAX_ID_CHARS_EQUIVALENT), // reuse the file's existing bounded-string helper
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

`tools.ts`: add to `COORDINATION_TOOL_INPUT_SCHEMAS`:

```typescript
  find_declarations: z.object({
    name: z.string().min(1).max(MAX_ID_CHARS),
    kind: z.enum(["interface", "type-alias", "class", "function", "variable"]).optional()
  }).strict(),
```

tool definition (description mirrors the SQLite product's `find_declarations` role as the discovery entry point):

```typescript
    strictTool(
      "find_declarations",
      "Find declarations by exact name, optionally narrowed by kind (interface, type-alias, class, function, variable). Returns stable node IDs with their module. This is your discovery entry point: use it to locate the declaration to change, then inspect_nodes on the returned IDs before mutating.",
      COORDINATION_TOOL_INPUT_SCHEMAS.find_declarations,
      async ({ name, kind }) => textResult(await client.findDeclarations(name, kind))
    ),
```

extend `CoordinationClientApi` with `findDeclarations(name: string, kind?: string): Promise<CoordinationResult>` and add `"find_declarations"` to `COORDINATION_TOOL_NAMES` (first position — discovery precedes inspection).

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
- Modify: `crates/strata-kernel/src/storage.rs` (operation lookup by ID, near the existing `operation(generation)` read used by `Kernel::operation`)
- Modify: `crates/strata-kernel/src/kernel.rs` (public `operation_by_id`)
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/protocol.rs`, `session.rs` (request/result + read path)
- Modify: `packages/live-compare/src/protocol.ts`, `client.ts`, `tools.ts`
- Test: `crates/strata-kernel/tests/local_service.rs`; live-compare protocol test file

**Interfaces:**
- Consumes: Task 1's `OperationRecord.intents` (`kind`, `parameters_json`); `Kernel::generation_digest(u64)` (`kernel.rs:327`); change-set reasoning already ON the record (`reasoning`).
- Produces:
  - Rust: `Kernel::operation_by_id(&self, operation_id: &str) -> Result<Option<(u64, OperationRecord)>>` (generation + record).
  - Wire: request `{"type":"read_operation","operationId":...}`; result:

```json
{"type":"operation","graphGeneration":"4","operationId":"...","changeSetId":"...",
 "actor":"...","kind":"RenameSymbol","reasoning":"<original task context>",
 "affectedNodeIds":["..."],"renames":[{"nodeId":"...","fromName":"User","toName":"Account"}],
 "intents":[{"kind":"RenameSymbol","parametersJson":"{...}"}],
 "publicationDigest":"<generation digest>"}
```

  - TS: `client.readOperation(operationId)`; tool `read_operation`.

- [ ] **Step 1: Failing Rust test** in `local_service.rs`: run one full rename lifecycle through the daemon (begin → add_intent → submit → advance, using the file's existing helpers), capture `operationId` from the `change_set` result, then:

```rust
    let audit = request_json(&socket, json!({ "type": "read_operation", "operationId": operation_id }));
    // assert: actor == the requesting clientId's actor, reasoning == the begin_change_set reasoning,
    // kind == "RenameSymbol", affectedNodeIds.len() > 1,
    // renames == [{fromName:"User", toName:"Account", ...}],
    // intents.len() == 1 && intents[0].kind == "RenameSymbol"
    //   && intents[0].parametersJson parses to {declarationId, newName:"Account"} (camelCase tag form),
    // publicationDigest is a 64-hex string; unknown operationId -> error response
```

Run: `cargo test -p strata-kernel --test local_service read_operation` → FAIL.

- [ ] **Step 2: Storage + kernel lookup.** In `storage.rs`, add a method beside the existing per-generation operation read that iterates the `operations` table (redb range over all generations), deserializes each `OperationRecord`, and returns the first with matching `operation_id`, together with its generation key. Linear in history length — acceptable at gate-1; gate 2 measures. In `kernel.rs`:

```rust
pub fn operation_by_id(&self, operation_id: &str) -> Result<Option<(u64, OperationRecord)>> {
    self.store.operation_by_id(operation_id)
}
```

- [ ] **Step 3: Wire + session (read path).** `protocol.rs`: `ReadOperation { operation_id: String }` in `RequestAction`; `ResponseResult::Operation { ... }` with the exact fields shown in Interfaces (renames/intents as camelCase structs mirroring `OperationRename`/`OperationIntentRecord`). `session.rs` `execute_read`:

```rust
            RequestAction::ReadOperation { operation_id } => {
                let Some((generation, record)) = self.kernel.operation_by_id(operation_id)? else {
                    bail!("operation {operation_id} does not exist");
                };
                let digest = self.kernel.generation_digest(generation)?;
                Ok(ResponseResult::Operation { /* map fields 1:1 */ })
            }
```

Classify `read_operation` as read-only wherever `InspectNodes` is.

- [ ] **Step 4: Run Rust test** → PASS.

- [ ] **Step 5: TS side (failing schema test first, then implement).** Mirror Task 2 exactly: `responseResultSchema` gains the `operation` variant (validate `parametersJson` is a string; `intents` max 16), `requestActionSchema` gains `read_operation`; `isMutating` read list gains `"read_operation"`; client method:

```typescript
  readOperation(operationId: string, deadlineMs = DEFAULT_REQUEST_DEADLINE_MS): Promise<CoordinationResult> {
    return this.request({ type: "read_operation", operationId }, deadlineMs);
  }
```

tool:

```typescript
    strictTool(
      "read_operation",
      "Read the canonical audit record of one committed operation by its operation ID: actor, the original task reasoning, typed intent parameters, affected node IDs, and rename transitions. Use the operation ID returned by advance_change_set or read_events.",
      COORDINATION_TOOL_INPUT_SCHEMAS.read_operation,
      async ({ operation_id }) => textResult(await client.readOperation(operation_id))
    ),
```

Run: `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare build && PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test` → PASS.

- [ ] **Step 6: Commit**

```bash
git add -A crates/strata-kernel packages/live-compare && git commit -m "feat(kernel): read_operation audit request — params and reasoning readable over the wire"
```

---

### Task 4: Behavioral (tsc+vitest) validation profile reaches the daemon

**Files:**
- Modify: `crates/strata-kernel/src/bridge/process.rs` (new constructor beside `tsc_only`, ~line 32)
- Modify: `crates/strata-kernel/src/bridge/protocol.rs` (a `behavioral(...)` constructor beside `ValidationProfile::tsc_only`, ~line 465)
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/main.rs` (flags, ~line 44-95)
- Modify: `packages/live-compare/src/service.ts` (`startKernelService` options)
- Test: `crates/strata-kernel/src/bridge/protocol.rs` mod tests (serialization); `crates/strata-kernel/src/bin/` arg parsing via `tests/local_service.rs` (daemon rejects behavioral without fixtures)

**Interfaces:**
- Produces: `NodeBridgeConfig::behavioral(executable, arguments, deadline, source_root, corpus_root, behavioral_fixtures: Vec<String>, strict_src_only_tsc_scope: bool) -> Self`; daemon flags `--validation-profile tsc_only|behavioral` (optional, default `tsc_only`) and `--behavioral-fixtures <comma-separated relative paths>` (required iff behavioral); TS `startKernelService(corpusRoot, { validation?: { profile: "behavioral"; fixtures: string[] } })`.
- Consumes: `ValidationProfile::Behavioral` (`bridge/protocol.rs:457-462`) and `candidate.ts`'s existing `commitWithBehavioralGate` path — no TS worker changes.

- [ ] **Step 1: Failing tests.** (a) In `bridge/protocol.rs` tests: `ValidationProfile::behavioral("src","corpus",vec!["test/app.test.ts".into()],true)` serializes with `"mode":"behavioral"` (match the existing wire tag naming used by `tscOnly` tests in that file) and `validate()` accepts it, while empty fixtures still validate (worker-side rules govern content). (b) In `local_service.rs`: spawning with `--validation-profile behavioral` and no `--behavioral-fixtures` exits with an argument error.

Run: `cargo test -p strata-kernel behavioral` → FAIL.

- [ ] **Step 2: Implement.** `ValidationProfile::behavioral(...)` mirrors `tsc_only(...)` but builds `Self::Behavioral` with the fixture list. `NodeBridgeConfig::behavioral(...)` mirrors `tsc_only` byte-for-byte except the profile. `main.rs`:

```rust
    let allowed = [ /* existing */ "--validation-profile", "--behavioral-fixtures" ];
    // after parsing existing args:
    let bridge_config = match values.get("--validation-profile").and_then(|v| v.to_str()) {
        None | Some("tsc_only") => NodeBridgeConfig::tsc_only(
            "node", vec![worker.into_os_string()], Duration::from_secs(30),
            source_root, corpus_root, true),
        Some("behavioral") => {
            let fixtures = required_text(&values, "--behavioral-fixtures")?
                .split(',').map(str::to_owned).collect::<Vec<_>>();
            NodeBridgeConfig::behavioral(
                "node", vec![worker.into_os_string()], Duration::from_secs(120),
                source_root, corpus_root, fixtures, true)
        }
        Some(other) => bail!("invalid --validation-profile {other}"),
    };
```

(120 s bridge deadline for behavioral: vitest on `examples/medium` runs well inside it; tsc_only stays at 30 s.) `service.ts`: append the two flags when `options.validation?.profile === "behavioral"`.

- [ ] **Step 3: Run tests**

Run: `cargo test -p strata-kernel behavioral && cargo test -p strata-kernel --test local_service`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A crates/strata-kernel packages/live-compare && git commit -m "feat(kernel): configurable validation profile — behavioral tsc+vitest gate reaches the daemon"
```

---

### Task 5: `export-snapshot` offline oracle subcommand

**Files:**
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/main.rs` (new subcommand)
- Test: `crates/strata-kernel/tests/local_service_recovery.rs` (or a new `tests/export_snapshot.rs` if recovery helpers don't fit)

**Interfaces:**
- Produces: `strata-kernel-service export-snapshot --db PATH --out PATH` — opens the store on the normal recovery path (snapshot + delta replay + digest verification), writes the canonical `GraphSnapshot` JSON (camelCase, BTreeMap-ordered nodes/references — same shape `KernelSnapshotV1` seeds with), prints `{"generation":"<u64>","digest":"<64-hex>"}` on stdout. Task 7's harness shells out to this.
- Consumes: `Kernel::open(path)` (`kernel.rs:183`) and `GraphGeneration::snapshot()`/`digest()`.

- [ ] **Step 1: Failing test:** seed a service (existing recovery-test helpers), run one rename, stop the daemon, run `export-snapshot`, assert: exit 0; the out-file parses as a snapshot whose node payloads contain `Account` where the fixture had `User`; stdout digest equals the digest a fresh `Kernel::open` reports; running it against a *nonexistent* db path exits non-zero.

Run: `cargo test -p strata-kernel --test local_service_recovery export_snapshot` → FAIL.

- [ ] **Step 2: Implement** in `main.rs`:

```rust
        Some("export-snapshot") => export_snapshot(&remaining),
```

```rust
fn export_snapshot(arguments: &[OsString]) -> Result<()> {
    let values = parse_named(arguments)?;
    reject_unknown(&values, &["--db", "--out"])?;
    let db_path = required_path(&values, "--db")?;
    let out_path = required_path(&values, "--out")?;
    anyhow::ensure!(db_path.exists(), "database {} does not exist", db_path.display());
    let (kernel, _report) = strata_kernel::Kernel::open(&db_path)?;
    let graph = kernel.snapshot();
    let snapshot = graph.snapshot();
    std::fs::write(&out_path, serde_json::to_vec_pretty(&snapshot)?)?;
    println!("{}", serde_json::json!({
        "generation": graph.generation().to_string(),
        "digest": graph.digest(),
    }));
    Ok(())
}
```

(If `Kernel::open` requires a node bridge for coordination reconciliation, use the same no-bridge open the recovery tests use; the export path performs no validation.) Update `print_help`.

- [ ] **Step 3: Run test** → PASS. **Step 4: Commit**

```bash
git add -A crates/strata-kernel && git commit -m "feat(kernel): export-snapshot offline oracle subcommand"
```

---

### Task 6: Fail-closed seed bound + design-doc amendment

**Files:**
- Modify: `packages/live-compare/src/tasks.ts:495-506` (`createQualifiedKernelSnapshot`)
- Modify: `docs/superpowers/specs/2026-07-18-iteration6-slice-a-convergence-design.md` (D1 hardening paragraph)
- Test: live-compare's existing tasks test file

- [ ] **Step 1: Failing test:** `createQualifiedKernelSnapshot` on a corpus whose snapshot generation is `"0"` returns `generation: 0`; a synthetic snapshot object with generation `"9007199254740993"` (> `Number.MAX_SAFE_INTEGER`) makes the conversion helper throw rather than silently round. (Extract the conversion into `boundedGenerationNumber(generation: string): number` so it is testable without a corpus.)

- [ ] **Step 2: Implement:**

```typescript
export function boundedGenerationNumber(generation: string): number {
  const value = Number(generation);
  if (!Number.isSafeInteger(value) || String(value) !== generation) {
    throw new Error(`snapshot generation ${generation} exceeds the safe seeding bound`);
  }
  return value;
}
```

use it in `createQualifiedKernelSnapshot`. Amend the design doc's D1 hardening sentence to describe this fail-closed bound (the wire format keeps its numeric generation; a string protocol change buys nothing for a fresh store seeded at generation 0).

- [ ] **Step 3: Run** `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test` → PASS. **Commit:**

```bash
git add -A packages/live-compare docs/superpowers/specs && git commit -m "fix(live-compare): fail-closed generation bound at kernel seed; design D1 amended"
```

---

### Task 7: Gate-1 parity harness (both arms, six assertions)

**Files:**
- Create: `packages/live-compare/src/gate1.ts` (arm drivers + comparison helpers)
- Test: `packages/live-compare/test/gate1Parity.test.ts` (or the package's existing test dir convention)
- Modify: `package.json` (root): add `kernel:gate1:test`; fold into `kernel:full-key-free:test`

**Interfaces:**
- Consumes: Tasks 2–5 surfaces; `runT03`-style SQLite flow (`packages/cli/src/commands/t03.ts` — but the parity arm uses the *behavioral* product gate: `commitWithBehavioralGate` from `@strata-code/verify`, invoked exactly as `packages/kernel-bridge/src/candidate.ts:115` does); `exportSnapshot` (`packages/kernel-bridge/src/snapshot.ts`); `startKernelService` with behavioral profile; `CoordinationClient`.
- Produces (for Tasks 8–9): 

```typescript
export interface SqliteArmOutcome { snapshot: KernelSnapshotV1; operationRow: OperationRowAudit; renderedRoot: string; }
export interface KernelArmOutcome { exportPath: string; snapshot: KernelSnapshotV1; audit: OperationAudit; renderedRoot: string; service: RunningKernelService; }
export function runSqliteArm(corpusRoot: string, workDir: string): Promise<SqliteArmOutcome>;
export function runKernelArmT03(corpusRoot: string, workDir: string, options?: { testFailpoint?: string; publishFailpoint?: string; onStage?: (stage: Gate1Stage) => Promise<void> }): Promise<KernelArmOutcome>;
export type Gate1Stage = "after_discovery" | "after_begin" | "after_add_intent" | "after_submit";
export function renderSnapshotToTree(snapshot: KernelSnapshotV1, corpusRoot: string, outDir: string): string; // hydrate :memory: + @strata-code/render per module, same renderer both arms
export function behavioralFixturesFor(corpusRoot: string): string[]; // test files under the corpus, same filter candidate.ts validates
```

- [ ] **Step 1: Write the failing parity test** (this IS gate 1's acceptance shape — write all six assertions up front):

```typescript
describe("gate 1: key-free semantic parity (kernel vs SQLite product arm)", () => {
  it("produces equivalent nodes, references, rendered TS, tsc+vitest, criteria, and audit", async () => {
    const corpus = resolve(repoRoot, "examples/medium");
    const sqlite = await runSqliteArm(corpus, mkWork());
    const kernel = await runKernelArmT03(corpus, mkWork());
    // 1+2: canonical node/reference byte equality
    expect(canonicalJson(kernel.snapshot.nodes)).toBe(canonicalJson(sqlite.snapshot.nodes));
    expect(canonicalJson(kernel.snapshot.references)).toBe(canonicalJson(sqlite.snapshot.references));
    // 3: rendered corpus byte equality, module by module
    expect(treeDigest(kernel.renderedRoot)).toBe(treeDigest(sqlite.renderedRoot));
    // 4: tsc --noEmit + vitest green on BOTH rendered corpora (run both, literal gate text)
    expect(await tscAndVitestGreen(kernel.renderedRoot)).toBe(true);
    expect(await tscAndVitestGreen(sqlite.renderedRoot)).toBe(true);
    // 5: T03 text criteria pass on both
    expect(evaluateT03TextCriteriaOnTree(kernel.renderedRoot)).toMatchObject(ALL_TRUE);
    expect(evaluateT03TextCriteriaOnTree(sqlite.renderedRoot)).toMatchObject(ALL_TRUE);
    // 6: audit equivalence
    expect(kernel.audit.actor).toBeTruthy();
    expect(kernel.audit.reasoning).toContain("Rename the User interface"); // the task context passed to begin_change_set
    expect(JSON.parse(kernel.audit.intents[0].parametersJson)).toMatchObject({ newName: "Account" });
    expect(kernel.audit.affectedNodeIds.length).toBeGreaterThan(1);
    expect(kernel.audit.renames).toEqual([expect.objectContaining({ fromName: "User", toName: "Account" })]);
    expect(sqlite.operationRow).toMatchObject({ kind: "RenameSymbol", oldName: "User", newName: "Account" });
    expect(sqlite.operationRow.affected.length).toBeGreaterThan(1);
  }, 600_000);
});
```

Helper notes for the implementer:
- `runSqliteArm`: ingest → `openDb(":memory:")` → insert → `find_declarations({name:"User",kind:"interface"})` (assert exactly 1) → `begin` → `rename_symbol` → `commitWithBehavioralGate(db, tx, { srcRoot, corpusRoot, behavioralFixtures: behavioralFixturesFor(corpus), strictSrcOnlyTscScope: true })` (assert ok) → `exportSnapshot(db)` → render tree. The `operations` row audit reads the same fields `operationRowAppended` scores (`packages/verify/src/t03Criteria.ts:181-201`).
- `runKernelArmT03`: `startKernelService(corpus, { validation: { profile: "behavioral", fixtures: behavioralFixturesFor(corpus) } })` → client `findDeclarations("User","interface")` (assert exactly 1, and assert the nodeId equals the SQLite arm's declaration id — same ingest, same IDs) → `beginChangeSet("Rename the User interface to Account across the codebase")` → `addIntent(rename)` → `submitChangeSet` → `advanceChangeSet` (assert state `committed`, capture `operationId`) → `readOperation` → `service.stop()` → shell out to `strata-kernel-service export-snapshot --db <dir>/kernel.redb --out ...` → parse.
- `canonicalJson`: the sorted-array canonical form `diffSnapshots`/`exportSnapshot` already use — reuse `packages/kernel-bridge/src/snapshot.ts` exports, do not reimplement.
- `tscAndVitestGreen`: reuse the exact runner `@strata-code/verify` uses for its behavioral gate (`corpusRun.ts`) rather than spawning tsc ad hoc. Follow its API as found; if it is not exported, export it from verify (one-line index change) rather than duplicating.
- Deadlines: pass `deadlineMs` ≥ 120_000 for submit and ≥ 180_000 for advance.

- [ ] **Step 2: Run to verify failure** (drivers missing): `PATH=/opt/homebrew/bin:$PATH pnpm --filter @strata-code/live-compare test -- gate1` → FAIL.

- [ ] **Step 3: Implement `gate1.ts`** per the helper notes. Build order: `pnpm --filter @strata-code/kernel-bridge build && pnpm --filter @strata-code/live-compare build && cargo build -p strata-kernel`.

- [ ] **Step 4: Run to verify pass** (same command, 600 s timeout). Expected: PASS. If parity fails on payload bytes, STOP and diagnose before touching either arm's semantics — a parity failure that can only be fixed by weakening kernel semantics is falsifier 1 (log a decision instead of patching).

- [ ] **Step 5: Wire scripts.** Root `package.json`:

```json
"kernel:gate1:test": "pnpm --filter @strata-code/kernel-bridge build && pnpm --filter @strata-code/live-compare build && cargo build -p strata-kernel --features coordination-test-api && pnpm --filter @strata-code/live-compare test -- gate1",
```

and append `&& pnpm kernel:gate1:test` to `kernel:full-key-free:test`. (The gate-1 daemon binary needs `coordination-test-api` only for Task 8's failpoints; the parity test itself must ALSO pass against a default-features binary — parameterize the binary path via env `STRATA_KERNEL_SERVICE_BIN` and let Task 8's crash suite set the feature-built one.)

- [ ] **Step 6: Commit**

```bash
git add -A packages/live-compare package.json && git commit -m "test(gate1): key-free semantic parity harness — kernel arm vs SQLite product arm"
```

---

### Task 8: Crash injection across the T03 surface

**Files:**
- Modify: `crates/strata-kernel/src/bin/strata_kernel_service/main.rs` + `session.rs` (accept `--test-publish-failpoint <boundary>` under `coordination-test-api`, mapping `PublishFailpoint::from_boundary_name` (`kernel.rs:79`) into the advance/publication path)
- Create: `packages/live-compare/test/gate1Crash.test.ts`
- Test: both of the above

**Interfaces:**
- Consumes: Task 7's `runKernelArmT03(corpus, work, { failpoint })`, `export-snapshot`.
- Produces: daemon flag `--test-publish-failpoint before_redb_transaction|inside_redb_transaction|after_redb_commit_before_memory_publish|after_memory_publish` (exact names from `PublishFailpoint::from_boundary_name` — verify and use its accepted strings).

- [ ] **Step 1: Discovery step (bounded).** Read how `tests/support/full_key_free.rs::run_row_8_crash_child` injects `PublishFailpoint` into the *coordinated* publication path (row 8 of the acceptance suite). Two known possibilities: (a) a kernel/test API that threads the failpoint into `publish_claimed_inner`; (b) only `publish_with_failpoint` on the storage layer. Wire the daemon flag through the same mechanism (a) if it exists; if only (b), add the failpoint parameter to the coordinator's publication entry under `#[cfg(feature = "coordination-test-api")]` exactly parallel to how `ServiceFailpoint` is threaded into `handle_mutation`. Do not add any new abort sites — reuse the four existing boundaries.

- [ ] **Step 2: Failing TS test** — for each of the nine failpoints (5 × `--test-failpoint` journal stages, 4 × `--test-publish-failpoint` boundaries):

```typescript
for (const failpoint of JOURNAL_STAGES) test(`journal ${failpoint}`, () => runCrashCase({ testFailpoint: failpoint }), 600_000);
for (const boundary of PUBLISH_BOUNDARIES) test(`publish ${boundary}`, () => runCrashCase({ publishFailpoint: boundary }), 600_000);

async function runCrashCase(inject: Inject) {
  const corpus = resolve(repoRoot, "examples/medium");
  const oldExport = await exportFreshSeed(corpus);          // seed-only export (generation 0)
  const attempt = await runKernelArmT03UntilCrash(corpus, inject); // daemon aborts mid-flow
  const reopened = await reopenAndExport(attempt.directory); // restart daemon against same --db, then export
  // exactly complete-old XOR complete-new:
  expect([canonicalJson(oldExport), canonicalJson(attempt.expectedNewSnapshot)])
    .toContain(canonicalJson(reopened.snapshot));
  // digest recovery invariant: reopen reported a verified digest (export-snapshot succeeded)
  if (canonicalJson(reopened.snapshot) === canonicalJson(oldExport)) {
    // old generation: re-running the full T03 flow now must succeed and land the new generation
    const completed = await runKernelArmT03(corpus, attempt.directoryAsWork());
    expect(canonicalJson(completed.snapshot)).toBe(canonicalJson(attempt.expectedNewSnapshot));
  } else {
    // new generation: rendered corpus is green
    expect(await tscAndVitestGreen(renderSnapshotToTree(reopened.snapshot, corpus, mkWork()))).toBe(true);
  }
}
```

`expectedNewSnapshot` = the Task-7 kernel-arm result on an uninjected run of the same corpus (compute once per suite, reuse). `runKernelArmT03UntilCrash` tolerates the client seeing `connection_lost`/`request_timeout` at the injected stage and asserts the child process exited abnormally. Restart uses the SAME `--db` path and the existing recovery branch (`--snapshot` is ignored when the db exists).

- [ ] **Step 3: Run** → FAIL (flag unknown). **Step 4: implement the flag threading** from Step 1. **Step 5: run** → PASS (long: ~9 daemon lifecycles; keep within the 600 s per-case vitest timeout; the suite runs serially).

- [ ] **Step 6: Commit**

```bash
git add -A crates/strata-kernel packages/live-compare && git commit -m "test(gate1): crash injection at all nine durable boundaries through the T03 surface"
```

---

### Task 9: Second-client intrusion at every nominal solo stage

**Files:**
- Create: `packages/live-compare/test/gate1Intrusion.test.ts`
- Modify (only if needed): `packages/live-compare/src/gate1.ts` (stage-pause hooks: the arm driver accepts an async `onStage(stage)` callback fired after discovery, after begin, after add_intent, after submit, before advance)

**Interfaces:**
- Consumes: Task 7 drivers; a second `CoordinationClient` with a distinct `clientId`.
- Produces: none downstream — this is the closing gate-1 suite.

- [ ] **Step 1: Failing test.** Stages: `["after_discovery","after_begin","after_add_intent","after_submit"]` plus the concurrent case. For each stage × two intrusion shapes:

```typescript
// (i) disjoint: client B renames a different declaration (discovered via find_declarations
//     at runtime, assert different moduleId than User's) through its own full lifecycle -> committed.
//     Then client A continues to completion -> committed.
//     Assert: final export contains BOTH renames; tsc+vitest green; A's audit and B's audit both intact.
// (ii) overlapping: client B renames the SAME "User" declaration to "Client" and completes
//     BEFORE A advances. A's advance must NOT silently overwrite: expect A's change_set result
//     state to be needs_decision (with renamedSymbols naming User->Client) or an ordered
//     commit consistent with fresh re-analysis — assert the final export equals ONE of the two
//     serial outcomes and NEVER a blend; if A got needs_decision, cancel and resubmit against
//     fresh state, then assert the resubmitted rename lands on the current name.
// Concurrent case: fire A.advanceChangeSet and B.advanceChangeSet (overlapping scopes) with
//     Promise.allSettled; assert exactly the serial-outcome invariant set: final export equals
//     A-then-B or B-then-A; every committed operation has a verifiable read_operation record;
//     export digest matches export-snapshot stdout digest; no request left the store unreadable.
```

Also assert actor ownership throughout: B calling `advance_change_set` on A's change-set id gets an authorization error (existing `authorize_actor` behavior — this pins it into gate 1).

- [ ] **Step 2: Run** → FAIL (hooks missing). **Step 3: implement `onStage` hooks + the suite.** **Step 4: run** → PASS. Timeout 600 s per case; the overlapping cases include two full behavioral validations each.

- [ ] **Step 5: Commit**

```bash
git add -A packages/live-compare && git commit -m "test(gate1): second-client intrusion at every nominal solo stage"
```

---

### Task 10: Full green run, decision log, roadmap check-off, push

**Files:**
- Modify: `decisions.md` (new top entry), `docs/product-roadmap.md` (slice A: gate 1 checked with evidence pointer)

- [ ] **Step 1: Full verification (foreground, chunked):**

```bash
PATH=/opt/homebrew/bin:$PATH pnpm -r build
PATH=/opt/homebrew/bin:$PATH pnpm kernel:full-key-free:test   # includes kernel:gate1:test after Task 7
PATH=/opt/homebrew/bin:$PATH pnpm -r test
```

Expected: all PASS. Any failure: fix before logging anything as done. If a fix would require weakening coordination semantics — STOP, decisions.md entry, falsifier 1.

- [ ] **Step 2: decisions.md entry** (top): what landed (gate 1 pass + the five surface additions), what diverged from the design (list every adaptation the tasks forced, e.g. the Task 8 discovery outcome, any digest-fixture updates from Task 1), and what stays open (gates 2–5, with gate 2 next).

- [ ] **Step 3: Roadmap:** under Iteration 6 slice A, record "gate 1 PASS (key-free) — evidence: `packages/live-compare/test/gate1*.test.ts`, decisions.md <date>" without checking the slice-A box (gates 2–5 remain).

- [ ] **Step 4: Commit + push**

```bash
git add -A && git commit -m "docs: gate 1 (key-free semantic parity) recorded — slice A continues at gate 2" && git push
```
