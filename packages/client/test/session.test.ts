import { describe, expect, it } from "vitest";
import { DocSession } from "../src/session.js";
import { TestNet } from "./harness.js";

function open(net: TestNet, site: number, name: string) {
  const session = new DocSession({
    url: "memory://notes",
    doc: "notes",
    site,
    name,
    batchMs: 0,
    presenceMs: 0,
    pingMs: 0,
    backoff: { firstDelayMs: 1, maxDelayMs: 2, jitter: 0 },
    connect: net.connect,
  });
  session.connect();
  return session;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("DocSession", () => {
  it("brings two clients to the same text", async () => {
    const net = new TestNet();
    const ana = open(net, 1, "ana");
    const bo = open(net, 2, "bo");
    await net.settle();

    ana.insert(0, "hello");
    await net.settle();
    bo.insert(bo.doc.length, " world");
    await net.settle();

    expect(ana.text).toBe("hello world");
    expect(bo.text).toBe("hello world");
    expect(ana.status).toBe("online");

    ana.close();
    bo.close();
  });

  it("gives a late joiner the document as it stands", async () => {
    const net = new TestNet();
    const ana = open(net, 1, "ana");
    await net.settle();
    ana.insert(0, "written before you got here");
    await net.settle();

    const bo = open(net, 2, "bo");
    await net.settle();
    expect(bo.text).toBe("written before you got here");

    ana.close();
    bo.close();
  });

  it("shares cursors and drops them when someone leaves", async () => {
    const net = new TestNet();
    const ana = open(net, 1, "ana");
    const bo = open(net, 2, "bo");
    await net.settle();

    ana.insert(0, "0123456789");
    await net.settle();
    ana.setSelection(3, 6);
    await net.settle();

    expect(bo.peers()).toEqual([
      { site: 1, state: { name: "ana", color: "#6c8cff", anchor: 3, head: 6 } },
    ]);

    ana.close();
    await net.settle();
    expect(bo.peers()).toEqual([]);

    bo.close();
  });

  it("pushes remote carets along when text lands in front of them", async () => {
    const net = new TestNet();
    const ana = open(net, 1, "ana");
    const bo = open(net, 2, "bo");
    await net.settle();

    ana.insert(0, "abcdef");
    await net.settle();
    ana.setSelection(4, 4);
    await net.settle();

    bo.insert(0, "XXX");
    await net.settle();

    expect(bo.peers()[0].state).toMatchObject({ anchor: 7, head: 7 });

    ana.close();
    bo.close();
  });

  it("syncs edits made while the connection was down", async () => {
    const net = new TestNet();
    const ana = open(net, 1, "ana");
    const bo = open(net, 2, "bo");
    await net.settle();

    ana.insert(0, "shared\n");
    await net.settle();

    net.cutAll();
    await net.settle();
    expect(ana.status).toBe("offline");

    ana.insert(ana.doc.length, "typed while offline\n");
    bo.insert(bo.doc.length, "so was this\n");
    await net.settle();

    // Reconnect timers are real, so give them a moment.
    await sleep(20);
    await net.settle();
    await sleep(20);
    await net.settle();

    expect(ana.status).toBe("online");
    expect(bo.status).toBe("online");
    expect(ana.text).toBe(bo.text);
    expect(ana.text).toContain("typed while offline");
    expect(ana.text).toContain("so was this");

    ana.close();
    bo.close();
  });

  it("stops trying once the caller closes it", async () => {
    const net = new TestNet();
    const ana = open(net, 1, "ana");
    await net.settle();

    ana.close();
    net.cutAll();
    await net.settle();
    await sleep(20);
    await net.settle();

    expect(ana.status).toBe("closed");
  });
});

describe("batching", () => {
  it("sends one frame for a burst of keystrokes", async () => {
    const net = new TestNet();
    const ana = new DocSession({
      url: "memory://notes",
      doc: "notes",
      site: 1,
      batchMs: 5,
      pingMs: 0,
      connect: net.connect,
    });
    ana.connect();
    await net.settle();

    const before = net.toServer;
    for (const ch of "hello there") ana.insert(ana.doc.length, ch);
    // The first keystroke leaves immediately; the other ten wait for the floor.
    expect(net.toServer - before).toBe(1);

    await sleep(15);
    await net.settle();
    expect(net.toServer - before).toBe(2);

    const bo = open(net, 2, "bo");
    await net.settle();
    expect(bo.text).toBe("hello there");

    ana.close();
    bo.close();
  });
});
