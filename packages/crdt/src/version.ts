import type { OpId } from "./id.js";

/**
 * site -> number of ids that site has published (i.e. the next seq we expect).
 * Because seqs are gap-free this doubles as a causal delivery check.
 */
export type VersionVector = Map<number, number>;

export function emptyVersion(): VersionVector {
  return new Map();
}

export function nextSeq(vv: VersionVector, site: number): number {
  return vv.get(site) ?? 0;
}

/** Have we already integrated the op that created this id? */
export function seen(vv: VersionVector, ref: OpId): boolean {
  return nextSeq(vv, ref.site) > ref.seq;
}

export function observe(vv: VersionVector, site: number, seq: number, count = 1): void {
  const end = seq + count;
  if (end > nextSeq(vv, site)) vv.set(site, end);
}

export function cloneVersion(vv: VersionVector): VersionVector {
  return new Map(vv);
}

export function mergeVersion(into: VersionVector, other: VersionVector): void {
  for (const [site, seq] of other) {
    if (seq > nextSeq(into, site)) into.set(site, seq);
  }
}

/** True when `a` has seen everything `b` has seen. */
export function covers(a: VersionVector, b: VersionVector): boolean {
  for (const [site, seq] of b) {
    if (nextSeq(a, site) < seq) return false;
  }
  return true;
}
