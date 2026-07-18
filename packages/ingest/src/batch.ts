import { resolveReferencesForModules, type NodeRow, type Reference } from "@strata-code/store";
import ts from "typescript";
import { ingest } from "./index";

export interface IngestBatchInput {
  path: string;
  text: string;
}

export interface IngestBatchResult {
  allNodes: NodeRow[];
  references: Reference[];
  modules: { path: string; moduleId: string }[];
}

export function ingestBatch(inputs: IngestBatchInput[]): IngestBatchResult {
  const allNodes: NodeRow[] = [];
  const modules: { path: string; moduleId: string }[] = [];

  for (const input of inputs) {
    const single = ingest(input.text, input.path);
    allNodes.push(single.module, ...single.children);
    modules.push({ path: input.path, moduleId: single.module.id });
  }

  const renderedByPath = new Map(inputs.map((i) => [i.path, i.text]));
  const references = resolveReferencesForModules(
    renderedByPath,
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true
    },
    inputs.map((i) => i.path)
  );

  return { allNodes, references, modules };
}
