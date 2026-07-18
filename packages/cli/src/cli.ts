#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ingest } from "@strata-code/ingest";
import { render } from "@strata-code/render";
import { insertNodes, loadModule, openDb } from "@strata-code/store";
import ts from "typescript";
import { runAgentCommand } from "./commands/agent";
import { runBaselineCommand } from "./commands/baseline";
import { runEmbed } from "./commands/embed";
import {
  EXPLORE_USAGE,
  isExploreCommand,
  runExplore
} from "./commands/explore";
import { runIngestBatch } from "./commands/ingestBatch";
import { runRename } from "./commands/rename";
import { describeSdkToolSchema } from "./commands/sdkSmoke";
import { runT03 } from "./commands/t03";

interface RoundtripResult {
  ok: boolean;
  outputPath?: string;
}

interface ParsedAgentArgs {
  corpusRoot: string;
  prompt: string;
  dbPath?: string;
  reset: boolean;
  print: boolean;
  model?: string;
  maxTurns?: number;
  wallTimeMs?: number;
  injectModuleIndex: boolean;
}

interface ParsedBaselineArgs {
  corpusRoot: string;
  prompt: string;
  keepTree: boolean;
  print: boolean;
  model?: string;
  maxTurns?: number;
  wallTimeMs?: number;
}

function parseAgentArgs(rest: string[]): ParsedAgentArgs | null {
  const positional: string[] = [];
  let dbPath: string | undefined;
  let model: string | undefined;
  let maxTurns: number | undefined;
  let wallTimeMs: number | undefined;
  let reset = false;
  let print = false;
  let injectModuleIndex = true;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--db") {
      dbPath = rest[++i];
    } else if (arg === "--reset") {
      reset = true;
    } else if (arg === "--print") {
      print = true;
    } else if (arg === "--no-index") {
      injectModuleIndex = false;
    } else if (arg === "--model") {
      model = rest[++i];
    } else if (arg === "--max-turns") {
      const next = rest[++i];
      maxTurns = next ? Number(next) : undefined;
    } else if (arg === "--wall-ms") {
      const next = rest[++i];
      wallTimeMs = next ? Number(next) : undefined;
    } else if (arg.startsWith("--")) {
      return null;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) return null;
  return {
    corpusRoot: positional[0]!,
    prompt: positional[1]!,
    dbPath,
    reset,
    print,
    model,
    maxTurns,
    wallTimeMs,
    injectModuleIndex
  };
}

function parseBaselineArgs(rest: string[]): ParsedBaselineArgs | null {
  const positional: string[] = [];
  let model: string | undefined;
  let maxTurns: number | undefined;
  let wallTimeMs: number | undefined;
  let keepTree = false;
  let print = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--keep-tree") {
      keepTree = true;
    } else if (arg === "--print") {
      print = true;
    } else if (arg === "--model") {
      model = rest[++i];
    } else if (arg === "--max-turns") {
      const next = rest[++i];
      maxTurns = next ? Number(next) : undefined;
    } else if (arg === "--wall-ms") {
      const next = rest[++i];
      wallTimeMs = next ? Number(next) : undefined;
    } else if (arg.startsWith("--")) {
      return null;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) return null;
  return {
    corpusRoot: positional[0]!,
    prompt: positional[1]!,
    keepTree,
    print,
    model,
    maxTurns,
    wallTimeMs
  };
}

function costFromLog(result: {
  log: Awaited<ReturnType<typeof runAgentCommand>>["log"];
}): {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  wallMs: number;
  apiMs: number;
  numTurns: number;
  toolCalls: number;
  costUsd: number;
} | null {
  const resultEvent = result.log.events.find(
    (event): event is Extract<typeof event, { type: "result" }> =>
      event.type === "result"
  );
  const toolCalls = result.log.events.filter(
    (event): event is Extract<typeof event, { type: "tool_call" }> =>
      event.type === "tool_call"
  );
  const usage = resultEvent?.usage;
  const totalTokens = usage ? usage.inputTokens + usage.outputTokens : 0;
  return resultEvent
    ? {
        totalTokens,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0,
        cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? 0,
        wallMs: resultEvent.durationMs,
        apiMs: resultEvent.durationApiMs,
        numTurns: resultEvent.numTurns,
        toolCalls: toolCalls.length,
        costUsd: resultEvent.totalCostUsd
      }
    : null;
}

function printGroupedUsage(): void {
  console.error(
    [
      "strata — structural code substrate for AI agents",
      "",
      "Explore a store (read-only; <source> = corpus dir or persisted .db):",
      ...EXPLORE_USAGE.split("\n").map((line) => (line ? `  ${line}` : line)),
      "",
      "Agent and research/harness commands:",
      '  strata agent <corpusRoot> "<prompt>" [--db <path>] [--reset] [--print] [--no-index] [--model <id>] [--max-turns N] [--wall-ms N]',
      '  strata baseline <corpusRoot> "<prompt>" [--keep-tree] [--print] [--model <id>] [--max-turns N] [--wall-ms N]',
      "  strata embed <corpusRoot> --db <dbPath>",
      "  strata ingest-batch <rootDir> <dbPath>",
      "  strata roundtrip <input.ts>",
      "  strata rename <dbPath> <declarationId> <newName>",
      "  strata t03 <examples/medium dir>",
      "  strata sdk-smoke"
    ].join("\n")
  );
}

async function asyncMain(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "help" || command === "--help" || command === undefined) {
    printGroupedUsage();
    return command === undefined ? 1 : 0;
  }
  if (isExploreCommand(command)) {
    const result = await runExplore([command, ...rest]);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.code;
  }
  if (command === "embed") {
    const positional: string[] = [];
    let dbPath: string | undefined;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]!;
      if (arg === "--db") {
        dbPath = rest[++i];
      } else if (arg.startsWith("--")) {
        console.error("Usage: strata embed <corpusRoot> --db <dbPath>");
        return 1;
      } else {
        positional.push(arg);
      }
    }
    if (positional.length !== 1 || !dbPath) {
      console.error("Usage: strata embed <corpusRoot> --db <dbPath>");
      return 1;
    }
    const result = await runEmbed({ rootDir: positional[0]!, dbPath });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (command !== "agent" && command !== "baseline") {
    return main(argv);
  }
  if (command === "baseline") {
    const parsed = parseBaselineArgs(rest);
    if (!parsed) {
      console.error(
        'Usage: strata baseline <corpusRoot> "<prompt>" [--keep-tree] [--print] [--model <id>] [--max-turns N] [--wall-ms N]'
      );
      return 1;
    }
    const result = await runBaselineCommand({
      corpusRoot: parsed.corpusRoot,
      prompt: parsed.prompt,
      keepTree: parsed.keepTree,
      printTranscript: parsed.print,
      model: parsed.model,
      maxTurns: parsed.maxTurns,
      wallTimeMs: parsed.wallTimeMs
    });
    console.log(
      JSON.stringify(
        {
          terminalReason: result.terminalReason,
          tscClean: result.resultQuality.tscClean,
          vitestPassed: result.resultQuality.vitestPassed,
          tempTreeRoot: result.tempTreeRoot,
          cost: costFromLog(result)
        },
        null,
        2
      )
    );
    return result.terminalReason === "success" &&
      result.resultQuality.tscClean &&
      result.resultQuality.vitestPassed
      ? 0
      : 1;
  }

  const parsed = parseAgentArgs(rest);
  if (!parsed) {
    console.error(
      'Usage: strata agent <corpusRoot> "<prompt>" [--db <path>] [--reset] [--print] [--no-index] [--model <id>] [--max-turns N] [--wall-ms N]'
    );
    return 1;
  }
  const result = await runAgentCommand({
    corpusRoot: parsed.corpusRoot,
    prompt: parsed.prompt,
    dbPath: parsed.dbPath,
    reset: parsed.reset,
    printTranscript: parsed.print,
    model: parsed.model,
    maxTurns: parsed.maxTurns,
    wallTimeMs: parsed.wallTimeMs,
    injectModuleIndex: parsed.injectModuleIndex
  });
  console.log(
    JSON.stringify(
      {
        terminalReason: result.terminalReason,
        lastCommitOk: result.lastCommitOk,
        newOperations: result.newOperationsCount,
        totalOperations: result.totalOperationsCount,
        dbPath: result.dbPath,
        cost: costFromLog(result)
      },
      null,
      2
    )
  );
  return result.terminalReason === "success" ? 0 : 1;
}

function main(argv: string[]): number {
  const [command, inputPath, dbPath] = argv;

  if (command === "roundtrip" && inputPath) {
    const result = roundtrip(inputPath);
    return result.ok ? 0 : 1;
  }

  if (command === "ingest-batch" && inputPath && dbPath) {
    const result = runIngestBatch({ rootDir: inputPath, dbPath });
    return result.ok ? 0 : 1;
  }

  if (command === "ingest-batch") {
    console.error("Usage: strata ingest-batch <rootDir> <dbPath>");
    return 1;
  }

  if (command === "rename" && inputPath && dbPath) {
    const newName = argv[3];
    if (!newName) {
      console.error("Usage: strata rename <dbPath> <declarationId> <newName>");
      return 1;
    }
    const result = runRename({
      dbPath: inputPath,
      declarationId: dbPath,
      newName
    });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (command === "rename") {
    console.error("Usage: strata rename <dbPath> <declarationId> <newName>");
    return 1;
  }

  if (command === "t03" && inputPath) {
    const result = runT03({ corpusRoot: inputPath });
    console.log(JSON.stringify(result, null, 2));
    return result.commitOk && Object.values(result.criteria).every(Boolean)
      ? 0
      : 1;
  }

  if (command === "t03") {
    console.error("Usage: strata t03 <examples/medium dir>");
    return 1;
  }

  if (command === "sdk-smoke") {
    console.log(JSON.stringify(describeSdkToolSchema(), null, 2));
    return 0;
  }

  printGroupedUsage();
  return 1;
}

function roundtrip(inputPath: string): RoundtripResult {
  try {
    const sourceText = readFileSync(inputPath, "utf8");
    const graph = ingest(sourceText, inputPath);

    const db = openDb("./.strata.db");
    try {
      db.exec("DELETE FROM nodes");
      insertNodes(db, [graph.module, ...graph.children]);

      const loaded = loadModule(db, graph.module.id);
      const renderedText = render(loaded.module, loaded.children);
      const outputPath = `${inputPath}.out.ts`;
      writeFileSync(outputPath, renderedText, "utf8");

      const equivalence = compareRoundTrip(sourceText, renderedText, inputPath, outputPath);
      if (!equivalence.ok) {
        console.error("Round-trip equivalence check failed.");
        console.error(equivalence.diff);
        return { ok: false, outputPath };
      }

      const tsc = runTsc(outputPath);
      if (!tsc.ok) {
        console.error("Rendered output failed TypeScript validation.");
        if (tsc.output.trim()) {
          console.error(tsc.output.trim());
        }
        return { ok: false, outputPath };
      }

      if (equivalence.byteIdentical) {
        console.log("Round-trip succeeded (byte-identical).");
      } else {
        console.log(
          `Round-trip succeeded (canonical equivalence; ${equivalence.byteDifferenceCount} bytes differ).`
        );
        console.log(equivalence.diff);
      }
      console.log(`Output: ${outputPath}`);
      return { ok: true, outputPath };
    } finally {
      db.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return { ok: false };
  }
}

function runTsc(outputPath: string): { ok: boolean; output: string } {
  const options = loadCompilerOptions();
  const program = ts.createProgram([outputPath], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);

  return {
    ok: diagnostics.length === 0,
    output: diagnostics.map(formatDiagnostic).join("\n")
  };
}

function loadCompilerOptions(): ts.CompilerOptions {
  const configPath = path.resolve(__dirname, "../../..", "tsconfig.base.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);

  if (configFile.error) {
    throw new Error(formatDiagnostic(configFile.error));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath
  );

  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(formatDiagnostic).join("\n"));
  }

  return parsed.options;
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

  if (diagnostic.file && typeof diagnostic.start === "number") {
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} TS${diagnostic.code}: ${message}`;
  }

  return `TS${diagnostic.code}: ${message}`;
}

function compareRoundTrip(
  originalText: string,
  renderedText: string,
  originalPath: string,
  renderedPath: string
):
  | { ok: true; byteIdentical: true }
  | { ok: true; byteIdentical: false; byteDifferenceCount: number; diff: string }
  | { ok: false; diff: string } {
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const original = printer.printFile(parse(originalPath, originalText));
  const rendered = printer.printFile(parse(renderedPath, renderedText));

  if (original !== rendered) {
    return {
      ok: false,
      diff: firstPrintedDifference(original, rendered)
    };
  }

  if (originalText === renderedText) {
    return { ok: true, byteIdentical: true };
  }

  return {
    ok: true,
    byteIdentical: false,
    byteDifferenceCount: countByteDifferences(originalText, renderedText),
    diff: firstByteDifference(originalText, renderedText, originalPath, renderedPath)
  };
}

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function firstPrintedDifference(left: string, right: string): string {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const max = Math.max(leftLines.length, rightLines.length);

  for (let index = 0; index < max; index += 1) {
    if (leftLines[index] !== rightLines[index]) {
      const start = Math.max(0, index - 2);
      const end = Math.min(max, index + 3);
      const lines: string[] = [`First difference at printed line ${index + 1}:`];

      for (let line = start; line < end; line += 1) {
        lines.push(`-${line + 1}: ${leftLines[line] ?? ""}`);
        lines.push(`+${line + 1}: ${rightLines[line] ?? ""}`);
      }

      return lines.join("\n");
    }
  }

  return "Printed output differs, but no line-level difference was found.";
}

function countByteDifferences(left: string, right: string): number {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const max = Math.max(leftBytes.length, rightBytes.length);
  let count = 0;

  for (let index = 0; index < max; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      count += 1;
    }
  }

  return count;
}

function firstByteDifference(
  left: string,
  right: string,
  leftPath: string,
  rightPath: string
): string {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const max = Math.max(leftBytes.length, rightBytes.length);

  for (let index = 0; index < max; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      const leftLocation = locationAtByteOffset(leftBytes, index);
      const rightLocation = locationAtByteOffset(rightBytes, index);
      return [
        `First byte difference at ${leftPath}:${leftLocation.line}:${leftLocation.column}`,
        `Rendered position ${rightPath}:${rightLocation.line}:${rightLocation.column}`,
        `Original byte: ${describeByte(leftBytes[index])}`,
        `Rendered byte: ${describeByte(rightBytes[index])}`
      ].join("\n");
    }
  }

  return "Byte output differs, but no byte-level difference was found.";
}

function locationAtByteOffset(bytes: Buffer, offset: number): { line: number; column: number } {
  const prefix = bytes.subarray(0, Math.min(offset, bytes.length)).toString("utf8");
  const lines = prefix.split("\n");
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1
  };
}

function describeByte(byte: number | undefined): string {
  if (byte === undefined) {
    return "EOF";
  }

  const character = Buffer.from([byte]).toString("utf8");
  if (character === "\n") {
    return "0x0a (newline)";
  }
  if (character === "\r") {
    return "0x0d (carriage return)";
  }
  if (character === "\t") {
    return "0x09 (tab)";
  }

  return `0x${byte.toString(16).padStart(2, "0")} (${JSON.stringify(character)})`;
}

if (require.main === module) {
  void asyncMain(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

export { asyncMain, compareRoundTrip, main, roundtrip };
