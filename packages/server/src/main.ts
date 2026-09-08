import { createServer } from "node:http";
import { attachGateway } from "./gateway.js";
import { Hub } from "./hub.js";
import { serveStatic } from "./static.js";
import { FileStore } from "./store.js";

interface Args {
  port: number;
  host: string;
  data: string;
  static: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: Number(process.env.PORT ?? 8080),
    host: process.env.HOST ?? "127.0.0.1",
    data: process.env.DATA_DIR ?? ".data",
    static: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case "--port":
        args.port = Number(value);
        i++;
        break;
      case "--host":
        args.host = value;
        i++;
        break;
      case "--data":
        args.data = value;
        i++;
        break;
      case "--static":
        args.static = value;
        i++;
        break;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const hub = new Hub(new FileStore(args.data));
hub.start();

const files = args.static !== null ? serveStatic(args.static) : null;
const http = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    return;
  }
  if (files !== null) {
    void files(req, res);
    return;
  }
  res.writeHead(404).end("not found");
});

const stopGateway = attachGateway({ server: http, hub });

http.listen(args.port, args.host, () => {
  console.log(`collab server on ws://${args.host}:${args.port} (docs in ${args.data})`);
  if (args.static !== null) console.log(`serving ${args.static}`);
});

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) process.exit(1);
    closing = true;
    console.log("\nflushing documents...");
    void (async () => {
      await stopGateway();
      await hub.close();
      http.close(() => process.exit(0));
    })();
  });
}
