import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import {
  scanCanonicalBoundary,
  assertApprovedTaskManifest,
  type Phase6PacketId,
  type QualifiedTaskManifest
} from "./tasks.js";

export interface Phase6VerificationReport {
  arm?: "strata" | "baseline";
  packetId: Phase6PacketId;
  green: true;
  generationZero: boolean;
  rootNames: string[];
  compilerOptions: Record<string, unknown>;
  fixtureNames: string[];
  fixtureDigests: Record<string, string>;
  sourceDigest: string;
  finalTreeDigest: string;
  configurationDigest: string;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const OUTPUT_LIMIT = 64 * 1024;
const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
  types: ["node"]
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function posix(value: string): string { return value.split(sep).join("/"); }
function sourcePaths(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (path.endsWith(".ts")) result.push(resolve(path));
    }
  };
  visit(join(root, "src"));
  return result.sort();
}
function digestFiles(root: string, paths: readonly string[]): string {
  const hash = createHash("sha256");
  for (const absolute of paths) {
    const path = posix(relative(root, absolute));
    hash.update(path).update("\0").update(readFileSync(absolute)).update("\0");
  }
  return hash.digest("hex");
}
export function boundVerifierOutput(value: string): string {
  return Buffer.byteLength(value) <= OUTPUT_LIMIT ? value : Buffer.from(value).subarray(0, OUTPUT_LIMIT).toString("utf8");
}

function assertFrozenInputs(treeRoot: string, manifest: QualifiedTaskManifest): void {
  for (const [path, digest] of Object.entries(manifest.excludedInputs)) {
    if (sha256(readFileSync(join(treeRoot, path))) !== digest) {
      throw new Error(`excluded historical input ${path} changed`);
    }
  }
  const textualInventory = (entries: readonly QualifiedTaskManifest["boundary"][number][]) =>
    entries.map(({ path, target, textualOccurrenceCount, contentDigest, disposition }) =>
      ({ path, target, textualOccurrenceCount, contentDigest, disposition }));
  const actualBoundary = scanCanonicalBoundary(treeRoot, manifest.targets);
  if (JSON.stringify(textualInventory(actualBoundary)) !== JSON.stringify(textualInventory(manifest.boundary))) {
    throw new Error("canonical boundary textual inventory changed");
  }
}

function assertFixtureSeal(manifest: QualifiedTaskManifest, packetId: Phase6PacketId): void {
  const fixtureRoot = resolve(__dirname, "../tests/fixtures/tasks");
  const packet = manifest.packets[packetId];
  for (const name of packet.fixtureAllowlist) {
    const digest = sha256(readFileSync(join(fixtureRoot, name)));
    if (packet.fixtureDigests[name] !== digest) throw new Error(`harness-owned fixture ${name} changed`);
  }
}

function runTypeScript(rootNames: string[]): string {
  const program = ts.createProgram(rootNames, COMPILER_OPTIONS);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n"
    });
    throw new Error(`source-only TypeScript verification failed\n${boundVerifierOutput(formatted)}`);
  }
  return "tsc source-only: PASS\n";
}

function runFixture(treeRoot: string, name: string): { stdout: string; stderr: string } {
  const packageRoot = resolve(__dirname, "..");
  const temporary = mkdtempSync(join(packageRoot, "tests/fixtures/runtime-"));
  try {
    const target = join(temporary, `${basename(name, ".mjs")}.test.mjs`);
    cpSync(resolve(__dirname, "../tests/fixtures/tasks", name), target);
    const result = spawnSync("pnpm", ["exec", "vitest", "run", relative(packageRoot, target)], {
      cwd: packageRoot,
      env: { ...process.env, PHASE6_TREE: treeRoot, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: OUTPUT_LIMIT
    });
    if (result.status !== 0) throw new Error(`Phase-6 fixture ${name} failed\n${boundVerifierOutput(result.stdout)}\n${boundVerifierOutput(result.stderr)}`);
    return { stdout: boundVerifierOutput(result.stdout), stderr: boundVerifierOutput(result.stderr) };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function identifiers(rootNames: string[]): Set<string> {
  const names = new Set<string>();
  for (const path of rootNames) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) names.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return names;
}

function functionDeclaration(rootNames: string[], name: string): ts.FunctionDeclaration {
  for (const path of rootNames) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
    }
  }
  throw new Error(`required function ${name} is absent`);
}

function assertParameter(
  rootNames: string[], functionName: string, parameterName: string, typeText: string, defaultText: string
): void {
  const declaration = functionDeclaration(rootNames, functionName);
  const matches = declaration.parameters.filter((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === parameterName);
  if (matches.length !== 1) throw new Error(`parameter ${parameterName} must occur exactly once`);
  const parameter = matches[0]!;
  const source = parameter.getSourceFile();
  if (parameter.type?.getText(source) !== typeText || parameter.initializer?.getText(source) !== defaultText) {
    throw new Error(`parameter ${parameterName} does not match the registered exact default`);
  }
}

function assertFinalPredicates(packetId: Phase6PacketId, rootNames: string[]): void {
  const names = identifiers(rootNames);
  const renamed = (oldName: string, newName: string): void => {
    if (names.has(oldName) || !names.has(newName)) throw new Error(`rename predicate ${oldName} -> ${newName} failed`);
  };
  if (["D", "R", "G"].includes(packetId)) renamed("User", "Account");
  if (["D", "G"].includes(packetId)) renamed("formatTimestamp", "renderTimestamp");
  if (packetId === "M") {
    renamed("logEvent", "recordEvent");
    renamed("eventLine", "formatEventLine");
  }
  if (packetId === "R") assertParameter(rootNames, "greet", "excited", "boolean", "false");
  if (packetId === "S") {
    renamed("greet", "welcomeUser");
    assertParameter(rootNames, "welcomeUser", "excited", "boolean", "false");
  }
  if (packetId === "X") {
    renamed("displayUser", "formatUser");
    assertParameter(rootNames, "serialize", "displayLabel", "string", "UserTypes.formatUser(user)");
  }
  if (packetId === "G") assertParameter(rootNames, "greet", "account", "Account", "undefined as never");
}

function packetNormalization(packetId: Phase6PacketId): {
  renames: Record<string, string>;
  parameter?: { functionName: string; parameterName: string };
} {
  const renames: Record<string, string> = {};
  if (["D", "R", "G"].includes(packetId)) renames.Account = "User";
  if (["D", "G"].includes(packetId)) renames.renderTimestamp = "formatTimestamp";
  if (packetId === "M") {
    renames.recordEvent = "logEvent";
    renames.formatEventLine = "eventLine";
  }
  if (packetId === "S") renames.welcomeUser = "greet";
  if (packetId === "X") renames.formatUser = "displayUser";
  const parameter = packetId === "R" || packetId === "S"
    ? { functionName: packetId === "S" ? "welcomeUser" : "greet", parameterName: "excited" }
    : packetId === "X"
      ? { functionName: "serialize", parameterName: "displayLabel" }
      : packetId === "G"
        ? { functionName: "greet", parameterName: "account" }
        : undefined;
  return { renames, ...(parameter ? { parameter } : {}) };
}

function normalizedAst(text: string, path: string, packetId: Phase6PacketId, final: boolean): string {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const normalization = packetNormalization(packetId);
  const parts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (final && normalization.parameter && ts.isParameter(node) && ts.isIdentifier(node.name)) {
      const parent = node.parent;
      if (
        node.name.text === normalization.parameter.parameterName &&
        ts.isFunctionDeclaration(parent) &&
        parent.name?.text === normalization.parameter.functionName
      ) return;
    }
    parts.push(String(node.kind));
    if (ts.isIdentifier(node)) parts.push(final ? (normalization.renames[node.text] ?? node.text) : node.text);
    else if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) parts.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sha256(parts.join("\0"));
}

function assertUnexpectedChanges(treeRoot: string, manifest: QualifiedTaskManifest, packetId: Phase6PacketId, generationZero: boolean): void {
  const allowed = new Set(manifest.packets[packetId].allowedSourcePaths);
  for (const [path, original] of Object.entries(manifest.sourceFiles)) {
    const actual = readFileSync(join(treeRoot, path), "utf8");
    if ((generationZero || !allowed.has(path)) && actual !== original.text) {
      throw new Error(`unexpected source change outside packet scope: ${path}`);
    }
    if (!generationZero && allowed.has(path) && normalizedAst(actual, path, packetId, true) !== normalizedAst(original.text, path, packetId, false)) {
      throw new Error(`unexpected source change outside registered normalized delta: ${path}`);
    }
  }
  const actualPaths = sourcePaths(treeRoot).map((path) => posix(relative(treeRoot, path))).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(Object.keys(manifest.sourceFiles).sort())) throw new Error("source root-name set changed");
}

export async function verifyPhase6Tree(input: {
  treeRoot: string;
  manifest: QualifiedTaskManifest;
  packetId: Phase6PacketId;
  generationZero: boolean;
  arm?: "strata" | "baseline";
}): Promise<Phase6VerificationReport> {
  const started = performance.now();
  const treeRoot = resolve(input.treeRoot);
  assertApprovedTaskManifest(input.manifest);
  assertFrozenInputs(treeRoot, input.manifest);
  assertFixtureSeal(input.manifest, input.packetId);
  assertUnexpectedChanges(treeRoot, input.manifest, input.packetId, input.generationZero);
  const roots = sourcePaths(treeRoot);
  let stdout = runTypeScript(roots);
  let stderr = "";
  for (const fixture of input.manifest.packets[input.packetId].fixtureAllowlist) {
    const output = runFixture(treeRoot, fixture);
    stdout += output.stdout;
    stderr += output.stderr;
  }
  if (!input.generationZero) assertFinalPredicates(input.packetId, roots);
  const relativeRoots = roots.map((path) => posix(relative(treeRoot, path)));
  const compilerOptions = {
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true,
    allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true, types: ["node"]
  };
  const configurationDigest = sha256(JSON.stringify({
    packetId: input.packetId,
    roots: relativeRoots,
    compilerOptions,
    fixtures: input.manifest.packets[input.packetId].fixtureDigests,
    boundary: input.manifest.boundary,
    predicateDigest: input.manifest.packets[input.packetId].predicateDigest
  }));
  return {
    ...(input.arm ? { arm: input.arm } : {}),
    packetId: input.packetId,
    green: true,
    generationZero: input.generationZero,
    rootNames: roots,
    compilerOptions,
    fixtureNames: [...input.manifest.packets[input.packetId].fixtureAllowlist],
    fixtureDigests: { ...input.manifest.packets[input.packetId].fixtureDigests },
    sourceDigest: input.manifest.sourceDigest,
    finalTreeDigest: digestFiles(treeRoot, roots),
    configurationDigest,
    stdout: boundVerifierOutput(stdout),
    stderr: boundVerifierOutput(stderr),
    durationMs: performance.now() - started
  };
}

export async function qualifyGenerationZero(input: {
  treeRoot: string;
  manifest: QualifiedTaskManifest;
}): Promise<Phase6VerificationReport[]> {
  const reports: Phase6VerificationReport[] = [];
  for (const packetId of ["D", "M", "R", "S", "X", "G"] as Phase6PacketId[]) {
    reports.push(await verifyPhase6Tree({ ...input, packetId, generationZero: true }));
  }
  return reports;
}
