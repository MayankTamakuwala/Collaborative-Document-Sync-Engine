import type { DocEvent } from "@collab/crdt";
import type { PeerPresence, Presence } from "@collab/protocol";

/**
 * Where everyone else's caret is. Offsets are in visible characters, so they
 * have to be nudged whenever text lands to the left of them - otherwise remote
 * carets drift every time somebody types above you.
 */
export class Awareness {
  private peers = new Map<number, Presence>();
  private listeners: Array<(peers: PeerPresence[]) => void> = [];

  set(site: number, state: Presence | null): void {
    if (state === null) this.peers.delete(site);
    else this.peers.set(site, state);
    this.notify();
  }

  reset(peers: PeerPresence[]): void {
    this.peers.clear();
    for (const peer of peers) this.peers.set(peer.site, peer.state);
    this.notify();
  }

  all(): PeerPresence[] {
    return [...this.peers].map(([site, state]) => ({ site, state }));
  }

  onChange(fn: (peers: PeerPresence[]) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  shift(events: DocEvent[]): void {
    if (events.length === 0 || this.peers.size === 0) return;

    for (const [site, state] of this.peers) {
      let { anchor, head } = state;
      for (const event of events) {
        anchor = move(anchor, event);
        head = move(head, event);
      }
      if (anchor !== state.anchor || head !== state.head) {
        this.peers.set(site, { ...state, anchor, head });
      }
    }
    this.notify();
  }

  private notify(): void {
    const snapshot = this.all();
    for (const fn of this.listeners) fn(snapshot);
  }
}

export function move(pos: number, event: DocEvent): number {
  if (event.type === "insert") {
    return pos > event.index ? pos + event.text.length : pos;
  }
  if (pos <= event.index) return pos;
  return pos >= event.index + event.len ? pos - event.len : event.index;
}
