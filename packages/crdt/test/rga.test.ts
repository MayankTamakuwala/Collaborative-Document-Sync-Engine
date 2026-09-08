import { describe, expect, it } from "vitest";
import { coalesce } from "../src/coalesce.js";
import { Doc } from "../src/doc.js";

function sync(from: Doc, to: Doc): void {
  to.apply(from.opsSince(to.version()));
}

function join(...docs: Doc[]): void {
  for (const a of docs) for (const b of docs) if (a !== b) sync(a, b);
}

describe("local editing", () => {
  it("inserts and deletes like a string", () => {
    const doc = new Doc(1);
    doc.insert(0, "hello world");
    doc.insert(5, ",");
    expect(doc.text).toBe("hello, world");

    doc.delete(5, 1);
    expect(doc.text).toBe("hello world");
    expect(doc.length).toBe(11);
  });

  it("rejects out of range edits", () => {
    const doc = new Doc(1);
    doc.insert(0, "abc");
    expect(() => doc.insert(9, "x")).toThrow(RangeError);
    expect(() => doc.delete(2, 5)).toThrow(RangeError);
  });

  it("keeps sequential typing in one block", () => {
    const doc = new Doc(1);
    for (let i = 0; i < 200; i++) doc.insert(i, "a");
    expect(doc.text.length).toBe(200);
    expect(doc.snapshot().blocks.length).toBe(1);
  });
});

describe("two replicas", () => {
  it("converges on a straightforward exchange", () => {
    const a = new Doc(1);
    const b = new Doc(2);

    a.insert(0, "the quick brown fox");
    join(a, b);
    expect(b.text).toBe("the quick brown fox");

    b.insert(19, " jumps");
    a.insert(4, "very ");
    join(a, b);

    expect(a.text).toBe(b.text);
    expect(a.text).toBe("the very quick brown fox jumps");
  });

  it("orders concurrent inserts at the same spot deterministically", () => {
    const a = new Doc(1);
    const b = new Doc(2);
    a.insert(0, "><");
    join(a, b);

    a.insert(1, "aaa");
    b.insert(1, "bbb");
    join(a, b);

    expect(a.text).toBe(b.text);
    // Both runs survive intact rather than getting shuffled together.
    expect(a.text).toMatch(/^>(aaa|bbb)(aaa|bbb)<$/);
  });

  it("survives concurrent delete of the same range", () => {
    const a = new Doc(1);
    const b = new Doc(2);
    a.insert(0, "abcdef");
    join(a, b);

    a.delete(2, 2);
    b.delete(2, 2);
    join(a, b);

    expect(a.text).toBe("abef");
    expect(b.text).toBe("abef");
  });

  it("keeps an insert that lands inside a concurrently deleted range", () => {
    const a = new Doc(1);
    const b = new Doc(2);
    a.insert(0, "abcdef");
    join(a, b);

    a.delete(1, 4);
    b.insert(3, "XY");
    join(a, b);

    expect(a.text).toBe(b.text);
    expect(a.text).toBe("aXYf");
  });
});

describe("delivery order", () => {
  it("parks ops until their dependencies arrive", () => {
    const a = new Doc(1);
    const b = new Doc(2);

    const first = a.insert(0, "hello");
    const second = a.insert(5, " there");

    b.apply(second);
    expect(b.text).toBe("");
    expect(b.deferred).toBe(1);

    b.apply(first);
    expect(b.text).toBe("hello there");
    expect(b.deferred).toBe(0);
  });

  it("ignores ops it has already integrated", () => {
    const a = new Doc(1);
    const b = new Doc(2);
    const ops = a.insert(0, "abc");

    b.apply(ops);
    b.apply(ops);
    b.apply(ops);
    expect(b.text).toBe("abc");
  });
});

describe("snapshots", () => {
  it("round-trips through a snapshot", () => {
    const a = new Doc(1);
    a.insert(0, "hello world");
    a.delete(5, 6);
    a.insert(5, ", crdt");

    const restored = Doc.fromSnapshot(7, a.snapshot());
    expect(restored.text).toBe(a.text);

    // A restored replica can still take new remote ops.
    const b = new Doc(2);
    sync(a, b);
    b.insert(0, ">> ");
    restored.apply(b.opsSince(restored.version()));
    expect(restored.text).toBe(">> hello, crdt");
  });
});

describe("coalescing", () => {
  it("folds a burst of keystrokes into one op", () => {
    const doc = new Doc(1);
    const typed: ReturnType<Doc["insert"]> = [];
    for (const ch of "hello") typed.push(...doc.insert(doc.length, ch));

    const merged = coalesce(typed);
    expect(typed).toHaveLength(5);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ kind: "ins", text: "hello" });

    const peer = new Doc(2);
    peer.apply(merged);
    expect(peer.text).toBe("hello");
  });

  it("does not merge across a jump or a delete", () => {
    const doc = new Doc(1);
    const ops = [
      ...doc.insert(0, "ab"),
      ...doc.insert(0, "c"),
      ...doc.insert(3, "d"),
      ...doc.delete(0, 1),
    ];
    expect(coalesce(ops)).toHaveLength(4);

    const peer = new Doc(2);
    peer.apply(coalesce(ops));
    expect(peer.text).toBe(doc.text);
  });
});

describe("absorbing a snapshot", () => {
  it("keeps local edits made while the snapshot was being fetched", () => {
    const server = new Doc(1);
    server.insert(0, "server side text");
    server.delete(0, 7);

    const client = new Doc(2);
    client.insert(0, "offline note\n");

    client.absorb(server.snapshot());
    expect(client.text).toContain("offline note");
    expect(client.text).toContain("side text");

    // And the server still converges once it hears about the local edits.
    server.apply(client.opsSince(server.version()));
    expect(server.text).toBe(client.text);
  });

  it("ignores the parts of a snapshot it already has", () => {
    const a = new Doc(1);
    a.insert(0, "one two three");
    const b = new Doc(2);
    b.apply(a.opsSince(b.version()));

    a.insert(13, " four");
    b.absorb(a.snapshot());

    expect(b.text).toBe("one two three four");
    expect(b.snapshot().blocks.length).toBe(1);
  });
});
