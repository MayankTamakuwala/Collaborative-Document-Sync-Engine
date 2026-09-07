import type { Op, Snapshot, VersionVector } from "@collab/crdt";
import { Reader, Writer } from "./codec.js";

/*
 * Ops in a batch are highly self-similar: they usually come from one site,
 * their seqs run consecutively, and an insert's origin is almost always the
 * character right before it. The flag byte lets us drop those fields instead
 * of repeating them, which is where most of the size win comes from.
 */
const F_DEL = 0x01;
const F_SAME_SITE = 0x02;
const F_SEQ_RUN = 0x04;
const F_ORIGIN_PREV = 0x08;
const F_ORIGIN_NULL = 0x10;
const F_LAMPORT_RUN = 0x20;
const F_TARGET_RUN = 0x08;

export function writeOps(w: Writer, ops: Op[]): void {
  w.varint(ops.length);

  let site = -1;
  let seqEnd = -1;
  let lamportEnd = -1;
  let targetSite = -1;
  let targetEnd = -1;

  for (const op of ops) {
    const sameSite = op.id.site === site;
    const seqRun = sameSite && op.id.seq === seqEnd;

    let flags = op.kind === "del" ? F_DEL : 0;
    if (sameSite) flags |= F_SAME_SITE;
    if (seqRun) flags |= F_SEQ_RUN;

    if (op.kind === "ins") {
      const originPrev =
        op.origin !== null && op.origin.site === op.id.site && op.origin.seq === op.id.seq - 1;
      if (op.origin === null) flags |= F_ORIGIN_NULL;
      else if (originPrev) flags |= F_ORIGIN_PREV;
      if (op.lamport === lamportEnd) flags |= F_LAMPORT_RUN;

      w.u8(flags);
      if (!sameSite) w.varint(op.id.site);
      if (!seqRun) w.varint(op.id.seq);
      if ((flags & F_LAMPORT_RUN) === 0) w.varint(op.lamport);
      if ((flags & (F_ORIGIN_NULL | F_ORIGIN_PREV)) === 0) {
        w.varint(op.origin!.site);
        w.varint(op.origin!.seq);
      }
      w.str(op.text);

      lamportEnd = op.lamport + op.text.length;
      seqEnd = op.id.seq + op.text.length;
    } else {
      const targetRun = op.target.site === targetSite && op.target.seq === targetEnd;
      if (targetRun) flags |= F_TARGET_RUN;

      w.u8(flags);
      if (!sameSite) w.varint(op.id.site);
      if (!seqRun) w.varint(op.id.seq);
      if (!targetRun) {
        w.varint(op.target.site);
        w.varint(op.target.seq);
      }
      w.varint(op.len);

      targetSite = op.target.site;
      targetEnd = op.target.seq + op.len;
      seqEnd = op.id.seq + 1;
    }

    site = op.id.site;
  }
}

export function readOps(r: Reader): Op[] {
  const count = r.varint();
  const ops: Op[] = [];

  let site = -1;
  let seqEnd = -1;
  let lamportEnd = -1;
  let targetSite = -1;
  let targetEnd = -1;

  for (let i = 0; i < count; i++) {
    const flags = r.u8();
    if ((flags & F_SAME_SITE) === 0) site = r.varint();
    const seq = (flags & F_SEQ_RUN) !== 0 ? seqEnd : r.varint();

    if ((flags & F_DEL) === 0) {
      const lamport = (flags & F_LAMPORT_RUN) !== 0 ? lamportEnd : r.varint();
      let origin = null;
      if ((flags & F_ORIGIN_NULL) === 0) {
        origin =
          (flags & F_ORIGIN_PREV) !== 0
            ? { site, seq: seq - 1 }
            : { site: r.varint(), seq: r.varint() };
      }
      const text = r.str();
      ops.push({ kind: "ins", id: { site, seq }, lamport, origin, text });

      lamportEnd = lamport + text.length;
      seqEnd = seq + text.length;
    } else {
      const target =
        (flags & F_TARGET_RUN) !== 0
          ? { site: targetSite, seq: targetEnd }
          : { site: r.varint(), seq: r.varint() };
      const len = r.varint();
      ops.push({ kind: "del", id: { site, seq }, target, len });

      targetSite = target.site;
      targetEnd = target.seq + len;
      seqEnd = seq + 1;
    }
  }
  return ops;
}

export function writeVersion(w: Writer, vv: VersionVector): void {
  w.varint(vv.size);
  for (const [site, seq] of vv) {
    w.varint(site);
    w.varint(seq);
  }
}

export function readVersion(r: Reader): VersionVector {
  const count = r.varint();
  const vv = new Map<number, number>();
  for (let i = 0; i < count; i++) vv.set(r.varint(), r.varint());
  return vv;
}

const B_DELETED = 0x01;
const B_ORIGIN_NULL = 0x02;
const B_ORIGIN_PREV = 0x04;
const B_SAME_SITE = 0x08;

export function writeSnapshot(w: Writer, snap: Snapshot): void {
  w.varint(snap.lamport);
  w.varint(snap.version.length);
  for (const [site, seq] of snap.version) {
    w.varint(site);
    w.varint(seq);
  }

  w.varint(snap.blocks.length);
  let site = -1;
  for (const block of snap.blocks) {
    let flags = 0;
    if (block.deleted) flags |= B_DELETED;
    if (block.origin === null) flags |= B_ORIGIN_NULL;
    else if (block.origin.site === block.id.site && block.origin.seq === block.id.seq - 1) {
      flags |= B_ORIGIN_PREV;
    }
    if (block.id.site === site) flags |= B_SAME_SITE;

    w.u8(flags);
    if ((flags & B_SAME_SITE) === 0) w.varint(block.id.site);
    w.varint(block.id.seq);
    w.varint(block.lamport);
    if ((flags & (B_ORIGIN_NULL | B_ORIGIN_PREV)) === 0) {
      w.varint(block.origin!.site);
      w.varint(block.origin!.seq);
    }
    w.str(block.text);

    site = block.id.site;
  }
}

export function readSnapshot(r: Reader): Snapshot {
  const lamport = r.varint();
  const versionCount = r.varint();
  const version: Array<[number, number]> = [];
  for (let i = 0; i < versionCount; i++) version.push([r.varint(), r.varint()]);

  const blockCount = r.varint();
  const blocks: Snapshot["blocks"] = [];
  let site = -1;
  for (let i = 0; i < blockCount; i++) {
    const flags = r.u8();
    if ((flags & B_SAME_SITE) === 0) site = r.varint();
    const seq = r.varint();
    const blockLamport = r.varint();
    let origin = null;
    if ((flags & B_ORIGIN_NULL) === 0) {
      origin =
        (flags & B_ORIGIN_PREV) !== 0
          ? { site, seq: seq - 1 }
          : { site: r.varint(), seq: r.varint() };
    }
    const text = r.str();
    blocks.push({
      id: { site, seq },
      lamport: blockLamport,
      origin,
      text,
      deleted: (flags & B_DELETED) !== 0,
    });
  }

  return { lamport, version, blocks };
}
