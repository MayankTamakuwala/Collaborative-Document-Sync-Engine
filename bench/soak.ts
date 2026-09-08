import { createServer } from "node:http";
import { DocSession } from "@collab/client";
import { attachGateway, Hub, MemoryStore } from "@collab/server";
import { Histogram } from "./timeline.js";

/*
 * The other benchmark models the network. This one doesn't model anything: it
 * starts the real server, opens real WebSockets, types for a while and then
 * checks that every replica agrees. Over loopback the numbers are a floor on
 * what the pipeline itself costs, not a WAN prediction.
 */

const CLIENTS = Number(process.env.CLIENTS ?? 12);
const SECONDS = Number(process.env.SECONDS ?? 10);
const CHARS_PER_SECOND = Number(process.env.CPS ?? 6);
const PORT = Number(process.env.PORT ?? 8123);

const ALPHABET = "abcdefghijklmnopqrstuvwxyz      \n";

async function main(): Promise<void> {
  const hub = new Hub(new MemoryStore());
  const http = createServer((_req, res) => res.writeHead(404).end());
  const stopGateway = attachGateway({ server: http, hub });
  await new Promise<void>((resolve) => http.listen(PORT, "127.0.0.1", resolve));

  const latency = new Histogram();
  const sent = new Map<string, number>();
  const sessions: DocSession[] = [];

  for (let i = 0; i < CLIENTS; i++) {
    const session = new DocSession({
      url: `ws://127.0.0.1:${PORT}`,
      doc: "soak",
      name: `client-${i}`,
      pingMs: 2000,
    });

    // Everything the version vector newly covers is an op that just landed,
    // and we stamped each one when it was typed.
    const seen = new Map<number, number>();
    session.on("change", (_events, source) => {
      if (source !== "remote") return;
      const now = performance.now();
      for (const [site, upto] of session.doc.version()) {
        if (site === session.site) continue;
        const from = seen.get(site) ?? 0;
        for (let seq = from; seq < upto; seq++) {
          const at = sent.get(`${site}:${seq}`);
          if (at !== undefined) latency.add(now - at);
        }
        seen.set(site, upto);
      }
    });

    session.connect();
    sessions.push(session);
  }

  await waitFor(() => sessions.every((s) => s.status === "online"), 5000);
  console.log(`${CLIENTS} clients online, typing for ${SECONDS}s at ~${CHARS_PER_SECOND} chars/s each\n`);

  const started = performance.now();
  let typed = 0;

  const typers = sessions.map((session) =>
    setInterval(() => {
      const seq = nextSeqOf(session);
      const at = Math.floor(Math.random() * (session.doc.length + 1));
      session.insert(at, ALPHABET[Math.floor(Math.random() * ALPHABET.length)]);
      sent.set(`${session.site}:${seq}`, performance.now());
      typed += 1;
    }, 1000 / CHARS_PER_SECOND),
  );

  await sleep(SECONDS * 1000);
  for (const timer of typers) clearInterval(timer);

  // Let the last batches drain before comparing.
  for (const session of sessions) session.flush();
  await waitFor(() => sessions.every((s) => s.text === sessions[0].text), 5000);

  const elapsed = (performance.now() - started) / 1000;
  const agreed = sessions.every((s) => s.text === sessions[0].text);

  console.log(`characters typed      ${typed}  (${(typed / elapsed).toFixed(0)}/s across the room)`);
  console.log(`document length       ${sessions[0].text.length}`);
  console.log(`replicas agree        ${agreed ? "yes" : "NO"}`);
  console.log(`ops observed at peers ${latency.samples}`);
  console.log(
    `loopback latency      p50 ${latency.quantile(0.5).toFixed(1)}ms   ` +
      `p95 ${latency.quantile(0.95).toFixed(1)}ms   p99 ${latency.quantile(0.99).toFixed(1)}ms`,
  );

  for (const session of sessions) session.close();
  await stopGateway();
  await hub.close();
  http.close();

  if (!agreed) process.exitCode = 1;
}

function nextSeqOf(session: DocSession): number {
  return session.doc.version().get(session.site) ?? 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(done: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the room to settle");
    await sleep(20);
  }
}

await main();
