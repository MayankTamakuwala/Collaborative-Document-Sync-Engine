import type { Op, Snapshot, VersionVector } from "@collab/crdt";
import { Reader, Writer } from "./codec.js";
import { readOps, readSnapshot, readVersion, writeOps, writeSnapshot, writeVersion } from "./wire.js";

export interface Presence {
  name: string;
  color: string;
  /** Selection in visible character offsets. anchor === head means a caret. */
  anchor: number;
  head: number;
}

export interface PeerPresence {
  site: number;
  state: Presence;
}

export type ClientMessage =
  | { type: "hello"; doc: string; site: number; version: VersionVector }
  | { type: "ops"; ops: Op[] }
  | { type: "presence"; site: number; state: Presence | null }
  | { type: "ping"; at: number };

export type ServerMessage =
  | { type: "welcome"; doc: string; snapshot: Snapshot | null; ops: Op[]; peers: PeerPresence[] }
  | { type: "ops"; ops: Op[] }
  | { type: "presence"; site: number; state: Presence | null }
  | { type: "reject"; code: string; detail: string }
  | { type: "pong"; at: number };

export type Message = ClientMessage | ServerMessage;

const T_HELLO = 1;
const T_WELCOME = 2;
const T_OPS = 3;
const T_PRESENCE = 4;
const T_REJECT = 5;
const T_PING = 6;
const T_PONG = 7;

export function encode(msg: Message): Uint8Array {
  const w = new Writer();
  switch (msg.type) {
    case "hello":
      w.u8(T_HELLO);
      w.str(msg.doc);
      w.varint(msg.site);
      writeVersion(w, msg.version);
      break;

    case "welcome":
      w.u8(T_WELCOME);
      w.str(msg.doc);
      if (msg.snapshot === null) {
        w.u8(0);
      } else {
        w.u8(1);
        writeSnapshot(w, msg.snapshot);
      }
      writeOps(w, msg.ops);
      w.varint(msg.peers.length);
      for (const peer of msg.peers) {
        w.varint(peer.site);
        writePresence(w, peer.state);
      }
      break;

    case "ops":
      w.u8(T_OPS);
      writeOps(w, msg.ops);
      break;

    case "presence":
      w.u8(T_PRESENCE);
      w.varint(msg.site);
      if (msg.state === null) {
        w.u8(0);
      } else {
        w.u8(1);
        writePresence(w, msg.state);
      }
      break;

    case "reject":
      w.u8(T_REJECT);
      w.str(msg.code);
      w.str(msg.detail);
      break;

    case "ping":
      w.u8(T_PING);
      w.varint(msg.at);
      break;

    case "pong":
      w.u8(T_PONG);
      w.varint(msg.at);
      break;
  }
  return w.finish();
}

export function decode(bytes: Uint8Array): Message {
  const r = new Reader(bytes);
  const tag = r.u8();

  switch (tag) {
    case T_HELLO:
      return { type: "hello", doc: r.str(), site: r.varint(), version: readVersion(r) };

    case T_WELCOME: {
      const doc = r.str();
      const snapshot = r.u8() === 1 ? readSnapshot(r) : null;
      const ops = readOps(r);
      const peers: PeerPresence[] = [];
      const count = r.varint();
      for (let i = 0; i < count; i++) {
        peers.push({ site: r.varint(), state: readPresence(r) });
      }
      return { type: "welcome", doc, snapshot, ops, peers };
    }

    case T_OPS:
      return { type: "ops", ops: readOps(r) };

    case T_PRESENCE: {
      const site = r.varint();
      const state = r.u8() === 1 ? readPresence(r) : null;
      return { type: "presence", site, state };
    }

    case T_REJECT:
      return { type: "reject", code: r.str(), detail: r.str() };

    case T_PING:
      return { type: "ping", at: r.varint() };

    case T_PONG:
      return { type: "pong", at: r.varint() };

    default:
      throw new Error(`unknown message tag ${tag}`);
  }
}

function writePresence(w: Writer, p: Presence): void {
  w.str(p.name);
  w.str(p.color);
  w.varint(p.anchor);
  w.varint(p.head);
}

function readPresence(r: Reader): Presence {
  return { name: r.str(), color: r.str(), anchor: r.varint(), head: r.varint() };
}
