import { Doc, emptyVersion } from "@collab/crdt";
import { decode, type ServerMessage } from "@collab/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { Hub } from "../src/hub.js";
import { Room, type Connection } from "../src/room.js";
import { MemoryStore } from "../src/store.js";

class FakeConn implements Connection {
  received: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;

  send(frame: Uint8Array): void {
    this.received.push(decode(frame) as ServerMessage);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  last(): ServerMessage {
    return this.received[this.received.length - 1];
  }

  take(): ServerMessage[] {
    const out = this.received;
    this.received = [];
    return out;
  }
}

/** Stand-in for a browser: a replica plus the socket it talks through. */
function client(site: number) {
  return { site, doc: new Doc(site), conn: new FakeConn() };
}

describe("Room", () => {
  let room: Room;

  beforeEach(() => {
    room = new Room("notes");
  });

  it("sends a snapshot to a client that shows up empty-handed", () => {
    const a = client(1);
    room.join(a.site, a.conn, emptyVersion());
    room.receive(a.site, { type: "ops", ops: a.doc.insert(0, "hello") });

    const b = client(2);
    room.join(b.site, b.conn, emptyVersion());

    const welcome = b.conn.last();
    expect(welcome.type).toBe("welcome");
    if (welcome.type !== "welcome") throw new Error("unreachable");
    expect(welcome.snapshot).not.toBeNull();
    expect(Doc.fromSnapshot(b.site, welcome.snapshot!).text).toBe("hello");
  });

  it("sends only the delta to a client that is resuming", () => {
    const a = client(1);
    const b = client(2);
    room.join(a.site, a.conn, emptyVersion());
    room.join(b.site, b.conn, emptyVersion());

    room.receive(a.site, { type: "ops", ops: a.doc.insert(0, "hello") });
    b.doc.apply(a.doc.opsSince(b.doc.version()));

    room.leave(b.site);
    room.receive(a.site, { type: "ops", ops: a.doc.insert(5, " again") });

    const resumed = new FakeConn();
    room.join(b.site, resumed, b.doc.version());

    const welcome = resumed.last();
    if (welcome.type !== "welcome") throw new Error("expected welcome");
    expect(welcome.snapshot).toBeNull();
    b.doc.apply(welcome.ops);
    expect(b.doc.text).toBe("hello again");
  });

  it("falls back to a snapshot once the log has moved past a client", () => {
    const a = client(1);
    const b = client(2);
    room.join(a.site, a.conn, emptyVersion());
    room.join(b.site, b.conn, emptyVersion());

    room.receive(a.site, { type: "ops", ops: a.doc.insert(0, "start") });
    b.doc.apply(a.doc.opsSince(b.doc.version()));
    const behind = b.doc.version();
    room.leave(b.site);

    for (let i = 0; i < 40; i++) {
      room.receive(a.site, { type: "ops", ops: a.doc.insert(a.doc.length, "x") });
    }
    expect(room.logSize).toBeGreaterThan(10);
    room.trimLog(5);

    const resumed = new FakeConn();
    room.join(b.site, resumed, behind);
    const welcome = resumed.last();
    if (welcome.type !== "welcome") throw new Error("expected welcome");

    expect(welcome.snapshot).not.toBeNull();
    b.doc.absorb(welcome.snapshot!);
    expect(b.doc.text).toBe(room.text);
  });

  it("relays ops to everyone but the author", () => {
    const a = client(1);
    const b = client(2);
    const c = client(3);
    for (const m of [a, b, c]) room.join(m.site, m.conn, emptyVersion());
    for (const m of [a, b, c]) m.conn.take();

    room.receive(a.site, { type: "ops", ops: a.doc.insert(0, "shared") });

    expect(a.conn.take()).toEqual([]);
    for (const m of [b, c]) {
      const msg = m.conn.last();
      if (msg.type !== "ops") throw new Error("expected ops");
      m.doc.apply(msg.ops);
      expect(m.doc.text).toBe("shared");
    }
  });

  it("refuses to accept ops attributed to another site", () => {
    const a = client(1);
    const impostor = client(2);
    room.join(a.site, a.conn, emptyVersion());
    room.join(impostor.site, impostor.conn, emptyVersion());
    impostor.conn.take();

    room.receive(impostor.site, { type: "ops", ops: a.doc.insert(0, "not mine") });

    const msg = impostor.conn.last();
    expect(msg.type).toBe("reject");
    if (msg.type === "reject") expect(msg.code).toBe("forged_op");
    expect(impostor.conn.closed?.code).toBe(4000);
    expect(room.text).toBe("");
  });

  it("turns down a second connection claiming the same site", () => {
    const a = client(1);
    room.join(a.site, a.conn, emptyVersion());
    const twin = new FakeConn();
    expect(room.join(a.site, twin, emptyVersion())).toMatchObject({ ok: false, code: "site_taken" });
  });

  it("announces presence and clears it when someone leaves", () => {
    const a = client(1);
    const b = client(2);
    room.join(a.site, a.conn, emptyVersion());
    room.join(b.site, b.conn, emptyVersion());
    b.conn.take();

    const state = { name: "ana", color: "#3af", anchor: 2, head: 4 };
    room.receive(a.site, { type: "presence", site: a.site, state });
    expect(b.conn.last()).toEqual({ type: "presence", site: a.site, state });

    room.leave(a.site);
    expect(b.conn.last()).toEqual({ type: "presence", site: a.site, state: null });
  });

  it("hands a joiner the presence of everyone already in the room", () => {
    const a = client(1);
    room.join(a.site, a.conn, emptyVersion());
    const state = { name: "ana", color: "#3af", anchor: 0, head: 0 };
    room.receive(a.site, { type: "presence", site: a.site, state });

    const b = client(2);
    room.join(b.site, b.conn, emptyVersion());
    const welcome = b.conn.last();
    if (welcome.type !== "welcome") throw new Error("expected welcome");
    expect(welcome.peers).toEqual([{ site: a.site, state }]);
  });
});

describe("Hub", () => {
  it("brings a document back after a restart", async () => {
    const store = new MemoryStore();
    const hub = new Hub(store);

    const room = await hub.room("notes");
    const a = client(1);
    room.join(a.site, a.conn, emptyVersion());
    room.receive(a.site, { type: "ops", ops: a.doc.insert(0, "persist me") });
    await hub.flush("notes");
    await hub.close();

    const revived = await new Hub(store).room("notes");
    expect(revived.text).toBe("persist me");
  });

  it("only builds one room when two clients race for a cold document", async () => {
    const hub = new Hub(new MemoryStore());
    const [first, second] = await Promise.all([hub.room("race"), hub.room("race")]);
    expect(first).toBe(second);
  });
});
