export interface IdentifierMutation {
  offset: number;
  oldText: string;
  newText: string;
}

export function spliceStatement(
  payload: string,
  mutations: IdentifierMutation[]
): string {
  if (mutations.length === 0) {
    return payload;
  }

  const sorted = [...mutations].sort((left, right) => right.offset - left.offset);
  let out = payload;

  for (const mutation of sorted) {
    const actual = out.slice(
      mutation.offset,
      mutation.offset + mutation.oldText.length
    );
    if (actual !== mutation.oldText) {
      throw new Error(
        `oldText mismatch at offset ${mutation.offset}: expected ${JSON.stringify(
          mutation.oldText
        )}, got ${JSON.stringify(actual)}`
      );
    }

    out =
      out.slice(0, mutation.offset) +
      mutation.newText +
      out.slice(mutation.offset + mutation.oldText.length);
  }

  return out;
}
