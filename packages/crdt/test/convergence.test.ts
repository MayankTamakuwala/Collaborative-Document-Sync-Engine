import { describe, expect, it } from "vitest";
import { Doc } from "../src/doc.js";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["lorem", "ipsum", "dolor", "sit", "amet", "\n", " ", "x", "the end"];

function pushOne(doc: Doc, rand: () => number): void {
  const len = doc.length;
  if (len > 0 && rand() < 0.35) {
    const at = Math.floor(rand() * len);
    doc.delete(at, 1 + Math.floor(rand() * Math.min(6, len - at)));
    return;
  }
  const at = Math.floor(rand() * (len + 1));
  doc.insert(at, WORDS[Math.floor(rand() * WORDS.length)]);
}

/** Push everything everyone knows to everyone else until nothing moves. */
function settle(docs: Doc[]): void {
  for (let pass = 0; pass < docs.length + 1; pass++) {
    for (const from of docs) {
      for (const to of docs) {
        if (from !== to) to.apply(from.opsSince(to.version()));
      }
    }
  }
}

describe("eventual consistency", () => {
  it("converges under random interleaved editing", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rand = rng(seed);
      const docs = [new Doc(11), new Doc(22), new Doc(33), new Doc(44)];

      for (let step = 0; step < 300; step++) {
        pushOne(docs[Math.floor(rand() * docs.length)], rand);

        // Random one-way gossip, so replicas are constantly at different
        // points in history rather than moving in lockstep.
        if (rand() < 0.4) {
          const from = docs[Math.floor(rand() * docs.length)];
          const to = docs[Math.floor(rand() * docs.length)];
          if (from !== to) to.apply(from.opsSince(to.version()));
        }
      }

      settle(docs);
      const expected = docs[0].text;
      for (const doc of docs) {
        expect(doc.text, `seed ${seed}`).toBe(expected);
        expect(doc.deferred, `seed ${seed} left ops parked`).toBe(0);
      }
    }
  });

  it("heals after a partition", () => {
    const rand = rng(99);
    const left = [new Doc(1), new Doc(2)];
    const right = [new Doc(3), new Doc(4)];
    const all = [...left, ...right];

    all[0].insert(0, "shared starting point\n");
    settle(all);

    for (let step = 0; step < 200; step++) {
      pushOne(left[Math.floor(rand() * 2)], rand);
      pushOne(right[Math.floor(rand() * 2)], rand);
      settle(left);
      settle(right);
    }

    expect(left[0].text).toBe(left[1].text);
    expect(right[0].text).toBe(right[1].text);
    expect(left[0].text).not.toBe(right[0].text);

    settle(all);
    for (const doc of all) expect(doc.text).toBe(all[0].text);
  });

  it("delivers the same result no matter what order ops arrive in", () => {
    const rand = rng(4242);
    const author = new Doc(1);
    const peer = new Doc(2);

    const stream: ReturnType<Doc["insert"]> = [];
    for (let i = 0; i < 120; i++) {
      const before = author.version();
      pushOne(author, rand);
      stream.push(...author.opsSince(before));
    }

    // Shuffle the whole stream and feed it in one op at a time.
    for (let i = stream.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [stream[i], stream[j]] = [stream[j], stream[i]];
    }
    for (const op of stream) peer.apply([op]);

    expect(peer.deferred).toBe(0);
    expect(peer.text).toBe(author.text);
  });
});
