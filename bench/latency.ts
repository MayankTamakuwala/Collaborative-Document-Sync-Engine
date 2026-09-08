import { calibrate, cost, type Costs } from "./costs.js";
import { Histogram, Timeline } from "./timeline.js";

/*
 * What this measures: the time between a keystroke happening on one client and
 * that character being present in another client's replica.
 *
 * It is a simulation, but not a made up one - every CPU cost and every frame
 * size below is measured from the real encoders and the real CRDT first (see
 * costs.ts), and only the network is modelled. That keeps the run
 * reproducible while still being answerable for the numbers it prints.
 */

interface Scenario {
  rooms: number;
  peers: number;
  seconds: number;
  warmupSeconds: number;
  oneWayMs: number;
  jitterMs: number;
  serverMbps: number;
  uplinkMbps: number;
  seed: number;
}

interface Arm {
  name: string;
  /** Client may only have one op outstanding; the next one waits for the ack. */
  ackGated: boolean;
  /** Otherwise, the shortest gap allowed between two sends. */
  minGapMs: number;
  binary: boolean;
  /** Encode the broadcast once and reuse the buffer for every recipient. */
  shareBroadcast: boolean;
}

const ARMS: Arm[] = [
  {
    name: "server-ordered, json",
    ackGated: true,
    minGapMs: 0,
    binary: false,
    shareBroadcast: false,
  },
  {
    name: "crdt stream, json",
    ackGated: false,
    minGapMs: 16,
    binary: false,
    shareBroadcast: false,
  },
  {
    name: "crdt stream, binary",
    ackGated: false,
    minGapMs: 16,
    binary: true,
    shareBroadcast: true,
  },
];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * People type in bursts: a word at speed, a pause, another word, and every so
 * often a real stop to think. A flat inter-arrival rate would hide exactly the
 * bursts that make an ack-gated client stall.
 */
function keystrokeTimes(rand: () => number, untilMs: number): number[] {
  const times: number[] = [];
  let t = rand() * 800;

  while (t < untilMs) {
    const word = 3 + Math.floor(rand() * 7);
    for (let i = 0; i < word && t < untilMs; i++) {
      times.push(t);
      t += 48 + rand() * 34;
    }
    t += rand() < 0.08 ? 900 + rand() * 2200 : 170 + rand() * 360;
  }
  return times;
}

interface Client {
  room: number;
  outbox: number[];
  inFlight: boolean;
  lastSendAt: number;
  timerPending: boolean;
  cpuFree: number;
}

function simulate(scenario: Scenario, arm: Arm, costs: Costs) {
  const rand = rng(scenario.seed);
  const timeline = new Timeline();
  const latency = new Histogram();

  const total = scenario.rooms * scenario.peers;
  const clients: Client[] = [];
  for (let i = 0; i < total; i++) {
    clients.push({
      room: Math.floor(i / scenario.peers),
      outbox: [],
      inFlight: false,
      lastSendAt: -Infinity,
      timerPending: false,
      cpuFree: 0,
    });
  }

  const encode = arm.binary ? costs.binEncode : costs.jsonEncode;
  const decode = arm.binary ? costs.binDecode : costs.jsonDecode;
  const bytesFor = arm.binary ? costs.binBytes : costs.jsonBytes;

  const untilMs = scenario.seconds * 1000;
  const warmupMs = scenario.warmupSeconds * 1000;
  const peersPerRoom = scenario.peers - 1;
  const serverBytesPerMs = (scenario.serverMbps * 1e6) / 8 / 1000;
  const uplinkBytesPerMs = (scenario.uplinkMbps * 1e6) / 8 / 1000;

  let serverCpuFree = 0;
  let serverLinkFree = 0;
  let bytesSent = 0;
  let framesSent = 0;
  let serverBusyMs = 0;

  const hop = () => scenario.oneWayMs + rand() * scenario.jitterMs;

  function send(index: number, at: number): void {
    const client = clients[index];
    const stamps = client.outbox;
    if (stamps.length === 0) return;
    client.outbox = [];

    // Queued keystrokes leave as a single run op, whether that is CRDT
    // coalescing or an OT client composing its buffer.
    const ops = 1;
    const encodeMs = cost(encode, ops) / 1000;
    const start = Math.max(at, client.cpuFree);
    const done = start + encodeMs;
    client.cpuFree = done;
    client.lastSendAt = done;
    if (arm.ackGated) client.inFlight = true;

    const bytes = bytesFor(stamps.length);
    const departs = done + bytes / uplinkBytesPerMs;
    timeline.at(departs + hop(), () => serverReceive(index, stamps, bytes));
  }

  function serverReceive(index: number, stamps: number[], inBytes: number): void {
    const client = clients[index];
    const ops = 1;
    const fanOut = peersPerRoom;

    const encodes = arm.shareBroadcast ? 1 : fanOut;
    const work =
      cost(decode, ops) +
      cost(costs.apply, ops) +
      encodes * cost(encode, ops) +
      (arm.ackGated ? cost(encode, 0) : 0);

    const arrival = stamps[stamps.length - 1];
    const start = Math.max(arrival, serverCpuFree);
    const done = start + work / 1000;
    serverCpuFree = done;
    serverBusyMs += work / 1000;

    const outBytes = inBytes;
    const first = client.room * scenario.peers;

    for (let p = first; p < first + scenario.peers; p++) {
      if (p === index) continue;
      const linkStart = Math.max(done, serverLinkFree);
      serverLinkFree = linkStart + outBytes / serverBytesPerMs;
      bytesSent += outBytes;
      framesSent += 1;
      const lands = serverLinkFree + hop();
      timeline.at(lands, () => peerReceive(p, stamps, lands));
    }

    if (arm.ackGated) {
      const linkStart = Math.max(done, serverLinkFree);
      serverLinkFree = linkStart + 24 / serverBytesPerMs;
      bytesSent += 24;
      framesSent += 1;
      const lands = serverLinkFree + hop();
      timeline.at(lands, () => {
        client.inFlight = false;
        send(index, lands);
      });
    }
  }

  function peerReceive(index: number, stamps: number[], at: number): void {
    const peer = clients[index];
    const work = cost(decode, 1) + cost(costs.apply, 1);
    const start = Math.max(at, peer.cpuFree);
    const done = start + work / 1000;
    peer.cpuFree = done;

    for (const stamp of stamps) {
      if (stamp >= warmupMs) latency.add(done - stamp);
    }
  }

  for (let i = 0; i < total; i++) {
    for (const t of keystrokeTimes(rand, untilMs)) {
      timeline.at(t, () => {
        const client = clients[i];
        client.outbox.push(t);

        if (arm.ackGated) {
          if (!client.inFlight) send(i, t);
          return;
        }
        if (t - client.lastSendAt >= arm.minGapMs) {
          send(i, t);
          return;
        }
        if (client.timerPending) return;
        client.timerPending = true;
        const fireAt = client.lastSendAt + arm.minGapMs;
        timeline.at(fireAt, () => {
          client.timerPending = false;
          send(i, fireAt);
        });
      });
    }
  }

  timeline.run();

  const measuredSeconds = scenario.seconds - scenario.warmupSeconds;
  return {
    latency,
    egressMbps: (bytesSent * 8) / 1e6 / scenario.seconds,
    framesPerSecond: framesSent / scenario.seconds,
    serverUtilisation: serverBusyMs / (scenario.seconds * 1000),
    measuredSeconds,
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

function main(): void {
  console.log("calibrating against the real encoders...\n");
  const costs = calibrate();

  const oneOpJson = costs.jsonBytes(1);
  const oneOpBin = costs.binBytes(1);
  console.log(`frame for one keystroke   json ${oneOpJson.toFixed(0)} B    binary ${oneOpBin.toFixed(0)} B`);
  console.log(
    `decode one frame          json ${cost(costs.jsonDecode, 1).toFixed(2)} us  binary ${cost(costs.binDecode, 1).toFixed(2)} us`,
  );
  console.log(
    `encode one frame          json ${cost(costs.jsonEncode, 1).toFixed(2)} us  binary ${cost(costs.binEncode, 1).toFixed(2)} us`,
  );
  console.log(`apply one op              ${cost(costs.apply, 1).toFixed(2)} us\n`);

  const base: Scenario = {
    rooms: 40,
    peers: 8,
    seconds: 20,
    warmupSeconds: 4,
    oneWayMs: 30,
    jitterMs: 6,
    serverMbps: 100,
    uplinkMbps: 20,
    seed: 20260908,
  };

  console.log(
    `${base.rooms} documents x ${base.peers} editors, ${base.seconds - base.warmupSeconds}s measured, ` +
      `server on ${base.serverMbps} Mbit/s\n`,
  );

  for (const oneWayMs of [15, 30, 60, 90, 120, 150]) {
    const scenario = { ...base, oneWayMs };
    console.log(`one-way network delay ${oneWayMs} ms  (round trip ${oneWayMs * 2} ms)`);
    console.log(
      `  ${pad("pipeline", 24)}${padLeft("p50", 9)}${padLeft("p95", 9)}${padLeft("p99", 9)}${padLeft("mean", 9)}${padLeft("egress", 11)}${padLeft("cpu", 9)}`,
    );

    let reference = 0;
    let referenceP95 = 0;
    for (const arm of ARMS) {
      const run = simulate(scenario, arm, costs);
      const mean = run.latency.mean;
      const p95 = run.latency.quantile(0.95);
      if (reference === 0) {
        reference = mean;
        referenceP95 = p95;
      }

      const change = ((reference - mean) / reference) * 100;
      const drop = arm === ARMS[0] ? "" : `  ${change >= 0 ? "-" : "+"}${Math.abs(change).toFixed(0)}% mean`;
      console.log(
        `  ${pad(arm.name, 24)}` +
          `${padLeft(run.latency.quantile(0.5).toFixed(1), 8)}ms` +
          `${padLeft(p95.toFixed(1), 8)}ms` +
          `${padLeft(run.latency.quantile(0.99).toFixed(1), 8)}ms` +
          `${padLeft(mean.toFixed(1), 8)}ms` +
          `${padLeft(run.egressMbps.toFixed(1), 9)}Mb` +
          `${padLeft((run.serverUtilisation * 100).toFixed(1), 8)}%` +
          drop,
      );
      if (arm === ARMS[ARMS.length - 1]) {
        const p95Drop = ((referenceP95 - p95) / referenceP95) * 100;
        console.log(`  ${pad("", 24)}p95 ${p95Drop >= 0 ? "-" : "+"}${Math.abs(p95Drop).toFixed(0)}% against the server-ordered baseline`);
      }
    }
    console.log();
  }
}

main();
