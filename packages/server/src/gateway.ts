import type { IncomingMessage, Server as HttpServer } from "node:http";
import { encode } from "@collab/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import type { Hub } from "./hub.js";
import type { Connection } from "./room.js";
import { ClientSession } from "./session.js";

export interface GatewayOptions {
  server: HttpServer;
  hub: Hub;
  /** Drop a socket that hasn't answered a ping in this long. */
  heartbeatMs?: number;
  /** Refuse frames larger than this; an op batch has no business being big. */
  maxFrameBytes?: number;
  /** Close a socket we can't drain rather than buffering for it forever. */
  maxBufferedBytes?: number;
}

interface Peer {
  socket: WebSocket;
  session: ClientSession;
  alive: boolean;
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
  const peers = new Set<Peer>();

  wss.on("connection", (socket: WebSocket, _req: IncomingMessage) => {
    const conn: Connection = {
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
    };

    const peer: Peer = { socket, session: new ClientSession(hub, conn), alive: true };
    peers.add(peer);

    socket.on("pong", () => {
      peer.alive = true;
    });

    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        conn.send(encode({ type: "reject", code: "bad_frame", detail: "expected binary" }));
        socket.close(4001, "bad_frame");
        return;
      }
      void peer.session.receive(toBytes(data));
    });

    socket.on("close", () => {
      peers.delete(peer);
      void peer.session.detach();
    });

    socket.on("error", () => socket.terminate());
  });

  const heartbeat = setInterval(() => {
    for (const peer of peers) {
      if (!peer.alive) {
        peer.socket.terminate();
        continue;
      }
      peer.alive = false;
      peer.socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return async () => {
    clearInterval(heartbeat);
    for (const peer of peers) peer.socket.close(1001, "server shutting down");
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data as Buffer[]));
  return new Uint8Array(data as Buffer);
}
