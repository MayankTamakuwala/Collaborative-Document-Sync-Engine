import { Doc, type Op } from "@collab/crdt";
import { describe, expect, it } from "vitest";
import { decodeJson, encodeJson } from "../src/json.js";
import { decode, encode, type Message } from "../src/messages.js";

function typedDoc(): { doc: Doc; ops: Op[] } {
  const doc = new Doc(4242);
  const ops: Op[] = [];
  ops.push(...doc.insert(0, "the quick brown fox"));
  ops.push(...doc.insert(19, " jumps over the lazy dog"));
  ops.push(...doc.delete(4, 6));
  ops.push(...doc.insert(4, "sluggish "));
  ops.push(...doc.delete(0, 3));
  return { doc, ops };
}

function roundTrip(msg: Message): Message {
  return decode(encode(msg));
}

describe("binary framing", () => {
  it("round-trips an op batch", () => {
    const { ops } = typedDoc();
    expect(roundTrip({ type: "ops", ops })).toEqual({ type: "ops", ops });
  });

  it("round-trips a snapshot and its version vector", () => {
    const { doc } = typedDoc();
    const msg: Message = {
      type: "welcome",
      doc: "notes",
      version: doc.version(),
      snapshot: doc.snapshot(),
      ops: [],
      peers: [{ site: 7, state: { name: "sam", color: "#f80", anchor: 3, head: 9 } }],
    };
    const back = roundTrip(msg) as typeof msg;

    expect(back.snapshot).toEqual(doc.snapshot());
    expect(back.peers).toEqual(msg.peers);
    expect(Doc.fromSnapshot(1, back.snapshot!).text).toBe(doc.text);
  });

  it("round-trips the small messages", () => {
    const version = new Map([
      [1, 40],
      [2, 12],
    ]);
    expect(roundTrip({ type: "hello", doc: "notes", site: 9, version })).toEqual({
      type: "hello",
      doc: "notes",
      site: 9,
      version,
    });
    expect(roundTrip({ type: "presence", site: 3, state: null })).toEqual({
      type: "presence",
      site: 3,
      state: null,
    });
    expect(roundTrip({ type: "reject", code: "site_taken", detail: "pick another" })).toEqual({
      type: "reject",
      code: "site_taken",
      detail: "pick another",
    });
    expect(roundTrip({ type: "ping", at: 1234567 })).toEqual({ type: "ping", at: 1234567 });
  });

  it("rejects a frame with an unknown tag", () => {
    expect(() => decode(new Uint8Array([200, 0, 0]))).toThrow(/unknown message tag/);
  });

  it("is meaningfully smaller than the JSON framing", () => {
    // A burst of single character ops is the worst case for JSON: every op
    // repeats the site, the origin and all of the key names.
    const doc = new Doc(918273);
    const ops: Op[] = [];
    for (let i = 0; i < 500; i++) ops.push(...doc.insert(i, "x"));

    const msg: Message = { type: "ops", ops };
    const binary = encode(msg).byteLength;
    const json = new TextEncoder().encode(encodeJson(msg)).byteLength;

    expect(decodeJson(encodeJson(msg))).toEqual(msg);
    expect(binary).toBeLessThan(json * 0.2);
  });
});
