import { emptyVersion } from "@collab/crdt";
import { decode, encode, type ClientMessage } from "@collab/protocol";
import type { Hub } from "./hub.js";
import type { Connection } from "./room.js";

/**
 * One connected client, with no opinion about how the bytes got here. The
 * WebSocket gateway feeds it frames; the tests feed it the same frames over an
 * in-memory pipe.
 */
export class ClientSession {
  private doc: string | null = null;
  private site: number | null = null;
  private closed = false;

  constructor(
    private readonly hub: Hub,
    private readonly conn: Connection,
  ) {}

  get joined(): boolean {
    return this.doc !== null;
  }

  async receive(frame: Uint8Array): Promise<void> {
    if (this.closed) return;

    let msg: ClientMessage;
    try {
      msg = decode(frame) as ClientMessage;
    } catch {
      this.fail("bad_frame", "could not decode");
      return;
    }

    if (this.doc === null) {
      if (msg.type !== "hello") {
        this.fail("expected_hello", "first frame must be a hello");
        return;
      }

      const room = await this.hub.room(msg.doc);
      if (this.closed) return;

      const joined = room.join(msg.site, this.conn, msg.version ?? emptyVersion());
      if (!joined.ok) {
        this.fail(joined.code!, joined.detail!);
        return;
      }
      this.doc = msg.doc;
      this.site = msg.site;
      return;
    }

    const room = await this.hub.room(this.doc);
    if (this.closed) return;
    room.receive(this.site!, msg);
  }

  async detach(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.doc === null || this.site === null) return;

    const room = await this.hub.room(this.doc);
    room.leave(this.site);
    this.hub.released(this.doc);
  }

  private fail(code: string, detail: string): void {
    this.closed = true;
    this.conn.send(encode({ type: "reject", code, detail }));
    this.conn.close(4001, code);
  }
}
