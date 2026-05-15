#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ingest } from "@strata/ingest";
import { render } from "@strata/render";
import { insertNodes, loadModule, openDb } from "@strata/store";
import ts from "typescript";

interface RoundtripResult {
  ok: boolean;
  outputPath?: string;
}

function main(argv: string[]): number {
  const [command, inputPath] = argv;

  if (command !== "roundtrip" || !inputPath) {
    console.error("Usage: strata roundtrip <input.ts>");
    return 1;
  }

  const result = roundtrip(inputPath);
  return result.ok ? 0 : 1;
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
  process.exitCode = main(process.argv.slice(2));
}

export { compareRoundTrip, main, roundtrip };
