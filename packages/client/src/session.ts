import {
  coalesce,
  Doc,
  newSiteId,
  type ChangeSource,
  type DocEvent,
  type Op,
} from "@collab/crdt";
import {
  decode,
  encode,
  type ClientMessage,
  type PeerPresence,
  type Presence,
  type ServerMessage,
} from "@collab/protocol";
import { Awareness, move } from "./awareness.js";
import { Backoff, type BackoffOptions } from "./backoff.js";

export type Status = "idle" | "connecting" | "online" | "offline" | "closed";

/** The slice of the WebSocket API we use, so tests can hand us a stub. */
export interface SocketLike {
  binaryType: string;
  readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface SessionOptions {
  url: string;
  doc: string;
  site?: number;
  name?: string;
  color?: string;
  /** Hold local ops this long before shipping them. 0 disables batching. */
  batchMs?: number;
  /** Cursor updates are chatty; don't send them more often than this. */
  presenceMs?: number;
  pingMs?: number;
  connect?: SocketFactory;
  backoff?: Partial<BackoffOptions>;
}

interface Events {
  status: (status: Status) => void;
  change: (events: DocEvent[], source: ChangeSource) => void;
  peers: (peers: PeerPresence[]) => void;
  error: (err: { code: string; detail: string }) => void;
}

const OPEN = 1;

export class DocSession {
  readonly site: number;
  readonly doc: Doc;
  readonly awareness = new Awareness();

  private url: string;
  private docId: string;
  private batchMs: number;
  private presenceMs: number;
  private pingMs: number;
  private open: SocketFactory;

  private socket: SocketLike | null = null;
  private state: Status = "idle";
  private outbox: Op[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retry: Backoff;

  private me: Presence;
  private presenceDirty = false;
  private roundTrip = 0;
  private handlers: { [K in keyof Events]: Events[K][] } = {
    status: [],
    change: [],
    peers: [],
    error: [],
  };

  constructor(options: SessionOptions) {
    this.url = options.url;
    this.docId = options.doc;
    this.site = options.site ?? newSiteId();
    this.batchMs = options.batchMs ?? 16;
    this.presenceMs = options.presenceMs ?? 80;
    this.pingMs = options.pingMs ?? 10_000;
    this.open = options.connect ?? defaultFactory;
    this.retry = new Backoff(options.backoff);

    this.me = {
      name: options.name ?? "anonymous",
      color: options.color ?? "#6c8cff",
      anchor: 0,
      head: 0,
    };

    this.doc = new Doc(this.site);
    this.doc.onChange((events, source) => {
      // Everyone's carets move when text lands to the left of them, whoever
      // typed it. Our own only needs fixing up for other people's edits.
      this.awareness.shift(events);
      if (source === "remote") this.shiftSelf(events);
      this.emit("change", events, source);
    });

    this.awareness.onChange((peers) => this.emit("peers", peers));
  }

  get status(): Status {
    return this.state;
  }

  get text(): string {
    return this.doc.text;
  }

  /** Last measured round trip to the server, in ms. */
  get rtt(): number {
    return this.roundTrip;
  }

  get selection(): { anchor: number; head: number } {
    return { anchor: this.me.anchor, head: this.me.head };
  }

  on<K extends keyof Events>(event: K, fn: Events[K]): () => void {
    this.handlers[event].push(fn);
    return () => {
      const list = this.handlers[event] as unknown[];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  connect(): void {
    if (this.state === "closed") throw new Error("session is closed");
    if (this.socket !== null || this.state === "connecting") return;

    this.setStatus("connecting");
    const socket = this.open(this.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onopen = () => {
      this.send({
        type: "hello",
        doc: this.docId,
        site: this.site,
        version: this.doc.version(),
      });
    };
    socket.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = decode(asBytes(ev.data)) as ServerMessage;
      } catch (err) {
        this.emit("error", { code: "bad_frame", detail: String(err) });
        return;
      }
      this.handle(msg);
    };
    socket.onclose = () => this.dropped();
    socket.onerror = () => {
      // onclose always follows, so there is nothing to do but surface it.
      this.emit("error", { code: "socket", detail: "connection error" });
    };
  }

  close(): void {
    this.setStatus("closed");
    this.clearTimers();
    if (this.socket !== null) {
      const socket = this.socket;
      this.socket = null;
      socket.onclose = null;
      socket.close(1000, "bye");
    }
  }

  insert(index: number, text: string): void {
    this.queue(this.doc.insert(index, text));
  }

  remove(index: number, count: number): void {
    this.queue(this.doc.delete(index, count));
  }

  setSelection(anchor: number, head: number = anchor): void {
    if (this.me.anchor === anchor && this.me.head === head) return;
    this.me = { ...this.me, anchor, head };
    this.schedulePresence();
  }

  peers(): PeerPresence[] {
    return this.awareness.all();
  }

  /** Ship anything we're holding right now instead of waiting for the timer. */
  flush(): void {
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.outbox.length === 0 || this.state !== "online") return;
    const ops = coalesce(this.outbox);
    this.outbox = [];
    this.send({ type: "ops", ops });
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome": {
        if (msg.snapshot !== null) this.doc.absorb(msg.snapshot);
        else this.doc.apply(msg.ops);

        this.awareness.reset(msg.peers);
        this.setStatus("online");
        this.retry.reset();

        // Whatever the server hasn't seen from us - including anything typed
        // while we were offline - goes out now. The outbox is a subset of it.
        this.outbox = [];
        const catchUp = this.doc.opsSince(msg.version);
        if (catchUp.length > 0) this.send({ type: "ops", ops: catchUp });

        this.presenceDirty = true;
        this.sendPresence();
        this.startPings();
        break;
      }

      case "ops":
        this.doc.apply(msg.ops);
        break;

      case "presence":
        this.awareness.set(msg.site, msg.state);
        break;

      case "pong":
        this.roundTrip = Date.now() - msg.at;
        break;

      case "reject":
        this.emit("error", { code: msg.code, detail: msg.detail });
        // A stale connection of ours may still be holding the site id; the
        // server reaps it on the next heartbeat, so this one is worth retrying.
        if (msg.code !== "site_taken") this.setStatus("closed");
        break;
    }
  }

  private dropped(): void {
    this.socket = null;
    if (this.state === "closed") return;

    this.clearTimers();
    this.setStatus("offline");
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retry.next());
  }

  private queue(ops: Op[]): void {
    if (ops.length === 0) return;
    for (const op of ops) this.outbox.push(op);

    if (this.batchMs <= 0) {
      this.flush();
      return;
    }
    if (this.batchTimer !== null) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.flush();
    }, this.batchMs);
  }

  private schedulePresence(): void {
    this.presenceDirty = true;
    if (this.presenceTimer !== null) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.sendPresence();
    }, this.presenceMs);
  }

  private sendPresence(): void {
    if (!this.presenceDirty || this.state !== "online") return;
    this.presenceDirty = false;
    this.send({ type: "presence", site: this.site, state: this.me });
  }

  private shiftSelf(events: DocEvent[]): void {
    let { anchor, head } = this.me;
    for (const event of events) {
      anchor = move(anchor, event);
      head = move(head, event);
    }
    if (anchor !== this.me.anchor || head !== this.me.head) {
      this.me = { ...this.me, anchor, head };
      this.schedulePresence();
    }
  }

  private startPings(): void {
    if (this.pingTimer !== null || this.pingMs <= 0) return;
    this.pingTimer = setInterval(() => {
      this.send({ type: "ping", at: Date.now() });
    }, this.pingMs);
    (this.pingTimer as { unref?: () => void }).unref?.();
  }

  private send(msg: ClientMessage): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== OPEN) return;
    socket.send(encode(msg));
  }

  private clearTimers(): void {
    for (const timer of [this.batchTimer, this.presenceTimer, this.retryTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.batchTimer = null;
    this.presenceTimer = null;
    this.retryTimer = null;
    this.pingTimer = null;
  }

  private setStatus(status: Status): void {
    if (this.state === status) return;
    this.state = status;
    this.emit("status", status);
  }

  private emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    for (const fn of this.handlers[event]) (fn as (...a: unknown[]) => void)(...args);
  }
}

function defaultFactory(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

function asBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError("expected a binary frame");
}
