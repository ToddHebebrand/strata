import type { TextSpanEdit } from "@strata-code/store";

export type { TextSpanEdit } from "@strata-code/store";

export interface IdentifierMutation {
  offset: number;
  oldText: string;
  newText: string;
}

export function identifierMutationToSpan(
  mutation: IdentifierMutation
): TextSpanEdit {
  return {
    start: mutation.offset,
    end: mutation.offset + mutation.oldText.length,
    oldText: mutation.oldText,
    newText: mutation.newText
  };
}

export function spliceStatement(
  payload: string,
  mutations: Array<TextSpanEdit | IdentifierMutation>
): string {
  if (mutations.length === 0) {
    return payload;
  }

  const sorted = mutations
    .map((mutation) =>
      "offset" in mutation ? identifierMutationToSpan(mutation) : mutation
    )
    .sort((left, right) => right.start - left.start);
  let out = payload;

  for (const edit of sorted) {
    const actual = out.slice(edit.start, edit.start + edit.oldText.length);
    if (actual !== edit.oldText || edit.end !== edit.start + edit.oldText.length) {
      throw new Error(
        `oldText mismatch at [${edit.start},${edit.end}): expected ${JSON.stringify(
          edit.oldText
        )}, got ${JSON.stringify(actual)}`
      );
    }

    out =
      out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
  }

  return out;
}
