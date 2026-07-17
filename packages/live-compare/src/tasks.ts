import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { ingestBatch, toKernelSnapshot } from "@strata/ingest";
import type { CoordinationIntent } from "./client.js";

export const APPROVED_CORPUS_VARIANT = "x-namespace-enriched-v1" as const;
export const APPROVED_SOURCE_DIGEST =
  "41c9059a91e814995471708fa3cd165dc15a1f45f492b809d01831978b3c6eb8";
export const APPROVED_TASK_REGISTRATION_DIGEST =
  "c792052fb3652c229640574ac140ee79febc917e07789daf41822edf6a031257";
const APPROVED_EXCLUDED_INPUTS = {
  "tests/dateRange.test.ts": "f08c8a6decf0a3a0ff497095f47dab187a7b6b89adfd89bf65b309ea52c41426",
  "tests/format.test.ts": "2edd2fb64537bac614185c220ee9a0cf6031dd65a7de471a5aa576c9ed34361b"
} as const;
export type Phase6PacketId = "D" | "M" | "R" | "S" | "X" | "G";
export type Phase6TargetName =
  | "User"
  | "formatTimestamp"
  | "logEvent"
  | "eventLine"
  | "greet"
  | "displayUser"
  | "serialize";

export interface QualifiedTarget {
  name: Phase6TargetName;
  stableId: string;
  kind: string;
  baselineLocator: { path: string; symbol: string };
  incomingReferenceIds: string[];
  statementIds: string[];
  sourcePaths: string[];
}

export interface BoundaryEntry {
  path: string;
  target: Phase6TargetName | null;
  classification: "resolved_reference_and_textual_occurrences" | "textual_occurrence" | "no_task_target_reference";
  textualOccurrenceCount: number;
  resolvedReferenceCount: number;
  contentDigest: string;
  disposition: "frozen_excluded_historical";
}

export interface TaskAssignment {
  role: "agent-1" | "agent-2";
  taskBody: string;
  taskBodyBytes: string;
  intents: CoordinationIntent[];
  /** Arm-equivalent target addressing: the Strata arm gets registered stable IDs. */
  strataTargets: { name: string; stableId: string }[];
  /** The baseline arm gets the same targets as file locations and symbol names. */
  baselineTargets: { name: string; path: string }[];
  promptHashes: { strata: string; baseline: string };
}

export interface Phase6Packet {
  id: Phase6PacketId;
  singleSite: boolean;
  assignments: TaskAssignment[];
  fixtureAllowlist: string[];
  fixtureDigests: Record<string, string>;
  allowedSourcePaths: string[];
  predicateDigest: string;
}

export interface QualifiedTaskManifest {
  schemaVersion: 1;
  corpusVariant: typeof APPROVED_CORPUS_VARIANT;
  sourceDigest: string;
  graphDigest: string;
  targets: Record<Phase6TargetName, QualifiedTarget>;
  packets: Record<Phase6PacketId, Phase6Packet>;
  singleSitePackets: Phase6PacketId[];
  greetNonCanonicalReferences: string[];
  sourceFiles: Record<string, { digest: string; text: string; statementIds: string[]; statementPayloads: string[] }>;
  excludedInputs: Record<string, string>;
  /**
   * Digest of every corpus file outside `src/`, including configuration
   * (package.json, tsconfig.json, vitest.config.ts) and historical tests.
   * The verifier rejects any change to these and any file not in the
   * registered inventory.
   */
  frozenTreeFiles: Record<string, string>;
  boundary: BoundaryEntry[];
  systemPromptHashes: { strata: string; baselineTask: string; baselineIntegration: string };
  registrationDigest: string;
}

const utf8 = new TextEncoder();
const FIXTURE_NAME = "phase6-invariant.mjs";
const STRATA_APPENDIX = "Use only the supplied stable IDs and Strata coordination tools. Do not inspect files or coordination authority internals.";
const BASELINE_APPENDIX = "Use the assigned Git worktree and normal file tools. Do not modify tests, configuration, or content outside src/**.";

/** Registered system prompts; one per session role class, frozen with the manifest. */
export const REGISTERED_SYSTEM_PROMPTS = Object.freeze({
  strata:
    "You are one of two independent coding agents sharing a Strata coordination service. " +
    "Complete your assigned structural task through the coordination lifecycle: begin a change set, " +
    "add your typed intent using the supplied stable IDs, submit, and advance until published. " +
    "If the service reports needs_decision, read current events, cancel the stale change set, and " +
    "record a fresh decision against current state. You have no file access; the coordination tools " +
    "are your only effect on the codebase.",
  baselineTask:
    "You are one of two independent coding agents working in separate Git worktrees of the same " +
    "TypeScript codebase. Complete your assigned task by editing files in your worktree only. Keep " +
    "the tree compiling. Do not modify tests or configuration.",
  baselineIntegration:
    "You are the integration agent for a two-branch team. Merge both captured task branches into " +
    "your worktree, resolve conflicts, complete unfinished task work, and leave one green tree. Use " +
    "normal file, shell, and Git tools."
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function posix(value: string): string {
  return value.split(sep).join("/");
}

function filesBelow(root: string, predicate: (path: string) => boolean): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (predicate(path)) result.push(path);
    }
  };
  visit(root);
  return result.sort((left, right) => posix(relative(root, left)).localeCompare(posix(relative(root, right))));
}

function digestSourceFiles(sourceFiles: Record<string, { text: string }>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(sourceFiles).sort()) {
    hash.update(path).update("\0").update(sourceFiles[path]!.text).update("\0");
  }
  return hash.digest("hex");
}

function targetPattern(name: Phase6TargetName): RegExp {
  return new RegExp(`\\b(?:interface|function)\\s+${name}\\b`);
}

function assertApprovedEnrichmentShape(sourceFiles: Record<string, { text: string }>): void {
  const user = sourceFiles["src/types/user.ts"]?.text ?? "";
  if (!/export function displayUser\(user: User\): string \{\n  return user\.email;\n\}/.test(user)) {
    throw new Error("x-namespace-enriched-v1 requires the appended displayUser helper in src/types/user.ts");
  }
  const serializer = sourceFiles["src/users/serializer.ts"]?.text ?? "";
  if (!serializer.includes('import * as UserTypes from "../types/user.ts";') || serializer.includes("import type * as UserTypes")) {
    throw new Error("x-namespace-enriched-v1 requires a value-capable UserTypes namespace import in src/users/serializer.ts");
  }
}

function assertPreEnrichmentIdsPreserved(sourceFiles: QualifiedTaskManifest["sourceFiles"]): void {
  const fixturePath = resolve(__dirname, "../tests/fixtures/tasks/pre-enrichment-statement-ids.json");
  const frozen = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    statements: Record<string, { id: string; childIndex: number; kind: string }[]>;
  };
  for (const [modulePath, statements] of Object.entries(frozen.statements)) {
    const registered = sourceFiles[modulePath];
    if (!registered) throw new Error(`pre-enrichment module ${modulePath} disappeared`);
    const ids = new Set(registered.statementIds);
    for (const statement of statements) {
      if (!ids.has(statement.id)) {
        throw new Error(`pre-enrichment stable ID churned: ${statement.kind} #${statement.childIndex} in ${modulePath}`);
      }
    }
  }
}

export function scanCanonicalBoundary(
  corpusRoot: string,
  targets: Record<Phase6TargetName, QualifiedTarget>
): BoundaryEntry[] {
  const names: Phase6TargetName[] = [
    "User", "formatTimestamp", "logEvent", "eventLine", "greet", "displayUser", "serialize"
  ];
  const entries: BoundaryEntry[] = [];
  const testsRoot = join(corpusRoot, "tests");
  const sourceInputs = filesBelow(join(corpusRoot, "src"), (path) => path.endsWith(".ts"));
  const testInputs = filesBelow(testsRoot, (path) => path.endsWith(".ts"));
  const batch = ingestBatch([...sourceInputs, ...testInputs].map((absolute) => ({
    path: absolute,
    text: readFileSync(absolute, "utf8")
  })));
  const nodeById = new Map(batch.allNodes.map((node) => [node.id, node]));
  const declarationByName = new Map(Object.values(targets).map((target) => [target.name, target.stableId]));
  const boundaryChildIds = new Map<string, string[]>();
  for (const node of batch.allNodes) {
    if (!node.parentId) continue;
    const siblings = boundaryChildIds.get(node.parentId);
    if (siblings) siblings.push(node.id);
    else boundaryChildIds.set(node.parentId, [node.id]);
  }
  const boundarySubtree = (rootId: string): Set<string> => {
    const subtree = new Set([rootId]);
    const queue = [rootId];
    while (queue.length > 0) {
      for (const child of boundaryChildIds.get(queue.pop()!) ?? []) {
        subtree.add(child);
        queue.push(child);
      }
    }
    return subtree;
  };
  for (const absolute of testInputs) {
    const path = posix(relative(corpusRoot, absolute));
    const text = readFileSync(absolute, "utf8");
    const digest = sha256(text);
    const found = names.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
    if (found.length === 0 && path === "tests/dateRange.test.ts") {
      entries.push({
        path,
        target: null,
        classification: "no_task_target_reference",
        textualOccurrenceCount: 0,
        resolvedReferenceCount: 0,
        contentDigest: digest,
        disposition: "frozen_excluded_historical"
      });
    }
    for (const target of found) {
      const textualOccurrenceCount = [...text.matchAll(new RegExp(`\\b${target}\\b`, "g"))].length;
      const subtree = boundarySubtree(declarationByName.get(target)!);
      const resolvedReferenceCount = batch.references.filter((reference) => {
        if (!subtree.has(reference.toNodeId) || subtree.has(reference.fromNodeId)) return false;
        let node = nodeById.get(reference.fromNodeId);
        while (node?.parentId) node = nodeById.get(node.parentId);
        return node?.payload === join(corpusRoot, path);
      }).length;
      entries.push({
        path,
        target,
        classification: resolvedReferenceCount > 0
          ? "resolved_reference_and_textual_occurrences"
          : "textual_occurrence",
        textualOccurrenceCount,
        resolvedReferenceCount,
        contentDigest: digest,
        disposition: "frozen_excluded_historical"
      });
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path) || String(left.target).localeCompare(String(right.target)));
}

/**
 * Exact registered Strata-arm prompt bytes: identical task body, then the
 * registered stable IDs the appendix refers to, then the arm appendix.
 */
export function strataTaskPrompt(
  assignment: Pick<TaskAssignment, "taskBody" | "strataTargets">
): string {
  const targets = assignment.strataTargets
    .map((target) => `- ${target.name}: ${target.stableId}`)
    .join("\n");
  return `Finish the assigned task and leave the team able to reach the shared success predicate.\n\n${assignment.taskBody}\n\nRegistered stable IDs:\n${targets}\n\n${STRATA_APPENDIX}`;
}

/**
 * Exact registered baseline-arm prompt bytes: identical task body, then the
 * same targets as file locations, then the arm appendix.
 */
export function baselineTaskPrompt(
  assignment: Pick<TaskAssignment, "taskBody" | "baselineTargets">
): string {
  const targets = assignment.baselineTargets
    .map((target) => `- ${target.name} in ${target.path}`)
    .join("\n");
  return `Finish the assigned task and leave the team able to reach the shared success predicate.\n\n${assignment.taskBody}\n\nTarget locations:\n${targets}\n\n${BASELINE_APPENDIX}`;
}

function assignment(
  role: TaskAssignment["role"],
  taskBody: string,
  intents: CoordinationIntent[],
  targets: { name: string; stableId: string; path: string }[]
): TaskAssignment {
  const strataTargets = targets.map(({ name, stableId }) => ({ name, stableId }));
  const baselineTargets = targets.map(({ name, path }) => ({ name, path }));
  return {
    role,
    taskBody,
    taskBodyBytes: Buffer.from(utf8.encode(taskBody)).toString("base64"),
    intents,
    strataTargets,
    baselineTargets,
    promptHashes: {
      strata: sha256(strataTaskPrompt({ taskBody, strataTargets })),
      baseline: sha256(baselineTaskPrompt({ taskBody, baselineTargets }))
    }
  };
}

export function createQualifiedTaskManifest(corpusRootInput: string): QualifiedTaskManifest {
  const corpusRoot = resolve(corpusRootInput);
  const inputs = filesBelow(join(corpusRoot, "src"), (path) => path.endsWith(".ts")).map((absolute) => {
    const relativePath = posix(relative(corpusRoot, absolute));
    return { absolute, relativePath, path: absolute, text: readFileSync(absolute, "utf8") };
  });
  const batch = ingestBatch(inputs.map(({ path, text }) => ({ path, text })));
  const sourceFiles: QualifiedTaskManifest["sourceFiles"] = {};
  const nodeById = new Map(batch.allNodes.map((node) => [node.id, node]));
  const modulePathById = new Map(batch.modules.map((module) => [module.moduleId, posix(relative(corpusRoot, module.path))]));
  const statementFor = (nodeId: string): string => {
    let node = nodeById.get(nodeId);
    if (!node) throw new Error(`unresolved node ${nodeId}`);
    while (node.parentId && nodeById.get(node.parentId)?.kind !== "Module") {
      node = nodeById.get(node.parentId)!;
    }
    return node.id;
  };
  const sourcePathFor = (nodeId: string): string => {
    let node = nodeById.get(nodeId);
    while (node?.parentId) node = nodeById.get(node.parentId);
    const path = node && modulePathById.get(node.id);
    if (!path) throw new Error(`node ${nodeId} has no source module`);
    return path;
  };
  for (const input of inputs) {
    const module = batch.modules.find((candidate) => candidate.path === input.path)!;
    const statements = batch.allNodes
      .filter((node) => node.parentId === module.moduleId && node.kind !== "Identifier")
      .sort((left, right) => (left.childIndex ?? 0) - (right.childIndex ?? 0));
    sourceFiles[input.relativePath] = {
      digest: sha256(input.text),
      text: input.text,
      statementIds: statements.map((statement) => statement.id),
      statementPayloads: statements.map((statement) => statement.payload)
    };
  }
  assertApprovedEnrichmentShape(sourceFiles);
  for (const [path, file] of Object.entries(sourceFiles)) {
    if (file.statementPayloads.join("") !== file.text) {
      throw new Error(`registered statement payloads do not reconstruct ${path}`);
    }
  }
  const sourceDigest = digestSourceFiles(sourceFiles);
  if (sourceDigest !== APPROVED_SOURCE_DIGEST) {
    throw new Error(`approved source digest mismatch: expected ${APPROVED_SOURCE_DIGEST}, received ${sourceDigest}`);
  }
  assertPreEnrichmentIdsPreserved(sourceFiles);
  const targetNames: Phase6TargetName[] = [
    "User", "formatTimestamp", "logEvent", "eventLine", "greet", "displayUser", "serialize"
  ];
  const childIdsByParent = new Map<string, string[]>();
  for (const node of batch.allNodes) {
    if (!node.parentId) continue;
    const siblings = childIdsByParent.get(node.parentId);
    if (siblings) siblings.push(node.id);
    else childIdsByParent.set(node.parentId, [node.id]);
  }
  const subtreeOf = (rootId: string): Set<string> => {
    const subtree = new Set([rootId]);
    const queue = [rootId];
    while (queue.length > 0) {
      for (const child of childIdsByParent.get(queue.pop()!) ?? []) {
        subtree.add(child);
        queue.push(child);
      }
    }
    return subtree;
  };
  const targets = Object.fromEntries(targetNames.map((name) => {
    const matches = batch.allNodes.filter((node) => targetPattern(name).test(node.payload));
    if (matches.length !== 1) throw new Error(`unresolved or ambiguous target ${name}`);
    const declaration = matches[0]!;
    const subtree = subtreeOf(declaration.id);
    const incomingReferenceIds = batch.references
      .filter((reference) => subtree.has(reference.toNodeId) && !subtree.has(reference.fromNodeId))
      .map((reference) => reference.fromNodeId)
      .sort();
    const statementIds = [...new Set([declaration.id, ...incomingReferenceIds].map(statementFor))].sort();
    const sourcePaths = [...new Set(statementIds.map(sourcePathFor))].sort();
    return [name, {
      name,
      stableId: declaration.id,
      kind: declaration.kind,
      baselineLocator: { path: sourcePathFor(declaration.id), symbol: name },
      incomingReferenceIds,
      statementIds,
      sourcePaths
    } satisfies QualifiedTarget];
  })) as Record<Phase6TargetName, QualifiedTarget>;
  const fixturePath = resolve(__dirname, "../tests/fixtures/tasks", FIXTURE_NAME);
  const fixtureDigests = { [FIXTURE_NAME]: sha256(readFileSync(fixturePath)) };
  const body = (text: string): string => `${text}\nApply the change only inside the registered canonical src/** projection. Do not modify tests, configuration, or other non-canonical content.`;
  const rename = (name: Phase6TargetName, newName: string): CoordinationIntent => ({ type: "rename_symbol", declarationId: targets[name].stableId, newName });
  const add = (target: "greet" | "serialize", name: string, typeText: string, value: string): CoordinationIntent => ({ type: "add_parameter", functionId: targets[target].stableId, name, typeText, position: 1, value });
  const addressing = (...names: Phase6TargetName[]) =>
    names.map((name) => ({
      name,
      stableId: targets[name].stableId,
      path: targets[name].baselineLocator.path
    }));
  const definitions: Record<Phase6PacketId, TaskAssignment[]> = {
    D: [assignment("agent-1", body("Rename exported interface User to Account throughout the registered projection."), [rename("User", "Account")], addressing("User")), assignment("agent-2", body("Rename exported function formatTimestamp to renderTimestamp throughout the registered projection."), [rename("formatTimestamp", "renderTimestamp")], addressing("formatTimestamp"))],
    M: [assignment("agent-1", body("Rename logEvent to recordEvent throughout the registered projection."), [rename("logEvent", "recordEvent")], addressing("logEvent")), assignment("agent-2", body("Rename eventLine to formatEventLine throughout the registered projection."), [rename("eventLine", "formatEventLine")], addressing("eventLine"))],
    R: [assignment("agent-1", body("Rename exported interface User to Account throughout the registered projection."), [rename("User", "Account")], addressing("User")), assignment("agent-2", body("Add excited: boolean = false at position 1 of greet using one uniform value."), [add("greet", "excited", "boolean", "false")], addressing("greet"))],
    S: [assignment("agent-1", body("Rename greet to welcomeUser throughout the registered projection."), [rename("greet", "welcomeUser")], addressing("greet")), assignment("agent-2", body("Add excited: boolean = false at position 1 of the same greet declaration using one uniform value."), [add("greet", "excited", "boolean", "false")], addressing("greet"))],
    X: [assignment("agent-1", body("Rename exported function displayUser to formatUser throughout the registered projection."), [rename("displayUser", "formatUser")], addressing("displayUser")), assignment("agent-2", body("Add displayLabel: string = UserTypes.displayUser(user) at position 1 of serialize using one uniform value."), [add("serialize", "displayLabel", "string", "UserTypes.displayUser(user)")], addressing("serialize"))],
    G: [assignment("agent-1", body("As one ordered change set, rename User to Account and add account: Account = undefined as never at position 1 of greet."), [rename("User", "Account"), add("greet", "account", "Account", "undefined as never")], addressing("User", "greet")), assignment("agent-2", body("Rename exported function formatTimestamp to renderTimestamp throughout the registered projection."), [rename("formatTimestamp", "renderTimestamp")], addressing("formatTimestamp"))]
  };
  const allowedTargets: Record<Phase6PacketId, Phase6TargetName[]> = {
    D: ["User", "formatTimestamp"], M: ["logEvent", "eventLine"], R: ["User", "greet"],
    S: ["greet"], X: ["displayUser", "serialize"], G: ["User", "greet", "formatTimestamp"]
  };
  const packets = Object.fromEntries((Object.keys(definitions) as Phase6PacketId[]).map((id) => {
    const allowedSourcePaths = [...new Set(allowedTargets[id].flatMap((name) => targets[name].sourcePaths))].sort();
    const predicate = JSON.stringify({ id, assignments: definitions[id], allowedSourcePaths });
    return [id, {
      id,
      singleSite: (["R", "S", "G"] as string[]).includes(id),
      assignments: definitions[id],
      fixtureAllowlist: [FIXTURE_NAME],
      fixtureDigests,
      allowedSourcePaths,
      predicateDigest: sha256(predicate)
    } satisfies Phase6Packet];
  })) as unknown as Record<Phase6PacketId, Phase6Packet>;
  const excludedInputs = Object.fromEntries(filesBelow(join(corpusRoot, "tests"), (path) => path.endsWith(".ts")).map((absolute) => [posix(relative(corpusRoot, absolute)), sha256(readFileSync(absolute))]));
  if (JSON.stringify(excludedInputs) !== JSON.stringify(APPROVED_EXCLUDED_INPUTS)) {
    throw new Error("approved canonical boundary or excluded historical input digest changed");
  }
  const frozenTreeFiles = Object.fromEntries(
    filesBelow(corpusRoot, (path) => !path.startsWith(join(corpusRoot, "src") + sep))
      .map((absolute) => [posix(relative(corpusRoot, absolute)), sha256(readFileSync(absolute))])
  );
  const snapshot = toKernelSnapshot(batch);
  const graphDigest = sha256(JSON.stringify(snapshot));
  const boundary = scanCanonicalBoundary(corpusRoot, targets);
  const manifest: QualifiedTaskManifest = {
    schemaVersion: 1,
    corpusVariant: APPROVED_CORPUS_VARIANT,
    sourceDigest,
    graphDigest,
    targets,
    packets,
    singleSitePackets: ["R", "S", "G"],
    greetNonCanonicalReferences: boundary.filter((entry) => entry.target === "greet").map((entry) => entry.path),
    sourceFiles,
    excludedInputs,
    frozenTreeFiles,
    boundary,
    systemPromptHashes: {
      strata: sha256(REGISTERED_SYSTEM_PROMPTS.strata),
      baselineTask: sha256(REGISTERED_SYSTEM_PROMPTS.baselineTask),
      baselineIntegration: sha256(REGISTERED_SYSTEM_PROMPTS.baselineIntegration)
    },
    registrationDigest: ""
  };
  manifest.registrationDigest = sha256(JSON.stringify({ ...manifest, registrationDigest: undefined }));
  assertApprovedTaskManifest(manifest);
  return deepFreeze(manifest);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

export function assertApprovedTaskManifest(manifest: QualifiedTaskManifest): void {
  if (manifest.corpusVariant !== APPROVED_CORPUS_VARIANT) throw new Error("manifest differs from approved corpus variant");
  if (manifest.sourceDigest !== APPROVED_SOURCE_DIGEST || digestSourceFiles(manifest.sourceFiles) !== APPROVED_SOURCE_DIGEST) throw new Error("manifest differs from approved source digest");
  const targetIds = new Set(Object.values(manifest.targets).map((target) => target.stableId));
  for (const packet of Object.values(manifest.packets)) {
    for (const assignment of packet.assignments) {
      if (Buffer.from(assignment.taskBodyBytes, "base64").toString("utf8") !== assignment.taskBody) throw new Error("task body bytes drifted");
      for (const intent of assignment.intents) {
        if (intent.type !== "rename_symbol" && intent.type !== "add_parameter") throw new Error("unsupported operation class");
        const id = intent.type === "rename_symbol" ? intent.declarationId : intent.functionId;
        if (!targetIds.has(id)) throw new Error("unresolved intent target");
      }
    }
  }
  if (manifest.targets.greet.incomingReferenceIds.length !== 0 || manifest.greetNonCanonicalReferences.length !== 0) throw new Error("registered corpus greet must remain single-site");
  if (manifest.targets.displayUser.incomingReferenceIds.length !== 0) throw new Error("x-namespace-enriched-v1 requires zero generation-zero displayUser references");
  const actualRegistrationDigest = sha256(JSON.stringify({ ...manifest, registrationDigest: undefined }));
  if (manifest.registrationDigest !== actualRegistrationDigest || actualRegistrationDigest !== APPROVED_TASK_REGISTRATION_DIGEST) {
    throw new Error(`task registration digest mismatch: expected ${APPROVED_TASK_REGISTRATION_DIGEST}, received ${actualRegistrationDigest}`);
  }
}

export function createQualifiedKernelSnapshot(corpusRootInput: string) {
  const corpusRoot = resolve(corpusRootInput);
  const inputs = filesBelow(join(corpusRoot, "src"), (path) => path.endsWith(".ts")).map((absolute) => ({
    path: absolute,
    text: readFileSync(absolute, "utf8")
  }));
  const snapshot = toKernelSnapshot(ingestBatch(inputs));
  return {
    ...snapshot,
    generation: Number(snapshot.generation)
  };
}
