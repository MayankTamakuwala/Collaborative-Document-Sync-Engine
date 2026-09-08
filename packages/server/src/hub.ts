import { Room } from "./room.js";
import type { Store } from "./store.js";

export interface HubOptions {
  /** How often to write out rooms that have taken edits since the last save. */
  flushEveryMs: number;
  /** How many ops a room keeps around to serve reconnect deltas from. */
  historyOps: number;
  /** How long an empty room stays warm before we drop it from memory. */
  evictAfterMs: number;
}

const DEFAULTS: HubOptions = {
  flushEveryMs: 5_000,
  historyOps: 5_000,
  evictAfterMs: 60_000,
};

interface Entry {
  room: Room;
  emptySince: number | null;
}

/** Owns the live rooms and decides when their state hits disk. */
export class Hub {
  private rooms = new Map<string, Entry>();
  private loading = new Map<string, Promise<Room>>();
  private options: HubOptions;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly store: Store, options: Partial<HubOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.flushEveryMs);
    this.timer.unref?.();
  }

  async room(id: string): Promise<Room> {
    const existing = this.rooms.get(id);
    if (existing !== undefined) {
      existing.emptySince = null;
      return existing.room;
    }

    // Two clients can race to open the same cold document; make them share
    // one load instead of building two rooms from the same snapshot.
    const inFlight = this.loading.get(id);
    if (inFlight !== undefined) return inFlight;

    const pending = this.store.load(id).then((snapshot) => {
      const room = new Room(id, snapshot);
      this.rooms.set(id, { room, emptySince: null });
      this.loading.delete(id);
      return room;
    });
    this.loading.set(id, pending);
    return pending;
  }

  released(id: string): void {
    const entry = this.rooms.get(id);
    if (entry !== undefined && entry.room.size === 0) entry.emptySince = Date.now();
  }

  async flush(id: string): Promise<void> {
    const entry = this.rooms.get(id);
    if (entry === undefined || entry.room.pendingWrites === 0) return;

    await this.store.save(id, entry.room.snapshot());
    entry.room.markSaved();
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.rooms.keys()].map((id) => this.flush(id)));
  }

  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.flushAll();
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const [id, entry] of [...this.rooms]) {
      if (entry.room.pendingWrites > 0) await this.flush(id);
      entry.room.trimLog(this.options.historyOps);
      if (
        entry.room.size === 0 &&
        entry.emptySince !== null &&
        now - entry.emptySince > this.options.evictAfterMs
      ) {
        this.rooms.delete(id);
      }
    }
  }
}
