import { ClientSession, Hub, MemoryStore, type Connection } from "@collab/server";
import type { SocketLike } from "../src/session.js";

/**
 * An in-memory stand-in for the network. Frames are queued rather than handed
 * straight over, so a test decides when they land; `settle()` runs the queue
 * until everything has been delivered.
 */
export class TestNet {
  readonly hub: Hub;
  toServer = 0;
  toClient = 0;

  private queue: Array<() => void | Promise<void>> = [];
  private links = new Set<Link>();

  constructor(hub?: Hub) {
    this.hub = hub ?? new Hub(new MemoryStore());
  }

  connect = (): SocketLike => {
    const link = new Link(this);
    this.links.add(link);
    this.push(() => link.opened());
    return link;
  };

  push(task: () => void | Promise<void>): void {
    this.queue.push(task);
  }

  /** Yank the connection out from under every client, as a server crash would. */
  cutAll(): void {
    for (const link of this.links) link.cut();
    this.links.clear();
  }

  async settle(rounds = 60): Promise<void> {
    for (let i = 0; i < rounds && this.queue.length > 0; i++) {
      const batch = this.queue;
      this.queue = [];
      for (const task of batch) await task();
    }
  }
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/** The client end of a socket. The server end is the Connection it builds. */
class Link implements SocketLike {
  binaryType = "arraybuffer";
  readyState = CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  private session: ClientSession;

  constructor(private readonly net: TestNet) {
    const conn: Connection = {
      send: (frame) => this.deliver(frame),
      close: () => this.cut(),
    };
    this.session = new ClientSession(net.hub, conn);
  }

  opened(): void {
    if (this.readyState !== CONNECTING) return;
    this.readyState = OPEN;
    this.onopen?.(null);
  }

  send(data: Uint8Array): void {
    if (this.readyState !== OPEN) return;
    const frame = data.slice();
    this.net.toServer += 1;
    this.net.push(() => this.session.receive(frame));
  }

  close(code = 1000, reason = ""): void {
    this.shutdown(code, reason);
  }

  cut(): void {
    this.shutdown(1006, "connection lost");
  }

  private deliver(frame: Uint8Array): void {
    if (this.readyState !== OPEN) return;
    const copy = frame.slice();
    this.net.toClient += 1;
    this.net.push(() => this.onmessage?.({ data: copy }));
  }

  private shutdown(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.net.push(async () => {
      await this.session.detach();
      this.onclose?.({ code, reason });
    });
  }
}
