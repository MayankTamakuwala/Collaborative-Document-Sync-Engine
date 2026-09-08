import type { Op } from "./ops.js";

/**
 * Collapse a run of single-character inserts back into one op.
 *
 * Typing produces one op per keystroke, but consecutive keystrokes from one
 * site are exactly the shape a single run op describes, so a 16ms batch of
 * "hello" goes out as one op instead of five.
 *
 * Deletes are deliberately left alone: an op's id block is one seq wide for a
 * delete, so merging two of them would leave a hole in the sender's seq space
 * and every peer would park the batch forever waiting for the missing id.
 */
export function coalesce(ops: Op[]): Op[] {
  const out: Op[] = [];

  for (const op of ops) {
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      prev.kind === "ins" &&
      op.kind === "ins" &&
      prev.id.site === op.id.site &&
      prev.id.seq + prev.text.length === op.id.seq &&
      prev.lamport + prev.text.length === op.lamport &&
      op.origin !== null &&
      op.origin.site === prev.id.site &&
      op.origin.seq === op.id.seq - 1
    ) {
      out[out.length - 1] = { ...prev, text: prev.text + op.text };
      continue;
    }
    out.push(op);
  }

  return out;
}
