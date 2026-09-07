import type { OpId } from "./id.js";

export interface InsertOp {
  kind: "ins";
  /** Id of the first character in `text`. The rest follow it consecutively. */
  id: OpId;
  /** Lamport stamp of the first character; used to order concurrent inserts. */
  lamport: number;
  /** The character this run was typed after, or null for the start of the doc. */
  origin: OpId | null;
  text: string;
}

export interface DeleteOp {
  kind: "del";
  /** Deletes do not create characters but they still burn a seq so that the
   *  version vector stays gap-free. */
  id: OpId;
  target: OpId;
  len: number;
}

export type Op = InsertOp | DeleteOp;

/** How many seq numbers an op consumes from its site. */
export function opWidth(op: Op): number {
  return op.kind === "ins" ? op.text.length : 1;
}

/**
 * Position-level description of what an op did to the visible text. Editors
 * need this to patch their buffer and shift local cursors; the engine only
 * bothers computing it when somebody is listening.
 */
export type DocEvent =
  | { type: "insert"; index: number; text: string }
  | { type: "delete"; index: number; len: number };
