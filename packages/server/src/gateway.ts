import type { IncomingMessage, Server as HttpServer } from "node:http";
import { emptyVersion } from "@collab/crdt";
import { decode, encode, type ClientMessage } from "@collab/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import type { Hub } from "./hub.js";
import type { Connection } from "./room.js";

export interface GatewayOptions {
  server: HttpServer;
  hub: Hub;
  /** Drop a socket that hasn't answered a ping in this long. */
  heartbeatMs?: number;
  /** Refuse frames larger than this; a text op batch has no business being big. */
  maxFrameBytes?: number;
  /** Close a socket we can't drain, rather than buffering forever. */
  maxBufferedBytes?: number;
}

interface Session {
  socket: WebSocket;
  conn: Connection;
  alive: boolean;
  doc: string | null;
  site: number | null;
}

export function attachGateway(options: GatewayOptions): () => Promise<void> {
  const {
    server,
    hub,
    heartbeatMs = 30_000,
    maxFrameBytes = 1 << 20,
    maxBufferedBytes = 8 << 20,
  } = options;

  const wss = new WebSocketServer({ server, maxPayload: maxFrameBytes });
  const sessions = new Set<Session>();

  wss.on("connection", (socket: WebSocket, _req: IncomingMessage) => {
    const session: Session = {
      socket,
      alive: true,
      doc: null,
      site: null,
      conn: {
        send(frame) {
          if (socket.readyState !== socket.OPEN) return;
          if (socket.bufferedAmount > maxBufferedBytes) {
            socket.close(1013, "too slow");
            return;
          }
          socket.send(frame);
        },
        close(code, reason) {
          socket.close(code, reason);
        },
      },
    };
    sessions.add(session);

    socket.on("pong", () => {
      session.alive = true;
    });

    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        session.conn.send(encode({ type: "reject", code: "bad_frame", detail: "expected binary" }));
        socket.close(4001, "bad_frame");
        return;
      }

      let msg: ClientMessage;
      try {
        msg = decode(toBytes(data)) as ClientMessage;
      } catch {
        session.conn.send(encode({ type: "reject", code: "bad_frame", detail: "undecodable" }));
        socket.close(4001, "bad_frame");
        return;
      }

      void handle(session, msg);
    });

    socket.on("close", () => {
      sessions.delete(session);
      void detach(session);
    });

    socket.on("error", () => {
      socket.terminate();
    });
  });

  async function handle(session: Session, msg: ClientMessage): Promise<void> {
    if (session.doc === null) {
      if (msg.type !== "hello") {
        session.conn.send(encode({ type: "reject", code: "expected_hello", detail: "say hello first" }));
        session.socket.close(4002, "expected_hello");
        return;
      }

      const room = await hub.room(msg.doc);
      if (session.socket.readyState !== session.socket.OPEN) return;

      const joined = room.join(msg.site, session.conn, msg.version ?? emptyVersion());
      if (!joined.ok) {
        session.conn.send(encode({ type: "reject", code: joined.code!, detail: joined.detail! }));
        session.socket.close(4003, joined.code);
        return;
      }
      session.doc = msg.doc;
      session.site = msg.site;
      return;
    }

    const room = await hub.room(session.doc);
    room.receive(session.site!, msg);
  }

  async function detach(session: Session): Promise<void> {
    if (session.doc === null || session.site === null) return;
    const room = await hub.room(session.doc);
    room.leave(session.site);
    hub.released(session.doc);
  }

  const heartbeat = setInterval(() => {
    for (const session of sessions) {
      if (!session.alive) {
        session.socket.terminate();
        continue;
      }
      session.alive = false;
      session.socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return async () => {
    clearInterval(heartbeat);
    for (const session of sessions) session.socket.close(1001, "server shutting down");
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data as Buffer[]));
  return new Uint8Array(data as Buffer);
}
