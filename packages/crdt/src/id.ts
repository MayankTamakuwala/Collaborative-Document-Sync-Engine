/**
 * Every character in a document gets a unique, immutable id. `site` is the
 * random id a client picks when it opens the document, `seq` is a per-site
 * counter that increments by one for every id that site hands out.
 *
 * Keeping `seq` gap-free is what lets us track "what have I seen from you"
 * with a single integer per site instead of a set of ids.
 */
export interface OpId {
  site: number;
  seq: number;
}

export function id(site: number, seq: number): OpId {
  return { site, seq };
}

export function sameId(a: OpId | null, b: OpId | null): boolean {
  if (a === null || b === null) return a === b;
  return a.site === b.site && a.seq === b.seq;
}

/** Stable string form, only used as a Map key. */
export function idKey(v: OpId): string {
  return v.site + ":" + v.seq;
}

export function newSiteId(): number {
  // 2^31 keyspace. Collisions are possible in theory; in practice a document
  // has a handful of concurrent editors and the birthday odds are negligible.
  return Math.floor(Math.random() * 0x7fffffff);
}
