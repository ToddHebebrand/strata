#!/usr/bin/env node

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { ingestBatch } from "./batch";
import { toKernelSnapshot } from "./kernelSnapshot";

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist"]);

function collectTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        files.push(...collectTypeScriptFiles(entryPath));
      }
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

function usage(): never {
  throw new Error("usage: exportKernelSnapshotCli <corpusRoot> --out <path>");
}

function main(args: string[]): void {
  if (args.length !== 3 || args[1] !== "--out") usage();

  const corpusRoot = path.resolve(args[0]!);
  const outputPath = path.resolve(args[2]!);
  const inputs = collectTypeScriptFiles(corpusRoot).map((filePath) => ({
    path: `/project/${path.relative(corpusRoot, filePath).split(path.sep).join("/")}`,
    text: readFileSync(filePath, "utf8")
  }));
  const snapshot = toKernelSnapshot(ingestBatch(inputs));

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
