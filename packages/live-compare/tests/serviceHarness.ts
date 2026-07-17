import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { CoordinationClient, type CoordinationIntent } from "../src/client.js";
import { materializeFinalTree, startKernelService, type RunningKernelService } from "../src/service.js";
import {
  createQualifiedTaskManifest,
  type Phase6PacketId,
  type TaskAssignment
} from "../src/tasks.js";
import { verifyPhase6Tree } from "../src/verify.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
let built = false;

function credentialFreeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

function ensureBuilt(): void {
  if (built) return;
  for (const [command, args] of [
    ["pnpm", ["--filter", "@strata/kernel-bridge", "build"]],
    ["cargo", ["build", "-p", "strata-kernel", "--bin", "strata-kernel-service"]]
  ] as const) {
    const result = spawnSync(command, args, { cwd: repoRoot, env: credentialFreeEnv(), encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${command} build failed\n${result.stdout}\n${result.stderr}`);
  }
  built = true;
}

async function startService(corpusRoot: string): Promise<RunningKernelService> {
  ensureBuilt();
  return startKernelService(corpusRoot, { env: credentialFreeEnv() });
}

async function beginAndSubmit(client: CoordinationClient, assignment: TaskAssignment, reasoning: string) {
  const begun = await client.request({ type: "begin_change_set", reasoning }, 120_000) as any;
  for (const intent of assignment.intents) {
    await client.request({ type: "add_intent", changeSetId: begun.changeSetId, intent }, 120_000);
  }
  return client.request({ type: "submit_change_set", changeSetId: begun.changeSetId }, 120_000) as Promise<any>;
}

async function advanceUntilTerminal(client: CoordinationClient, changeSetId: string): Promise<{ result: any; advances: number }> {
  let result: any;
  for (let advances = 1; advances <= 8; advances += 1) {
    result = await client.request({ type: "advance_change_set", changeSetId }, 120_000);
    if (["published", "validation_failed", "needs_decision", "failed", "cancelled"].includes(result.state)) return { result, advances };
  }
  throw new Error(`change set ${changeSetId} did not terminate`);
}

async function allEvents(client: CoordinationClient): Promise<any[]> {
  const response = await client.request({ type: "read_events", afterSequence: "0", limit: 256 }, 120_000) as any;
  return response.events;
}

// Drives the daemon on an arbitrary corpus root (no manifest digest gate)
// with two rename intents resolved by name. Used by the module-granularity
// regression pin in mMechanism.test.ts.
export async function probeSameModulePair(
  corpusRoot: string,
  firstName: string,
  firstNewName: string,
  secondName: string,
  secondNewName: string
) {
  const { ingestBatch } = await import("@strata/ingest");
  const { readdirSync } = await import("node:fs");
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (path.endsWith(".ts")) files.push(path);
    }
  };
  visit(join(corpusRoot, "src"));
  const batch = ingestBatch(files.map((path) => ({ path, text: readFileSync(path, "utf8") })));
  const declarationId = (name: string): string => {
    const matches = batch.allNodes.filter((node: any) => new RegExp(`\\bfunction\\s+${name}\\b`).test(node.payload));
    if (matches.length !== 1) throw new Error(`unresolved probe target ${name}`);
    return matches[0]!.id;
  };
  const service = await startService(corpusRoot);
  try {
    const clients = [
      new CoordinationClient({ socketPath: service.socketPath, clientId: "probe:pair:1" }),
      new CoordinationClient({ socketPath: service.socketPath, clientId: "probe:pair:2" })
    ];
    const intent = (name: string, newName: string): TaskAssignment => ({
      role: "agent-1",
      taskBody: "",
      taskBodyBytes: "",
      intents: [{ type: "rename_symbol", declarationId: declarationId(name), newName }],
      strataTargets: [],
      baselineTargets: [],
      promptHashes: { strata: "", baseline: "" }
    });
    const submitted1 = await beginAndSubmit(clients[0]!, intent(firstName, firstNewName), "probe first");
    const submitted2 = await beginAndSubmit(clients[1]!, intent(secondName, secondNewName), "probe second");
    const first = await advanceUntilTerminal(clients[0]!, submitted1.changeSetId);
    const second = await advanceUntilTerminal(clients[1]!, submitted2.changeSetId);
    return {
      submitStates: [submitted1.state, submitted2.state],
      firstState: first.result.state,
      firstGeneration: first.result.graphGeneration,
      secondState: second.result.state,
      secondGeneration: second.result.graphGeneration,
      secondAdvances: second.advances
    };
  } finally {
    await service.stop();
  }
}

export async function runQualifiedServicePacket(input: {
  corpusRoot: string;
  packetId: Phase6PacketId;
  order: "agent-1-first" | "agent-2-first";
}) {
  const manifest = createQualifiedTaskManifest(input.corpusRoot);
  const service = await startService(input.corpusRoot);
  let finalTree: string | undefined;
  try {
    const clients = [
      new CoordinationClient({ socketPath: service.socketPath, clientId: `phase6:${input.packetId}:agent-1` }),
      new CoordinationClient({ socketPath: service.socketPath, clientId: `phase6:${input.packetId}:agent-2` })
    ];
    const assignments = manifest.packets[input.packetId].assignments;
    let negativeControlGeneration: number | undefined;
    if (input.packetId === "G") {
      const parameterOnly: TaskAssignment = { ...assignments[0]!, intents: [assignments[0]!.intents[1]!] };
      const negative = await beginAndSubmit(clients[0]!, parameterOnly, "G negative standalone parameter control");
      const terminal = await advanceUntilTerminal(clients[0]!, negative.changeSetId);
      if (terminal.result.state === "published") throw new Error("G standalone parameter unexpectedly published");
      negativeControlGeneration = Number(terminal.result.graphGeneration);
    }
    const firstIndex = input.order === "agent-1-first" ? 0 : 1;
    const secondIndex = firstIndex === 0 ? 1 : 0;
    const submitted: any[] = [];
    submitted[firstIndex] = await beginAndSubmit(clients[firstIndex]!, assignments[firstIndex]!, `${input.packetId} ${assignments[firstIndex]!.role}`);
    submitted[secondIndex] = await beginAndSubmit(clients[secondIndex]!, assignments[secondIndex]!, `${input.packetId} ${assignments[secondIndex]!.role}`);
    const initialSubmitStates = [submitted[0].state, submitted[1].state];
    const published: any[] = [];
    const eventKinds: string[] = [];
    let scopeExpandedBeforePublishAdvance = false;
    let staleX2State: string | undefined;
    let staleRenamedSymbols: { nodeId: string; previousName: string; currentName: string }[] | undefined;
    let derivedFreshValue: string | undefined;
    const first = await advanceUntilTerminal(clients[firstIndex]!, submitted[firstIndex].changeSetId);
    if (first.result.state !== "published") throw new Error(`${input.packetId} first assignment failed: ${JSON.stringify(first.result)}`);
    published.push(first.result);
    if (input.packetId === "X" && firstIndex === 0) {
      const stale = await advanceUntilTerminal(clients[1]!, submitted[1].changeSetId);
      if (stale.result.state !== "needs_decision") {
        throw new Error(`stale X2 must surface needs_decision after the rename: ${JSON.stringify(stale.result)}`);
      }
      staleX2State = stale.result.state;
      staleRenamedSymbols = stale.result.renamedSymbols;
      await clients[1]!.request({ type: "cancel_change_set", changeSetId: submitted[1].changeSetId }, 120_000);
      // The fresh decision derives the rewritten intent content purely from
      // the needs_decision response: every previous name surfaced by the
      // service is replaced with its current name. No out-of-band knowledge
      // of the rename is used.
      const replacement = structuredClone(assignments[1]!) as TaskAssignment;
      const staleIntent = replacement.intents[0] as Extract<CoordinationIntent, { type: "add_parameter" }>;
      for (const renamed of stale.result.renamedSymbols ?? []) {
        staleIntent.value = staleIntent.value.split(renamed.previousName).join(renamed.currentName);
      }
      derivedFreshValue = staleIntent.value;
      submitted[1] = await beginAndSubmit(clients[1]!, replacement, "X2 fresh decision after rename");
    }
    if (input.packetId === "X" && firstIndex === 1) {
      const before = await allEvents(clients[0]!);
      eventKinds.push(...before.map((event) => event.kind));
      const expandedIndex = before.findIndex((event) => event.kind === "scope_expanded");
      const readyIndex = before.findIndex(
        (event, index) => index > expandedIndex && event.kind === "intent_ready"
      );
      scopeExpandedBeforePublishAdvance = expandedIndex >= 0 && readyIndex > expandedIndex;
    }
    let second = await advanceUntilTerminal(clients[secondIndex]!, submitted[secondIndex].changeSetId);
    let freshDecisions = 0;
    if (second.result.state === "needs_decision") {
      // The kernel refuses authority derived from stale generation-zero
      // analysis (full_key_free acceptance row 2). The client records a fresh
      // decision: cancel the stale change set and resubmit the identical
      // typed intents against current state. Intents are stable-ID-based, so
      // they survive sibling renames unchanged.
      freshDecisions += 1;
      await clients[secondIndex]!.request({ type: "cancel_change_set", changeSetId: submitted[secondIndex].changeSetId }, 120_000);
      submitted[secondIndex] = await beginAndSubmit(
        clients[secondIndex]!,
        assignments[secondIndex]!,
        `${input.packetId} ${assignments[secondIndex]!.role} fresh decision after prior publication`
      );
      second = await advanceUntilTerminal(clients[secondIndex]!, submitted[secondIndex].changeSetId);
    }
    if (second.result.state !== "published") throw new Error(`${input.packetId} second assignment failed: ${JSON.stringify(second.result)}`);
    published.push(second.result);
    for (const client of clients) eventKinds.push(...(await allEvents(client)).map((event) => event.kind));
    const affectedNodeIdsForMaterialize = published.flatMap((result) => result.affectedNodeIds);
    finalTree = await materializeFinalTree(clients[0]!, input.corpusRoot, manifest, affectedNodeIdsForMaterialize);
    const verification = await verifyPhase6Tree({ treeRoot: finalTree, manifest, packetId: input.packetId, generationZero: false, arm: "strata" });
    const finalSource = Object.keys(manifest.sourceFiles).map((path) => readFileSync(join(finalTree!, path), "utf8")).join("\n");
    const auditActions = readFileSync(service.auditPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).event.action).filter(Boolean);
    const affectedNodeIds = [...new Set(published.flatMap((result) => result.affectedNodeIds))];
    return {
      green: verification.green,
      generation: Number(published.at(-1)!.graphGeneration),
      operationIds: published.map((result) => result.operationId),
      affectedNodeIds,
      aggregateAffectedNodeIds: (firstIndex === 0 ? published[0] : published[1])!.affectedNodeIds,
      auditActions: auditActions.filter((action) => action === "advance_change_set").slice(-2),
      submittedStates: initialSubmitStates,
      stableDeclarationId: input.packetId === "S" || input.packetId === "G" ? manifest.targets.greet.stableId : undefined,
      finalDeclarationId: input.packetId === "S" || input.packetId === "G" ? manifest.targets.greet.stableId : undefined,
      negativeControlGeneration,
      eventKinds,
      scopeExpandedBeforePublishAdvance,
      freshDecisions,
      secondAdvances: second.advances,
      staleX2State,
      staleRenamedSymbols,
      derivedFreshValue,
      publicationDigest: published.at(-1)!.publicationDigest,
      finalTreeDigest: verification.finalTreeDigest,
      finalSource
    };
  } finally {
    if (finalTree) rmSync(finalTree, { recursive: true, force: true });
    await service.stop();
  }
}
