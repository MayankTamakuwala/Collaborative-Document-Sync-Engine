import { id, newSiteId, type OpId } from "./id.js";
import { opWidth, type DeleteOp, type DocEvent, type InsertOp, type Op } from "./ops.js";
import { Rga } from "./rga.js";
import {
  cloneVersion,
  emptyVersion,
  mergeVersion,
  nextSeq,
  observe,
  seen,
  type VersionVector,
} from "./version.js";

export interface Snapshot {
  lamport: number;
  version: Array<[number, number]>;
  blocks: Array<{
    id: OpId;
    lamport: number;
    origin: OpId | null;
    text: string;
    deleted: boolean;
  }>;
}

export type ChangeSource = "local" | "remote";
export type ChangeListener = (events: DocEvent[], source: ChangeSource) => void;

type Readiness = "ready" | "waiting" | "duplicate";

/**
 * A single replica of a document: the sequence itself, the version vector that
 * says what we've integrated, and a log of ops so we can answer "what did I
 * miss" when a peer reconnects.
 */
export class Doc {
  readonly site: number;

  private rga: Rga;
  private vv: VersionVector;
  private lamport: number;
  private history: Op[] = [];
  /** Ops whose causal dependencies haven't shown up yet. */
  private waiting: Op[] = [];
  private listeners: ChangeListener[] = [];

  constructor(site: number = newSiteId()) {
    this.site = site;
    this.rga = new Rga();
    this.vv = emptyVersion();
    this.lamport = 0;
  }

  get text(): string {
    return this.rga.text();
  }

  get length(): number {
    return this.rga.length;
  }

  /** Ops we are holding back because we haven't seen what they depend on. */
  get deferred(): number {
    return this.waiting.length;
  }

  version(): VersionVector {
    return cloneVersion(this.vv);
  }

  onChange(fn: ChangeListener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  insert(index: number, text: string): Op[] {
    if (text.length === 0) return [];
    if (index < 0 || index > this.rga.length) {
      throw new RangeError(`insert at ${index} outside 0..${this.rga.length}`);
    }

    const origin = index === 0 ? null : this.rga.idAt(index - 1);
    const op: InsertOp = {
      kind: "ins",
      id: id(this.site, nextSeq(this.vv, this.site)),
      lamport: this.lamport + 1,
      origin,
      text,
    };

    const events = this.listeners.length > 0 ? [] : undefined;
    this.rga.integrateInsert(op, events);
    this.lamport += text.length;
    observe(this.vv, this.site, op.id.seq, text.length);
    this.history.push(op);

    if (events !== undefined) this.emit(events, "local");
    return [op];
  }

  delete(index: number, count: number): Op[] {
    if (count <= 0) return [];
    if (index < 0 || index + count > this.rga.length) {
      throw new RangeError(`delete ${index}..${index + count} outside 0..${this.rga.length}`);
    }

    // One user-visible range can map to several id runs once other people's
    // edits have been spliced through it.
    const events = this.listeners.length > 0 ? [] : undefined;
    const ops: Op[] = [];

    for (const run of this.rga.runsIn(index, count)) {
      const op: DeleteOp = {
        kind: "del",
        id: id(this.site, nextSeq(this.vv, this.site)),
        target: run.target,
        len: run.len,
      };
      this.rga.integrateDelete(op, events);
      observe(this.vv, this.site, op.id.seq, 1);
      this.history.push(op);
      ops.push(op);
    }

    if (events !== undefined && events.length > 0) this.emit(events, "local");
    return ops;
  }

  /**
   * Integrate ops from somewhere else. Anything that arrives out of order is
   * parked until its dependencies land, so callers can hand us whatever the
   * transport gave them without sorting first.
   */
  apply(incoming: Op[]): DocEvent[] {
    if (incoming.length === 0) return [];
    for (const op of incoming) this.waiting.push(op);

    const events: DocEvent[] = [];
    this.drain(this.listeners.length > 0 ? events : undefined);
    if (events.length > 0) this.emit(events, "remote");
    return events;
  }

  /** Everything in our log that `their` version vector hasn't seen yet. */
  opsSince(their: VersionVector): Op[] {
    const out: Op[] = [];
    for (const op of this.history) {
      const have = nextSeq(their, op.id.site);
      if (op.id.seq + opWidth(op) <= have) continue;
      out.push(op.id.seq >= have ? op : sliceInsert(op as InsertOp, have));
    }
    return out;
  }

  /** Drop log entries everyone has already acknowledged. */
  forgetBefore(acked: VersionVector): number {
    const keep: Op[] = [];
    for (const op of this.history) {
      if (op.id.seq + opWidth(op) > nextSeq(acked, op.id.site)) keep.push(op);
    }
    const dropped = this.history.length - keep.length;
    this.history = keep;
    return dropped;
  }

  snapshot(): Snapshot {
    const blocks: Snapshot["blocks"] = [];
    for (const b of this.rga.blocks()) {
      blocks.push({ id: b.id, lamport: b.lamport, origin: b.origin, text: b.text, deleted: b.deleted });
    }
    return { lamport: this.lamport, version: [...this.vv], blocks };
  }

  /**
   * Fold a full server snapshot into this replica without throwing away local
   * work. Used when we've been offline long enough that the server can no
   * longer serve us a delta but we still have unsent edits of our own.
   *
   * Blocks arrive in document order, and a block's origin always sits to its
   * left, so that order is already a valid causal order for the inserts.
   */
  absorb(snap: Snapshot): DocEvent[] {
    const events: DocEvent[] = [];
    const sink = this.listeners.length > 0 ? events : undefined;

    for (const block of snap.blocks) {
      const have = nextSeq(this.vv, block.id.site);
      if (block.id.seq + block.text.length <= have) continue;

      const from = Math.max(block.id.seq, have);
      const offset = from - block.id.seq;
      this.waiting.push({
        kind: "ins",
        id: id(block.id.site, from),
        lamport: block.lamport + offset,
        origin: offset > 0 ? id(block.id.site, from - 1) : block.origin,
        text: block.text.slice(offset),
      });
    }
    this.drain(sink);

    for (const block of snap.blocks) {
      if (block.deleted) this.rga.tombstone(block.id, block.text.length, sink);
    }

    // The snapshot carries the effect of every op behind its version vector,
    // so claiming to have seen them is accurate even though our op log has
    // nothing to show for it.
    mergeVersion(this.vv, new Map(snap.version));
    if (snap.lamport > this.lamport) this.lamport = snap.lamport;

    if (events.length > 0) this.emit(events, "remote");
    return events;
  }

  static fromSnapshot(site: number, snap: Snapshot): Doc {
    const doc = new Doc(site);
    doc.rga = Rga.fromBlocks(snap.blocks);
    doc.vv = new Map(snap.version);
    doc.lamport = snap.lamport;
    return doc;
  }

  private drain(events: DocEvent[] | undefined): void {
    let moved = true;
    while (moved) {
      moved = false;
      for (let i = 0; i < this.waiting.length; ) {
        const op = this.waiting[i];
        const state = this.readiness(op);
        if (state === "waiting") {
          i += 1;
          continue;
        }
        this.waiting.splice(i, 1);
        if (state === "ready") {
          this.integrate(op, events);
          moved = true;
        }
      }
    }
  }

  private readiness(op: Op): Readiness {
    const expected = nextSeq(this.vv, op.id.site);
    if (op.id.seq < expected) return "duplicate";
    if (op.id.seq > expected) return "waiting";

    if (op.kind === "ins") {
      return op.origin === null || seen(this.vv, op.origin) ? "ready" : "waiting";
    }
    return seen(this.vv, id(op.target.site, op.target.seq + op.len - 1)) ? "ready" : "waiting";
  }

  private integrate(op: Op, events: DocEvent[] | undefined): void {
    if (op.kind === "ins") {
      this.rga.integrateInsert(op, events);
      const tail = op.lamport + op.text.length - 1;
      if (tail > this.lamport) this.lamport = tail;
    } else {
      this.rga.integrateDelete(op, events);
    }
    observe(this.vv, op.id.site, op.id.seq, opWidth(op));
    this.history.push(op);
  }

  private emit(events: DocEvent[], source: ChangeSource): void {
    for (const fn of this.listeners) fn(events, source);
  }
}

/** Trim an insert run down to the part starting at `from`. */
function sliceInsert(op: InsertOp, from: number): InsertOp {
  const offset = from - op.id.seq;
  return {
    kind: "ins",
    id: id(op.id.site, from),
    lamport: op.lamport + offset,
    origin: id(op.id.site, from - 1),
    text: op.text.slice(offset),
  };
}
