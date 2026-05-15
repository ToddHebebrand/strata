import type { NodeRow } from "@strata/store";
import {
  identifierMutationToSpan,
  spliceStatement,
  type TextSpanEdit
} from "./splice";

export interface SourceMapEntry {
  renderedStart: number;
  renderedEnd: number;
  nodeId: string;
}

export interface RenderOverlay {
  identifierMutations: Map<string, { text: string }>;
  textSpanMutations?: Map<string, TextSpanEdit[]>;
}

export interface RenderResult {
  text: string;
  sourceMap: SourceMapEntry[];
}

export function render(module: NodeRow, children: NodeRow[]): string {
  return renderWithSourceMap(module, children).text;
}

export function renderWithSourceMap(
  _module: NodeRow,
  children: NodeRow[],
  overlay?: RenderOverlay
): RenderResult {
  const topLevel = [...children]
    .filter((child) => child.kind !== "Identifier" && child.childIndex !== null)
    .sort((left, right) => (left.childIndex ?? 0) - (right.childIndex ?? 0));

  const identifiersByParent = new Map<string, NodeRow[]>();
  for (const child of children) {
    if (child.kind !== "Identifier" || !child.parentId) {
      continue;
    }
    const siblings = identifiersByParent.get(child.parentId) ?? [];
    siblings.push(child);
    identifiersByParent.set(child.parentId, siblings);
  }

  const sourceMap: SourceMapEntry[] = [];
  const parts: string[] = [];
  let cursor = 0;

  for (const node of topLevel) {
    const edits = editsForNode(
      node.id,
      identifiersByParent.get(node.id) ?? [],
      overlay
    );
    const text = spliceStatement(node.payload, edits);
    const renderedStart = cursor;
    cursor += text.length;
    parts.push(text);
    sourceMap.push({ renderedStart, renderedEnd: cursor, nodeId: node.id });
  }

  return { text: parts.join(""), sourceMap };
}

function editsForNode(
  statementId: string,
  identifiers: NodeRow[],
  overlay: RenderOverlay | undefined
): TextSpanEdit[] {
  if (!overlay) {
    return [];
  }

  const edits: TextSpanEdit[] = [];
  for (const identifier of identifiers) {
    const updated = overlay.identifierMutations.get(identifier.id);
    if (!updated) {
      continue;
    }

    const payload = JSON.parse(identifier.payload) as {
      text: string;
      offset: number;
    };
    edits.push(
      identifierMutationToSpan({
        offset: payload.offset,
        oldText: payload.text,
        newText: updated.text
      })
    );
  }

  edits.push(...(overlay.textSpanMutations?.get(statementId) ?? []));
  return edits;
}
