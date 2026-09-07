import type { VersionVector } from "@collab/crdt";
import type { Message } from "./messages.js";

/**
 * The obvious JSON framing, kept around as the reference implementation and as
 * the baseline the latency benchmark compares against. Maps don't survive
 * JSON.stringify, so version vectors get flattened to pairs on the way out.
 */
export function encodeJson(msg: Message): string {
  return JSON.stringify(msg, (_key, value) =>
    value instanceof Map ? { __vv: [...value] } : value,
  );
}

export function decodeJson(text: string): Message {
  return JSON.parse(text, (_key, value) => {
    if (value !== null && typeof value === "object" && Array.isArray(value.__vv)) {
      return new Map(value.__vv) as VersionVector;
    }
    return value;
  }) as Message;
}
