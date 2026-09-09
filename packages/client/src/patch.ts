export interface TextPatch {
  at: number;
  removed: number;
  added: string;
}

/**
 * Work out what changed between two versions of a text field.
 *
 * An input element only ever tells you what it looks like now, so the edit has
 * to be recovered from the shared prefix and suffix. That covers typing,
 * backspace, paste and replacing a selection, which is everything a plain
 * textarea can produce. It does not try to be a real diff: a change with two
 * separated edits comes back as one span covering both, which is still correct,
 * just less precise than it could be.
 */
export function diffText(before: string, after: string): TextPatch {
  let at = 0;
  const shortest = Math.min(before.length, after.length);
  while (at < shortest && before[at] === after[at]) at++;

  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > at && endAfter > at && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }

  return { at, removed: endBefore - at, added: after.slice(at, endAfter) };
}
