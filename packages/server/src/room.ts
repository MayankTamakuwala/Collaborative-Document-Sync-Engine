import { covers, Doc, emptyVersion, type Snapshot, type VersionVector } from "@collab/crdt";
import { encode, type ClientMessage, type Presence, type ServerMessage } from "@collab/protocol";

/** Whatever the transport is, the room only needs these two calls. */
export interface Connection {
  send(frame: Uint8Array): void;
  close(code: number, reason: string): void;
}

interface Member {
  site: number;
  conn: Connection;
  presence: Presence | null;
}

export interface JoinResult {
  ok: boolean;
  code?: string;
  detail?: string;
}

/** The server is just another replica that happens to never type anything. */
const SERVER_SITE = 0;

export class Room {
  readonly id: string;

  private doc: Doc;
  private members = new Map<number, Member>();
  /** Oldest version our op log can still serve a delta from. */
  private logFloor: VersionVector = emptyVersion();
  private unsaved = 0;

  constructor(id: string, snapshot?: Snapshot | null) {
    this.id = id;
    this.doc = snapshot ? Doc.fromSnapshot(SERVER_SITE, snapshot) : new Doc(SERVER_SITE);
    if (snapshot) this.logFloor = new Map(snapshot.version);
  }

  get size(): number {
    return this.members.size;
  }

  get text(): string {
    return this.doc.text;
  }

  get pendingWrites(): number {
    return this.unsaved;
  }

  version(): VersionVector {
    return this.doc.version();
  }

  snapshot(): Snapshot {
    return this.doc.snapshot();
  }

  join(site: number, conn: Connection, since: VersionVector): JoinResult {
    if (site === SERVER_SITE) {
      return { ok: false, code: "bad_site", detail: "site 0 is reserved" };
    }
    if (this.members.has(site)) {
      return { ok: false, code: "site_taken", detail: `site ${site} is already in this room` };
    }

    const member: Member = { site, conn, presence: null };
    this.members.set(site, member);

    // A brand new client, or one that fell behind further than our log goes,
    // gets the whole document. Everyone else gets just what they missed.
    const catchUpFromLog = since.size > 0 && covers(since, this.logFloor);
    const welcome: ServerMessage = {
      type: "welcome",
      doc: this.id,
      version: this.doc.version(),
      snapshot: catchUpFromLog ? null : this.doc.snapshot(),
      ops: catchUpFromLog ? this.doc.opsSince(since) : [],
      peers: [...this.members.values()]
        .filter((m) => m.site !== site && m.presence !== null)
        .map((m) => ({ site: m.site, state: m.presence! })),
    };
    conn.send(encode(welcome));
    return { ok: true };
  }

  leave(site: number): void {
    const member = this.members.get(site);
    if (member === undefined) return;
    this.members.delete(site);
    if (member.presence !== null) {
      this.broadcast({ type: "presence", site, state: null });
    }
  }

  receive(site: number, msg: ClientMessage): void {
    const member = this.members.get(site);
    if (member === undefined) return;

    switch (msg.type) {
      case "ops": {
        // Clients only get to speak for themselves. Without this one client
        // could forge ops under someone else's site and poison the doc.
        for (const op of msg.ops) {
          if (op.id.site !== site) {
            this.reject(member, "forged_op", `op claims site ${op.id.site}`);
            return;
          }
        }
        this.doc.apply(msg.ops);
        this.unsaved += msg.ops.length;
        // Relayed verbatim: peers dedupe and buffer on their own, so there is
        // nothing to gain from re-deriving the batch here.
        this.broadcast({ type: "ops", ops: msg.ops }, site);
        break;
      }

      case "presence":
        member.presence = msg.state;
        this.broadcast({ type: "presence", site, state: msg.state }, site);
        break;

      case "ping":
        member.conn.send(encode({ type: "pong", at: msg.at }));
        break;

      case "hello":
        this.reject(member, "already_joined", "hello sent twice on one connection");
        break;
    }
  }

  /** Called after a snapshot lands on disk; lets the op log shrink. */
  markSaved(at: VersionVector): void {
    this.doc.forgetBefore(at);
    this.logFloor = at;
    this.unsaved = 0;
  }

  private broadcast(msg: ServerMessage, except?: number): void {
    // Encode once, hand the same buffer to every socket.
    const frame = encode(msg);
    for (const member of this.members.values()) {
      if (member.site !== except) member.conn.send(frame);
    }
  }

  private reject(member: Member, code: string, detail: string): void {
    member.conn.send(encode({ type: "reject", code, detail }));
    member.conn.close(4000, code);
    this.members.delete(member.site);
  }
}
