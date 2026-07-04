# Strata architecture visual guide

This document is a picture-first map of what Strata does today. It is meant
for orientation: where code enters the substrate, what the agent can see, how
mutations flow, and where files still exist.

## One-sentence model

Strata turns a TypeScript project into a SQLite-backed structural graph, lets an
agent change that graph through typed transactional tools, validates the pending
state with TypeScript/tests, then renders TypeScript files as artifacts.

## System overview

```mermaid
flowchart TB
  User["User prompt"]
  CLI["packages/cli<br/>strata agent, t03, roundtrip, baseline"]
  Agent["packages/agent<br/>Claude SDK session<br/>Strata tools only"]
  Tools["20 MCP-style Strata tools<br/>query, mutate, validate, commit"]
  Store["packages/store<br/>SQLite node graph<br/>edges, transactions, op log"]
  Ingest["packages/ingest<br/>TypeScript source -> nodes + refs"]
  Render["packages/render<br/>nodes -> canonical TypeScript<br/>source maps"]
  Verify["packages/verify<br/>in-process tsc<br/>behavioral test gate"]
  Bench["packages/bench<br/>substrate vs file-tools baseline"]
  Files["Real TypeScript files<br/>input corpus and rendered artifacts"]

  User --> CLI
  CLI --> Agent
  Agent --> Tools
  Tools --> Store
  CLI --> Ingest
  Ingest --> Store
  Store --> Render
  Render --> Verify
  Verify --> Store
  Bench --> Agent
  Bench --> Verify
  Files --> Ingest
  Render --> Files
```

The important boundary: the agent does not edit files. The agent sees node IDs,
declarations, references, diagnostics, and tool results. Files are input to
ingest and output from render/verify.

## Package roles

```mermaid
flowchart LR
  subgraph Entry["Entry points"]
    CLI["cli"]
    Bench["bench"]
  end

  subgraph AgentLayer["Agent layer"]
    Agent["agent"]
    Prompt["L1/L2/L3 prompt context"]
    ToolDefs["tool definitions"]
  end

  subgraph Core["Substrate core"]
    Store["store"]
    Tx["transactions"]
    Ops["structural ops"]
    Log["operation log"]
  end

  subgraph CompilerPath["Compiler path"]
    Ingest["ingest"]
    Render["render"]
    Verify["verify"]
  end

  CLI --> Agent
  Bench --> Agent
  Agent --> Prompt
  Agent --> ToolDefs
  ToolDefs --> Store
  Store --> Tx
  Store --> Ops
  Store --> Log
  Ingest --> Store
  Store --> Render
  Render --> Verify
  Verify --> Store
```

| Package | Current responsibility |
| --- | --- |
| `packages/cli` | User-facing commands and local dogfood paths. |
| `packages/agent` | Agent session, prompt assembly, structural tool server, baseline runner. |
| `packages/store` | Node rows, reference edges, transactions, operation log, structural mutations, semantic search tables. |
| `packages/ingest` | TypeScript corpus to module/declaration/identifier nodes plus reference edges. |
| `packages/render` | Stored nodes back to canonical TypeScript text and source maps. |
| `packages/verify` | Render pending state, run TypeScript diagnostics, materialize committed graph changes, optional test gate. |
| `packages/bench` | Paired comparisons and dogfood harnesses. |

## Current agent worldview

```mermaid
flowchart TB
  Prompt["Prompt assembled by Strata<br/>system prompt + L1/L2/L3 context + task"]
  Agent["Agent"]

  subgraph ReadTools["Read tools"]
    Find["find_declarations"]
    FindMod["find_declarations_in_module"]
    Exports["list_module_exports"]
    Refs["get_references"]
    Read["read_node"]
    Semantic["semantic_search"]
    Tests["read_test_file"]
  end

  subgraph TxTools["Transaction tools"]
    Begin["begin_transaction"]
    Validate["validate"]
    Commit["commit_transaction"]
    Rollback["rollback_transaction"]
  end

  subgraph Mutations["Mutation tools"]
    Rename["rename_symbol"]
    AddParam["add_parameter"]
    ReturnType["change_return_type"]
    Import["add_import"]
    CreateFn["create_function"]
    Extract["extract_function"]
    Move["move_declaration"]
    Inline["inline_function"]
    ReplaceBody["replace_body"]
  end

  Prompt --> Agent
  Agent --> ReadTools
  Agent --> TxTools
  Agent --> Mutations
```

The strongest tool class is bulk propagation over known edges: rename a symbol,
move a declaration and repoint importers, add a parameter at every resolved
direct call site, or inline a function at every safe call site.

## Ingest path

```mermaid
sequenceDiagram
  participant CLI as CLI / runner
  participant FS as TypeScript corpus
  participant Ingest as packages/ingest
  participant TS as TypeScript compiler API
  participant Store as SQLite store

  CLI->>FS: read .ts modules
  CLI->>Ingest: ingestBatch([{ path, text }])
  Ingest->>Ingest: parse each module into nodes
  Ingest->>TS: resolve references across rendered input text
  TS-->>Ingest: declaration/reference bindings
  Ingest-->>CLI: nodes, modules, references
  CLI->>Store: insert nodes and reference edges
```

The initial graph is statement/declaration oriented. Module paths exist as
module metadata and render coordinates, but the agent acts on node IDs rather
than file paths.

## Store model

```mermaid
erDiagram
  MODULE ||--o{ NODE : contains
  NODE ||--o{ NODE : parent_child
  NODE ||--o{ REFERENCE_EDGE : "is referenced by"
  NODE ||--o{ REFERENCE_EDGE : "references"
  TRANSACTION ||--o{ OPERATION_LOG_ENTRY : records
  TRANSACTION ||--o{ OVERLAY_MUTATION : stages
  NODE ||--o{ EMBEDDING : optional
  TRANSACTION ||--o{ COMMIT_PATTERN : optional

  MODULE {
    string node_id
    string path
  }
  NODE {
    string id
    string kind
    string payload
    string parent_id
    int child_index
  }
  REFERENCE_EDGE {
    string from_node_id
    string to_node_id
  }
  TRANSACTION {
    string id
    string actor
    string triggering_prompt
  }
  OPERATION_LOG_ENTRY {
    string op_type
    string affected_node_ids
    string reasoning
  }
```

This is conceptual rather than exact schema naming. The invariant that matters:
the store is the canonical code state, and committed mutations are recorded in
the operation log.

## Mutation and commit flow

```mermaid
sequenceDiagram
  participant Agent
  participant Tools as Strata tools
  participant Store as Store overlay
  participant Render as Render pending state
  participant TSC as TypeScript checker
  participant Tests as Test gate
  participant Log as Operation log

  Agent->>Tools: begin_transaction()
  Tools->>Store: open tx overlay
  Agent->>Tools: structural mutation(node_id, ...)
  Tools->>Store: queue identifier/text/node edits
  Agent->>Tools: validate(tx)
  Tools->>Render: render pending modules
  Render->>TSC: create in-memory Program
  TSC-->>Tools: diagnostics mapped to node/source map
  Agent->>Tools: commit_transaction(tx)
  Tools->>Render: render pending modules again
  Tools->>TSC: block on diagnostics
  alt acceptance context exists
    Tools->>Tests: run real project tests
    Tests-->>Tools: pass/fail
  end
  Tools->>Store: materialize graph changes atomically
  Tools->>Log: append operation entries
  Tools-->>Agent: { ok: true } or diagnostics/test failures
```

Commit is deliberately more than "save text." It validates, materializes
identifier/reference graph changes, and writes operation history inside one
SQLite transaction so partial commits do not survive a failure.

## Render and verify path

```mermaid
flowchart LR
  Store["Committed store + tx overlay"]
  Pending["pending module view"]
  Render["renderWithSourceMap"]
  Text["canonical TypeScript text"]
  Map["source map<br/>line/column -> node ID"]
  Program["in-memory ts.Program"]
  Diagnostics["diagnostics mapped back<br/>to Strata nodes"]

  Store --> Pending
  Pending --> Render
  Render --> Text
  Render --> Map
  Text --> Program
  Program --> Diagnostics
  Map --> Diagnostics
```

The TypeScript checker sees files. The agent sees structured diagnostics. This
is why render exists: not as the primary representation, but as the compiler
adapter.

## Three-layer session context

```mermaid
flowchart TB
  Task["User task"]
  L1["L1 module index<br/>always-on codebase shape"]
  L2["L2 semantic search<br/>optional sqlite-vec embeddings"]
  L3["L3 operation-log memory<br/>optional similar past tasks"]
  Prompt["assembled agent prompt"]
  Tools["agent tools"]

  L1 --> Prompt
  L3 --> Prompt
  Task --> Prompt
  L2 --> Tools
  Prompt --> Tools
```

L1 and L3 are prompt context. L2 is a callable retrieval tool. All three are
supporting context layers; they are not the core write substrate.

## Where Strata is strong today

```mermaid
quadrantChart
  title Current task fit
  x-axis Low relationship fan-out --> High relationship fan-out
  y-axis New behavior synthesis --> Existing-structure propagation
  quadrant-1 Strong Strata fit
  quadrant-2 Good safety story, not always cheaper
  quadrant-3 Weak fit
  quadrant-4 Usually file tools are fine
  Rename symbol: [0.90, 0.90]
  Move declaration: [0.78, 0.86]
  Add parameter to widely used function: [0.82, 0.75]
  Inline safe expression helper: [0.72, 0.72]
  Extract single helper: [0.25, 0.58]
  Write new function body: [0.18, 0.25]
  Debug one failing branch: [0.22, 0.30]
```

The product thesis should stay narrow: Strata is most compelling when the hard
part is propagating a structural change through existing references, not when
the hard part is inventing new behavior.

## Baseline comparison shape

```mermaid
flowchart TB
  Prompt["Same task prompt"]

  subgraph FileBaseline["File-tools baseline"]
    BAgent["Agent with file tools"]
    ReadFiles["read/search files"]
    EditText["edit text patches"]
    RunTests["run tsc/tests"]
  end

  subgraph StrataArm["Strata arm"]
    SAgent["Agent with Strata tools only"]
    QueryGraph["query declarations/references"]
    MutateGraph["structural transaction"]
    VerifyGraph["validate + commit gate"]
  end

  Prompt --> BAgent
  Prompt --> SAgent
  BAgent --> ReadFiles --> EditText --> RunTests
  SAgent --> QueryGraph --> MutateGraph --> VerifyGraph
```

The benchmark harness exists to compare these two interfaces under the same
task and model. The most durable positive result so far is the rename-class
bulk propagation win.

## What to look at next

If you are trying to understand or improve Strata, start here:

- Tool surface: `packages/agent/src/tools.ts`
- Transaction overlay and operation log: `packages/store/src/transactions.ts`
- Structural mutations: `packages/store/src/rename.ts`, `addParameter.ts`,
  `moveDeclaration.ts`, `inlineFunction.ts`, `extractFunction.ts`
- Commit and validation path: `packages/verify/src/validate.ts`
- Ingest path: `packages/ingest/src/batch.ts`, `packages/ingest/src/index.ts`
- Renderer: `packages/render/src/index.ts`
- Product status: `docs/product-roadmap.md`
- Decision trail: `decisions.md`

## Open product gap

The diagrams above show the current architecture, but they also make the main
missing product surface visible: Strata has strong commit-time validation, but
no first-class dry-run preview tool yet. A `preview_transaction` or
`preview_mutation` layer would turn the graph into a visible "what will change,
why, and whether it validates" experience before commit.
