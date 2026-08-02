// Bridge-persistence slice, Task 8: differential shadow oracle.
//
// Drives FIXED seeded mutation sequences through two arms of the SAME daemon
// binary — arm P runs with `--persistent-bridge` (one persistent, attested,
// delta-synchronized worker mirror), arm O without (spawn-per-request
// one-shot bridge) — and compares every per-step semantic surface:
//
//   - submit/advance change-set state transitions (the full sequence of
//     states each advance returned, plus ticket states);
//   - published-operation presence and content: affected node ids, rename
//     transitions, intent summaries, actor, reasoning, publication digest;
//   - re-inspected payloads of EVERY node the operation affected;
//   - diagnostics and renamed-symbol surfaces on failure paths
//     (needs_decision / validation_failed);
//   - a FINAL tree-state digest computed the way `materializeFinalTree`
//     reconstructs the shared tree (in memory, no physical render): every
//     registered source file's statement payloads from the manifest's
//     generation-zero registration, overlaid with re-inspected payloads of
//     EVERY operation-affected registered statement across the whole
//     sequence, sha256 over (path, reconstructed text) in path order — plus
//     the final graph generation. (Inspecting ALL registered statements is
//     not protocol-supported: nodes whose immediate-child projection exceeds
//     the 256-item bound refuse inspection, so the digest overlays only
//     affected statements, exactly like `materializeFinalTree`.)
//
// Opaque per-run identifiers (change-set ids, operation ids) are minted by
// the daemon per run and cannot match across arms; they are normalized to a
// presence marker before comparison. Client ids, reasoning strings, and
// declaration ids are fixed inputs, identical in both arms, and compared
// verbatim. ANY difference in the normalized facts is a mismatch; the report
// carries both sides in full.
//
// Metrics are ON for both arms so the workerRun/request records corroborate
// the bridge lifecycle under test (persistent arm: workerStartsTotal stays
// 1, snapshot-free trips; one-shot arm: spawn per trip) — corroboration is
// recorded per arm but deliberately EXCLUDED from the semantic comparison.
//
// Sequence catalog (plan v2, review Q8 — concurrency and failpoints
// included):
//   sequential-1 — six alternating `User` <-> `Account` interface renames;
//   sequential-2 — mixed surface: two add_parameter publications (`greet`
//                  gains `excited: boolean = false`, `serialize` gains
//                  `displayLabel: string = UserTypes.displayUser(user)` — the
//                  registered R/X-packet parameter tasks; seed-chosen order)
//                  followed by four renames over two independent targets
//                  (`formatTimestamp` and `User`, there and back);
//   concurrent   — two overlapping clients on ONE daemon: both change sets
//                  begun, populated, and submitted before either advances,
//                  then advances alternate (seed-chosen leader) until both
//                  publish;
//   failpoint    — a publication that legitimately fails mid-sequence
//                  through the protocol itself (no daemon-side injection):
//                  an add_parameter change set whose value names
//                  `displayUser` is submitted BEFORE an overlapping
//                  `displayUser -> formatUser` rename publishes; its claim
//                  is invalidated by the publication and terminates
//                  needs_decision with the renamed-symbol surface, is
//                  cancelled, rewritten purely from that surface, and the
//                  fresh decision publishes.
//
// All free choices (interleave leader, independent-step order) derive from
// the caller's seed via the gate-3 mulberry32 PRNG — no Date, no
// Math.random; both arms consume identical PRNG streams.
//
// See docs/superpowers/plans/2026-07-23-bridge-persistence-slice.md, Task 8.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CoordinationClient,
  type CoordinationIntent,
  type CoordinationResult
} from "../client.js";
import {
  ADVANCE_DEADLINE_MS,
  DISCOVERY_DEADLINE_MS,
  SUBMIT_DEADLINE_MS,
  credentialFreeEnv,
  expectResult,
  kernelServiceBinary
} from "../gate1.js";
import {
  parseMetricsJsonl,
  type RequestRecord,
  type WorkerRunRecord
} from "../gate2.js";
import { seededRng } from "../gate3/stats.js";
import { startKernelService } from "../service.js";
import { createQualifiedTaskManifest, type QualifiedTaskManifest } from "../tasks.js";

export const ORACLE_SEQUENCES = [
  "sequential-1",
  "sequential-2",
  "concurrent",
  "failpoint"
] as const;

export type OracleSequenceName = (typeof ORACLE_SEQUENCES)[number];

export interface OracleOptions {
  sequences?: readonly OracleSequenceName[];
  /** Seed for every free choice in the sequences; both arms replay it. */
  seed: number;
}

/** One recorded step: a stable label plus canonical JSON of its facts. */
export interface OracleStep {
  label: string;
  facts: string;
}

/** Bridge-lifecycle corroboration from the arm's metrics.jsonl (recorded,
 * never part of the semantic comparison). */
export interface ArmCorroboration {
  workerStartsTotalLast: number;
  workerRunCount: number;
  snapshotFreeRunCount: number;
  hydrateStageRunCount: number;
}

export interface SequenceArmOutcome {
  steps: OracleStep[];
  /** Terminal change-set state per mutation label (non-vacuity surface). */
  terminalStates: Record<string, string>;
  mutationCount: number;
  publishedCount: number;
  addParameterPublishedCount: number;
  finalGeneration: string;
  finalTreeDigest: string;
  corroboration: ArmCorroboration;
}

export interface OracleMismatch {
  sequence: OracleSequenceName;
  step: string;
  oneShot: string;
  persistent: string;
}

export interface SequenceComparison {
  name: OracleSequenceName;
  oneShot: SequenceArmOutcome;
  persistent: SequenceArmOutcome;
}

export interface OracleReport {
  seed: number;
  sequences: SequenceComparison[];
  steps: { sequence: OracleSequenceName; label: string; matched: boolean }[];
  mismatches: OracleMismatch[];
}

// ---------------------------------------------------------------------------
// Canonicalization.
// ---------------------------------------------------------------------------

/** Response keys whose values are per-run opaque identifiers minted by the
 * daemon (they cannot match across two independent runs); everything else —
 * node ids, names, payloads, digests, states, diagnostics — is compared
 * verbatim. */
const OPAQUE_ID_KEYS = new Set(["changeSetId", "operationId"]);

function normalizeOpaqueIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeOpaqueIds);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        OPAQUE_ID_KEYS.has(key)
          ? entry === null
            ? null
            : "<opaque-id>"
          : normalizeOpaqueIds(entry)
      ])
    );
  }
  return value;
}

/** Deterministic JSON: object keys sorted at every depth. */
function canonicalJson(value: unknown): string {
  const sortKeys = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortKeys);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, entry]) => [key, sortKeys(entry)])
      );
    }
    return input;
  };
  return JSON.stringify(sortKeys(value), null, 2);
}

function fact(label: string, value: unknown): OracleStep {
  return { label, facts: canonicalJson(normalizeOpaqueIds(value)) };
}

// ---------------------------------------------------------------------------
// Protocol driving primitives (mirrors the persistentBridge.test.ts flow).
// ---------------------------------------------------------------------------

const TERMINAL_STATES = new Set([
  "published",
  "validation_failed",
  "needs_decision",
  "failed",
  "cancelled"
]);
const MAX_ADVANCES = 12;
const INSPECT_BATCH = 200;

type ChangeSetResult = ReturnType<typeof asChangeSet>;

function asChangeSet(result: CoordinationResult) {
  return expectResult(result, "change_set");
}

interface DrivenChangeSet {
  changeSetId: string;
  submit: ChangeSetResult;
  advances: ChangeSetResult[];
  terminal: ChangeSetResult;
}

async function beginPopulateSubmit(
  client: CoordinationClient,
  reasoning: string,
  intents: readonly CoordinationIntent[]
): Promise<{ changeSetId: string; submit: ChangeSetResult }> {
  const begun = asChangeSet(await client.beginChangeSet(reasoning, SUBMIT_DEADLINE_MS));
  for (const intent of intents) {
    asChangeSet(await client.addIntent(begun.changeSetId, intent, SUBMIT_DEADLINE_MS));
  }
  const submit = asChangeSet(await client.submitChangeSet(begun.changeSetId, SUBMIT_DEADLINE_MS));
  return { changeSetId: begun.changeSetId, submit };
}

async function advanceUntilTerminal(
  client: CoordinationClient,
  changeSetId: string
): Promise<{ advances: ChangeSetResult[]; terminal: ChangeSetResult }> {
  const advances: ChangeSetResult[] = [];
  for (let attempt = 0; attempt < MAX_ADVANCES; attempt += 1) {
    const advanced = asChangeSet(await client.advanceChangeSet(changeSetId, ADVANCE_DEADLINE_MS));
    advances.push(advanced);
    if (TERMINAL_STATES.has(advanced.state)) return { advances, terminal: advanced };
  }
  throw new Error(`change set did not reach a terminal state within ${MAX_ADVANCES} advances`);
}

async function driveChangeSet(
  client: CoordinationClient,
  reasoning: string,
  intents: readonly CoordinationIntent[]
): Promise<DrivenChangeSet> {
  const { changeSetId, submit } = await beginPopulateSubmit(client, reasoning, intents);
  const { advances, terminal } = await advanceUntilTerminal(client, changeSetId);
  return { changeSetId, submit, advances, terminal };
}

async function inspectPayloads(
  client: CoordinationClient,
  nodeIds: readonly string[]
): Promise<{ graphGeneration: string; payloads: Record<string, string> }> {
  const ids = [...new Set(nodeIds)].sort();
  const payloads: Record<string, string> = {};
  let graphGeneration = "0";
  for (let index = 0; index < ids.length; index += INSPECT_BATCH) {
    const inspected = expectResult(
      await client.inspectNodes(ids.slice(index, index + INSPECT_BATCH), DISCOVERY_DEADLINE_MS),
      "nodes"
    );
    graphGeneration = inspected.graphGeneration;
    for (const node of inspected.nodes) payloads[node.nodeId] = node.payload;
  }
  return { graphGeneration, payloads };
}

/** Semantic facts of one fully driven mutation: transitions, publication
 * content, post-publication re-inspection of every affected node. Affected
 * node ids of published operations accumulate into `affectedCollector` for
 * the arm's final-tree reconstruction. */
async function mutationFacts(
  client: CoordinationClient,
  driven: DrivenChangeSet,
  affectedCollector: Set<string>
): Promise<Record<string, unknown>> {
  const facts: Record<string, unknown> = {
    submit: driven.submit,
    advanceStates: driven.advances.map((advance) => ({
      state: advance.state,
      ticketState: advance.ticketState
    })),
    terminal: driven.terminal,
    operationPublished: driven.terminal.operationId !== null
  };
  if (driven.terminal.state === "published" && driven.terminal.operationId !== null) {
    const operation = expectResult(
      await client.readOperation(driven.terminal.operationId, DISCOVERY_DEADLINE_MS),
      "operation"
    );
    facts.operation = operation;
    facts.affectedPayloads = (await inspectPayloads(client, operation.affectedNodeIds)).payloads;
    for (const nodeId of operation.affectedNodeIds) affectedCollector.add(nodeId);
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Sequence drivers. Each receives one running arm (its own daemon) plus the
// arm-independent seeded choices, and returns labeled steps.
// ---------------------------------------------------------------------------

interface ArmSession {
  newClient(role: string): CoordinationClient;
  manifest: QualifiedTaskManifest;
  /** Every affected node id of every published operation in this arm. */
  affectedNodeIds: Set<string>;
}

/** Free choices for a whole oracle run, drawn ONCE from the seed and then
 * replayed identically by both arms. */
interface SeededChoices {
  /** Order of sequential-2's two independent add_parameter steps. */
  addParameterOrder: "greet-first" | "serialize-first";
  /** Which overlapping change set leads the concurrent advance alternation. */
  concurrentLeader: "change-set-a" | "change-set-b";
}

export function drawSeededChoices(seed: number): SeededChoices {
  const rng = seededRng(seed);
  return {
    addParameterOrder: rng() < 0.5 ? "greet-first" : "serialize-first",
    concurrentLeader: rng() < 0.5 ? "change-set-a" : "change-set-b"
  };
}

async function findUniqueDeclaration(
  client: CoordinationClient,
  name: string,
  kind: "interface" | "function"
): Promise<{ nodeId: string; discovery: unknown }> {
  const discovery = expectResult(
    await client.findDeclarations(name, { kind }, DISCOVERY_DEADLINE_MS),
    "declarations"
  );
  if (discovery.declarations.length !== 1) {
    throw new Error(
      `expected exactly one ${kind} declaration named ${name}; found ${discovery.declarations.length}`
    );
  }
  return { nodeId: discovery.declarations[0]!.nodeId, discovery };
}

type RenameSpec = { kind: "interface" | "function"; fromName: string; toName: string };

async function runRenameStep(
  session: ArmSession,
  client: CoordinationClient,
  steps: OracleStep[],
  terminalStates: Record<string, string>,
  spec: RenameSpec
): Promise<DrivenChangeSet> {
  // Step-indexed so repeated there-and-back renames keep distinct labels.
  const label = `step${steps.length}-rename-${spec.fromName}-to-${spec.toName}`;
  const target = await findUniqueDeclaration(client, spec.fromName, spec.kind);
  const driven = await driveChangeSet(client, `oracle: ${label}`, [
    { type: "rename_symbol", declarationId: target.nodeId, newName: spec.toName }
  ]);
  steps.push(
    fact(label, {
      discovery: target.discovery,
      ...(await mutationFacts(client, driven, session.affectedNodeIds))
    })
  );
  terminalStates[label] = driven.terminal.state;
  return driven;
}

function addParameterIntent(
  manifest: QualifiedTaskManifest,
  target: "greet" | "serialize"
): CoordinationIntent {
  // The registered R/X-packet parameter tasks, reused verbatim so the values
  // are known-well-typed against the registered corpus.
  return target === "greet"
    ? {
        type: "add_parameter",
        functionId: manifest.targets.greet.stableId,
        name: "excited",
        typeText: "boolean",
        position: 1,
        value: "false"
      }
    : {
        type: "add_parameter",
        functionId: manifest.targets.serialize.stableId,
        name: "displayLabel",
        typeText: "string",
        position: 1,
        value: "UserTypes.displayUser(user)"
      };
}

async function runAddParameterStep(
  session: ArmSession,
  client: CoordinationClient,
  steps: OracleStep[],
  terminalStates: Record<string, string>,
  target: "greet" | "serialize"
): Promise<DrivenChangeSet> {
  const label = `add-parameter-${target}`;
  // The function id comes from the registered manifest (stable across both
  // arms by the stable-ID invariant); the discovery fact still probes the
  // query surface for equality across arms.
  const discovery = expectResult(
    await client.findDeclarations(target, { kind: "function" }, DISCOVERY_DEADLINE_MS),
    "declarations"
  );
  const driven = await driveChangeSet(client, `oracle: ${label}`, [
    addParameterIntent(session.manifest, target)
  ]);
  steps.push(
    fact(label, { discovery, ...(await mutationFacts(client, driven, session.affectedNodeIds)) })
  );
  terminalStates[label] = driven.terminal.state;
  return driven;
}

async function runSequential1(
  session: ArmSession
): Promise<{ steps: OracleStep[]; terminalStates: Record<string, string> }> {
  const client = session.newClient("sequential-1");
  const steps: OracleStep[] = [];
  const terminalStates: Record<string, string> = {};
  for (let index = 0; index < 6; index += 1) {
    const fromName = index % 2 === 0 ? "User" : "Account";
    const toName = index % 2 === 0 ? "Account" : "User";
    await runRenameStep(session, client, steps, terminalStates, {
      kind: "interface",
      fromName,
      toName
    });
  }
  return { steps, terminalStates };
}

async function runSequential2(
  session: ArmSession,
  choices: SeededChoices
): Promise<{ steps: OracleStep[]; terminalStates: Record<string, string> }> {
  const client = session.newClient("sequential-2");
  const steps: OracleStep[] = [];
  const terminalStates: Record<string, string> = {};
  const parameterTargets: ("greet" | "serialize")[] =
    choices.addParameterOrder === "greet-first" ? ["greet", "serialize"] : ["serialize", "greet"];
  for (const target of parameterTargets) {
    await runAddParameterStep(session, client, steps, terminalStates, target);
  }
  const renames: RenameSpec[] = [
    { kind: "function", fromName: "formatTimestamp", toName: "renderTimestamp" },
    { kind: "interface", fromName: "User", toName: "Account" },
    { kind: "function", fromName: "renderTimestamp", toName: "formatTimestamp" },
    { kind: "interface", fromName: "Account", toName: "User" }
  ];
  for (const spec of renames) {
    await runRenameStep(session, client, steps, terminalStates, spec);
  }
  return { steps, terminalStates };
}

async function runConcurrent(
  session: ArmSession,
  choices: SeededChoices
): Promise<{ steps: OracleStep[]; terminalStates: Record<string, string> }> {
  const clientA = session.newClient("concurrent-a");
  const clientB = session.newClient("concurrent-b");
  const steps: OracleStep[] = [];
  const terminalStates: Record<string, string> = {};

  // Overlap the full lifecycles: both change sets are begun, populated, and
  // submitted before either advances.
  const userTarget = await findUniqueDeclaration(clientA, "User", "interface");
  const formatTarget = await findUniqueDeclaration(clientB, "formatTimestamp", "function");
  const a = await beginPopulateSubmit(clientA, "oracle: concurrent rename User to Account", [
    { type: "rename_symbol", declarationId: userTarget.nodeId, newName: "Account" }
  ]);
  const b = await beginPopulateSubmit(
    clientB,
    "oracle: concurrent rename formatTimestamp to renderTimestamp",
    [{ type: "rename_symbol", declarationId: formatTarget.nodeId, newName: "renderTimestamp" }]
  );
  steps.push(fact("concurrent-submits", { leader: choices.concurrentLeader, a: a.submit, b: b.submit }));

  // Alternate advances, seed-chosen leader first, until both are terminal.
  const lanes: { label: string; client: CoordinationClient; changeSetId: string }[] = [
    { label: "change-set-a", client: clientA, changeSetId: a.changeSetId },
    { label: "change-set-b", client: clientB, changeSetId: b.changeSetId }
  ];
  if (choices.concurrentLeader === "change-set-b") lanes.reverse();
  const drives = new Map<string, ChangeSetResult[]>(lanes.map((lane) => [lane.label, []]));
  const terminals = new Map<string, ChangeSetResult>();
  for (let round = 0; round < MAX_ADVANCES && terminals.size < lanes.length; round += 1) {
    for (const lane of lanes) {
      if (terminals.has(lane.label)) continue;
      const advanced = asChangeSet(
        await lane.client.advanceChangeSet(lane.changeSetId, ADVANCE_DEADLINE_MS)
      );
      drives.get(lane.label)!.push(advanced);
      if (TERMINAL_STATES.has(advanced.state)) terminals.set(lane.label, advanced);
    }
  }
  if (terminals.size < lanes.length) {
    throw new Error("concurrent change sets did not both terminate");
  }
  for (const lane of lanes) {
    const terminal = terminals.get(lane.label)!;
    const driven: DrivenChangeSet = {
      changeSetId: lane.changeSetId,
      submit: lane.label === "change-set-a" ? a.submit : b.submit,
      advances: drives.get(lane.label)!,
      terminal
    };
    steps.push(
      fact(
        `concurrent-${lane.label}`,
        await mutationFacts(lane.client, driven, session.affectedNodeIds)
      )
    );
    terminalStates[lane.label] = terminal.state;
  }
  return { steps, terminalStates };
}

async function runFailpoint(
  session: ArmSession
): Promise<{ steps: OracleStep[]; terminalStates: Record<string, string> }> {
  const renameClient = session.newClient("failpoint-rename");
  const staleClient = session.newClient("failpoint-parameter");
  const steps: OracleStep[] = [];
  const terminalStates: Record<string, string> = {};

  // Overlap: the rename submits first, the parameter change set second (its
  // analysis binds to the pre-rename generation), then the rename publishes.
  const displayUser = await findUniqueDeclaration(renameClient, "displayUser", "function");
  const rename = await beginPopulateSubmit(renameClient, "oracle: failpoint rename displayUser", [
    { type: "rename_symbol", declarationId: displayUser.nodeId, newName: "formatUser" }
  ]);
  const staleIntent = addParameterIntent(session.manifest, "serialize");
  const stale = await beginPopulateSubmit(
    staleClient,
    "oracle: failpoint stale add_parameter serialize",
    [staleIntent]
  );

  const renameDrive = await advanceUntilTerminal(renameClient, rename.changeSetId);
  const renameDriven: DrivenChangeSet = { ...rename, ...renameDrive };
  steps.push(
    fact("rename-displayUser", {
      discovery: displayUser.discovery,
      ...(await mutationFacts(renameClient, renameDriven, session.affectedNodeIds))
    })
  );
  terminalStates["rename-displayUser"] = renameDrive.terminal.state;

  // The publication above invalidates the stale claim: the REAL refusal path
  // (needs_decision + renamed-symbol surface), not an injected fault.
  const staleDrive = await advanceUntilTerminal(staleClient, stale.changeSetId);
  steps.push(
    fact("stale-add-parameter", {
      submit: stale.submit,
      advanceStates: staleDrive.advances.map((advance) => ({
        state: advance.state,
        ticketState: advance.ticketState
      })),
      terminal: staleDrive.terminal,
      renamedSymbols: staleDrive.terminal.renamedSymbols,
      diagnostics: staleDrive.terminal.diagnostics
    })
  );
  terminalStates["stale-add-parameter"] = staleDrive.terminal.state;

  const cancelled = await staleClient.request(
    { type: "cancel_change_set", changeSetId: stale.changeSetId },
    SUBMIT_DEADLINE_MS
  );
  steps.push(fact("cancel-stale", cancelled));
  terminalStates["cancel-stale"] = "cancelled";

  // Fresh decision: the rewritten value derives PURELY from the
  // needs_decision response's renamed-symbol surface (the X-packet recipe).
  let rewrittenValue = staleIntent.type === "add_parameter" ? staleIntent.value : "";
  for (const renamed of staleDrive.terminal.renamedSymbols) {
    rewrittenValue = rewrittenValue.split(renamed.previousName).join(renamed.currentName);
  }
  const freshDriven = await driveChangeSet(staleClient, "oracle: failpoint fresh decision", [
    { ...(staleIntent as Extract<CoordinationIntent, { type: "add_parameter" }>), value: rewrittenValue }
  ]);
  steps.push(
    fact("fresh-decision-add-parameter", {
      rewrittenValue,
      ...(await mutationFacts(staleClient, freshDriven, session.affectedNodeIds))
    })
  );
  terminalStates["fresh-decision-add-parameter"] = freshDriven.terminal.state;
  return { steps, terminalStates };
}

// ---------------------------------------------------------------------------
// Arm runner: one fresh daemon per (sequence, arm), driven sequentially.
// ---------------------------------------------------------------------------

function corroborate(metricsText: string): ArmCorroboration {
  const records = parseMetricsJsonl(metricsText);
  const requests = records.filter((record): record is RequestRecord => record.kind === "request");
  const runs = records.filter((record): record is WorkerRunRecord => record.kind === "workerRun");
  return {
    workerStartsTotalLast: requests.at(-1)?.workerStartsTotal ?? 0,
    workerRunCount: runs.length,
    snapshotFreeRunCount: runs.filter(
      (run) => run.snapshotBytes === 0 && run.snapshotBuildNs === 0
    ).length,
    hydrateStageRunCount: runs.filter((run) => (run.worker?.hydrateNs ?? null) !== null).length
  };
}

async function runSequenceArm(
  corpusRoot: string,
  manifest: QualifiedTaskManifest,
  registeredStatementIds: readonly string[],
  name: OracleSequenceName,
  persistent: boolean,
  choices: SeededChoices
): Promise<SequenceArmOutcome> {
  const directory = mkdtempSync(join(tmpdir(), "strata-oracle-"));
  const metricsPath = join(directory, "metrics.jsonl");
  const service = await startKernelService(corpusRoot, {
    binaryPath: kernelServiceBinary(),
    env: credentialFreeEnv(),
    directory,
    extraArgs: ["--metrics", metricsPath, ...(persistent ? ["--persistent-bridge"] : [])]
  });
  try {
    const session: ArmSession = {
      manifest,
      affectedNodeIds: new Set<string>(),
      newClient: (role) =>
        new CoordinationClient({
          socketPath: service.socketPath,
          // Fixed identity per (sequence, role), identical across arms, so
          // actor-bearing surfaces (operations) compare verbatim.
          clientId: `oracle:${name}:${role}`
        })
    };
    const helloClient = session.newClient("hello");
    await helloClient.hello(DISCOVERY_DEADLINE_MS);

    const driven =
      name === "sequential-1"
        ? await runSequential1(session)
        : name === "sequential-2"
          ? await runSequential2(session, choices)
          : name === "concurrent"
            ? await runConcurrent(session, choices)
            : await runFailpoint(session);

    // Final tree state, reconstructed the way `materializeFinalTree` does
    // (in memory): re-inspect every operation-affected REGISTERED statement,
    // overlay onto the manifest's generation-zero statement payloads, and
    // digest every registered file's reconstructed text in path order.
    const registered = new Set(registeredStatementIds);
    const updatedIds = [...session.affectedNodeIds].filter((id) => registered.has(id)).sort();
    const finalClient = session.newClient("final-state");
    const finalState =
      updatedIds.length > 0
        ? await inspectPayloads(finalClient, updatedIds)
        : // Generation probe only: nothing published, nothing to overlay.
          await inspectPayloads(finalClient, [manifest.targets.User.stableId]);
    const updated = updatedIds.length > 0 ? finalState.payloads : {};
    const digest = createHash("sha256");
    for (const [path, file] of Object.entries(manifest.sourceFiles).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    )) {
      const text = file.statementIds
        .map((id, index) => updated[id] ?? file.statementPayloads[index]!)
        .join("");
      digest.update(path);
      digest.update("\u0000");
      digest.update(text);
      digest.update("\u0000");
    }
    const finalTreeDigest = digest.digest("hex");

    const publishedCount = Object.values(driven.terminalStates).filter(
      (state) => state === "published"
    ).length;
    const addParameterPublishedCount = Object.entries(driven.terminalStates).filter(
      ([label, state]) =>
        state === "published" && (label.startsWith("add-parameter-") || label.includes("add-parameter"))
    ).length;
    return {
      steps: [
        ...driven.steps,
        fact("<final-tree>", {
          finalGeneration: finalState.graphGeneration,
          finalTreeDigest
        })
      ],
      terminalStates: driven.terminalStates,
      mutationCount: Object.keys(driven.terminalStates).length,
      publishedCount,
      addParameterPublishedCount,
      finalGeneration: finalState.graphGeneration,
      finalTreeDigest,
      corroboration: corroborate(readFileSync(metricsPath, "utf8"))
    };
  } finally {
    await service.stop({ preserveDirectory: true });
    rmSync(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The oracle.
// ---------------------------------------------------------------------------

export async function runDifferentialOracle(
  corpusRootInput: string,
  options: OracleOptions
): Promise<OracleReport> {
  const corpusRoot = resolve(corpusRootInput);
  const names = options.sequences ?? ORACLE_SEQUENCES;
  const manifest = createQualifiedTaskManifest(corpusRoot);
  const registeredStatementIds = [
    ...new Set(Object.values(manifest.sourceFiles).flatMap((file) => file.statementIds))
  ].sort();
  const choices = drawSeededChoices(options.seed);

  const sequences: SequenceComparison[] = [];
  for (const name of names) {
    // Arms run sequentially, each against its OWN daemon and store directory
    // seeded from the same pristine corpus; `--persistent-bridge` is the
    // only difference between them.
    const oneShot = await runSequenceArm(
      corpusRoot,
      manifest,
      registeredStatementIds,
      name,
      false,
      choices
    );
    const persistent = await runSequenceArm(
      corpusRoot,
      manifest,
      registeredStatementIds,
      name,
      true,
      choices
    );
    sequences.push({ name, oneShot, persistent });
  }

  const steps: OracleReport["steps"] = [];
  const mismatches: OracleMismatch[] = [];
  for (const { name, oneShot, persistent } of sequences) {
    const length = Math.max(oneShot.steps.length, persistent.steps.length);
    for (let index = 0; index < length; index += 1) {
      const reference = oneShot.steps[index];
      const mirrored = persistent.steps[index];
      const label = reference?.label ?? mirrored?.label ?? `<step-${index}>`;
      const matched =
        reference !== undefined &&
        mirrored !== undefined &&
        reference.label === mirrored.label &&
        reference.facts === mirrored.facts;
      steps.push({ sequence: name, label, matched });
      if (!matched) {
        mismatches.push({
          sequence: name,
          step: label,
          oneShot: reference ? `${reference.label}\n${reference.facts}` : "<absent>",
          persistent: mirrored ? `${mirrored.label}\n${mirrored.facts}` : "<absent>"
        });
      }
    }
  }
  return { seed: options.seed, sequences, steps, mismatches };
}
