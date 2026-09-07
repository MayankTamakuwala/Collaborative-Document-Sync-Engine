import { id, sameId, type OpId } from "./id.js";
import type { DeleteOp, DocEvent, InsertOp } from "./ops.js";

/**
 * A run of characters that were typed consecutively by one site and have not
 * been split apart since. Storing runs instead of one node per character is
 * what keeps a 50k-character document in the low thousands of objects.
 *
 * Invariants:
 *   - character i has id { site, seq + i } and lamport `lamport + i`
 *   - a block is either entirely alive or entirely tombstoned; we split on
 *     delete rather than tracking per-character flags
 */
export interface Block {
  id: OpId;
  lamport: number;
  origin: OpId | null;
  text: string;
  deleted: boolean;
  prev: Block | null;
  next: Block | null;
}

export interface Cursor {
  block: Block;
  offset: number;
}

/** Total order over characters: lamport first, site as the tiebreak. */
function after(aLamport: number, aSite: number, bLamport: number, bSite: number): boolean {
  if (aLamport !== bLamport) return aLamport > bLamport;
  return aSite > bSite;
}

function lowerBound(blocks: Block[], seq: number): number {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].id.seq < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Replicated Growable Array over character runs.
 *
 * Insertion is anchored to the id of the character on its left. When two sites
 * insert after the same anchor the one with the higher lamport stamp wins the
 * position closer to the anchor, which every replica computes identically, so
 * the lists converge without any coordination.
 */
export class Rga {
  first: Block | null = null;
  last: Block | null = null;

  /** Per-site blocks sorted by starting seq, so we can find an id in log time. */
  private bySite = new Map<number, Block[]>();
  private visible = 0;
  private cached: string | null = "";

  get length(): number {
    return this.visible;
  }

  text(): string {
    if (this.cached !== null) return this.cached;
    let out = "";
    for (let b = this.first; b !== null; b = b.next) {
      if (!b.deleted) out += b.text;
    }
    this.cached = out;
    return out;
  }

  *blocks(): IterableIterator<Block> {
    for (let b = this.first; b !== null; b = b.next) yield b;
  }

  /** Which block holds `ref`, and at what offset. */
  locate(ref: OpId): Cursor | null {
    const arr = this.bySite.get(ref.site);
    if (arr === undefined) return null;

    let i = lowerBound(arr, ref.seq);
    if (i < arr.length && arr[i].id.seq === ref.seq) return { block: arr[i], offset: 0 };
    i -= 1;
    if (i < 0) return null;

    const block = arr[i];
    const offset = ref.seq - block.id.seq;
    return offset < block.text.length ? { block, offset } : null;
  }

  /** Id of the character sitting at visible position `index`. */
  idAt(index: number): OpId | null {
    if (index < 0) return null;
    let left = index;
    for (let b = this.first; b !== null; b = b.next) {
      if (b.deleted) continue;
      if (left < b.text.length) return id(b.id.site, b.id.seq + left);
      left -= b.text.length;
    }
    return null;
  }

  /**
   * Walk a visible range and report it as id runs. A single user-level delete
   * can straddle several blocks, and those blocks are not necessarily
   * contiguous in id space, so this can return more than one run.
   */
  runsIn(index: number, count: number): Array<{ target: OpId; len: number }> {
    const runs: Array<{ target: OpId; len: number }> = [];
    let skip = index;
    let left = count;

    for (let b = this.first; b !== null && left > 0; b = b.next) {
      if (b.deleted) continue;
      if (skip >= b.text.length) {
        skip -= b.text.length;
        continue;
      }
      const take = Math.min(b.text.length - skip, left);
      const target = id(b.id.site, b.id.seq + skip);
      const prev = runs[runs.length - 1];
      if (prev !== undefined && prev.target.site === target.site && prev.target.seq + prev.len === target.seq) {
        prev.len += take;
      } else {
        runs.push({ target, len: take });
      }
      left -= take;
      skip = 0;
    }
    return runs;
  }

  integrateInsert(op: InsertOp, out?: DocEvent[]): void {
    let left: Block | null = null;

    if (op.origin !== null) {
      const at = this.locate(op.origin);
      if (at === null) throw new Error("insert anchored to an unknown character");
      left = at.block;
      // The anchor has to be the last character of its block so we can splice
      // in right behind it.
      if (at.offset < left.text.length - 1) this.split(left, at.offset + 1);
    }

    let scan = left !== null ? left.next : this.first;
    while (scan !== null && after(scan.lamport, scan.id.site, op.lamport, op.id.site)) {
      scan = scan.next;
    }

    const block: Block = {
      id: op.id,
      lamport: op.lamport,
      origin: op.origin,
      text: op.text,
      deleted: false,
      prev: scan !== null ? scan.prev : this.last,
      next: scan,
    };

    if (block.prev !== null) block.prev.next = block;
    else this.first = block;
    if (scan !== null) scan.prev = block;
    else this.last = block;

    this.register(block);
    if (out !== undefined) out.push({ type: "insert", index: this.indexOf(block), text: op.text });
    this.visible += op.text.length;
    this.cached = null;

    const kept = this.mergeLeft(block) ? block.prev! : block;
    if (kept.next !== null) this.mergeLeft(kept.next);
  }

  integrateDelete(op: DeleteOp, out?: DocEvent[]): void {
    let seq = op.target.seq;
    let left = op.len;

    while (left > 0) {
      const at = this.locate(id(op.target.site, seq));
      if (at === null) throw new Error("delete of an unknown character");

      let block = at.block;
      if (at.offset > 0) block = this.split(block, at.offset);
      const take = Math.min(block.text.length, left);
      if (take < block.text.length) this.split(block, take);

      if (!block.deleted) {
        if (out !== undefined) out.push({ type: "delete", index: this.indexOf(block), len: block.text.length });
        block.deleted = true;
        this.visible -= block.text.length;
      }
      left -= take;
      seq += take;

      this.mergeLeft(block);
    }
    this.cached = null;
  }

  /** Rebuild a document from an ordered block list (see doc snapshots). */
  static fromBlocks(blocks: Array<Omit<Block, "prev" | "next">>): Rga {
    const rga = new Rga();
    for (const raw of blocks) {
      const block: Block = { ...raw, prev: rga.last, next: null };
      if (rga.last !== null) rga.last.next = block;
      else rga.first = block;
      rga.last = block;
      rga.register(block);
      if (!block.deleted) rga.visible += block.text.length;
    }
    rga.cached = null;
    return rga;
  }

  /** Visible offset of a block. Linear, so only called when events are wanted. */
  private indexOf(target: Block): number {
    let n = 0;
    for (let b = this.first; b !== null && b !== target; b = b.next) {
      if (!b.deleted) n += b.text.length;
    }
    return n;
  }

  private split(block: Block, offset: number): Block {
    const right: Block = {
      id: id(block.id.site, block.id.seq + offset),
      lamport: block.lamport + offset,
      origin: id(block.id.site, block.id.seq + offset - 1),
      text: block.text.slice(offset),
      deleted: block.deleted,
      prev: block,
      next: block.next,
    };

    block.text = block.text.slice(0, offset);
    if (block.next !== null) block.next.prev = right;
    else this.last = right;
    block.next = right;

    this.register(right);
    return right;
  }

  /** Fold `block` back into its left neighbour when they are one original run. */
  private mergeLeft(block: Block): boolean {
    const prev = block.prev;
    if (prev === null) return false;
    if (prev.id.site !== block.id.site) return false;
    if (prev.deleted !== block.deleted) return false;
    if (prev.id.seq + prev.text.length !== block.id.seq) return false;
    if (prev.lamport + prev.text.length !== block.lamport) return false;
    if (!sameId(block.origin, id(prev.id.site, prev.id.seq + prev.text.length - 1))) return false;

    this.unregister(block);
    prev.text += block.text;
    prev.next = block.next;
    if (block.next !== null) block.next.prev = prev;
    else this.last = prev;
    return true;
  }

  private register(block: Block): void {
    let arr = this.bySite.get(block.id.site);
    if (arr === undefined) {
      arr = [];
      this.bySite.set(block.id.site, arr);
    }
    arr.splice(lowerBound(arr, block.id.seq), 0, block);
  }

  private unregister(block: Block): void {
    const arr = this.bySite.get(block.id.site);
    if (arr === undefined) return;
    const at = lowerBound(arr, block.id.seq);
    if (arr[at] === block) arr.splice(at, 1);
  }
}
