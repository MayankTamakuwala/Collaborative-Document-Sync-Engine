import { Doc, type Op } from "@collab/crdt";
import { encode, encodeJson, decode, decodeJson, type Message } from "@collab/protocol";

/**
 * Per-stage costs, measured on this machine rather than guessed at. The
 * simulation is only as honest as these numbers, so they come from tight loops
 * over the real encoders and the real CRDT.
 */
export interface StageCost {
  /** Fixed cost of handling a frame, in microseconds. */
  fixed: number;
  /** Extra cost per op in the frame. */
  perOp: number;
}

export interface Costs {
  jsonEncode: StageCost;
  jsonDecode: StageCost;
  binEncode: StageCost;
  binDecode: StageCost;
  apply: StageCost;
  /** Frame size in bytes for a batch of k single-character ops. */
  jsonBytes: (k: number) => number;
  binBytes: (k: number) => number;
}

function micros(fn: () => void, iterations: number): number {
  for (let i = 0; i < Math.min(iterations, 20_000); i++) fn();
  const started = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return ((performance.now() - started) * 1000) / iterations;
}

/** Two measurements, one line: cost(k) = fixed + perOp * k. */
function fit(at1: number, atN: number, n: number): StageCost {
  const perOp = (atN - at1) / (n - 1);
  return { fixed: at1 - perOp, perOp };
}

function batch(k: number): Op[] {
  const doc = new Doc(4242);
  const ops: Op[] = [];
  // A batch is one op per keystroke, which is what the wire actually sees
  // before anything gets coalesced.
  for (let i = 0; i < k; i++) ops.push(...doc.insert(i, "x"));
  return ops;
}

export function calibrate(): Costs {
  const BIG = 32;
  const one: Message = { type: "ops", ops: batch(1) };
  const many: Message = { type: "ops", ops: batch(BIG) };

  const oneJson = encodeJson(one);
  const manyJson = encodeJson(many);
  const oneBin = encode(one);
  const manyBin = encode(many);

  const jsonEncode = fit(
    micros(() => encodeJson(one), 200_000),
    micros(() => encodeJson(many), 50_000),
    BIG,
  );
  const jsonDecode = fit(
    micros(() => decodeJson(oneJson), 100_000),
    micros(() => decodeJson(manyJson), 20_000),
    BIG,
  );
  const binEncode = fit(
    micros(() => encode(one), 200_000),
    micros(() => encode(many), 50_000),
    BIG,
  );
  const binDecode = fit(
    micros(() => decode(oneBin), 200_000),
    micros(() => decode(manyBin), 50_000),
    BIG,
  );

  const apply = fit(measureApply(1), measureApply(BIG), BIG);

  const jsonPerOp = (manyJson.length - oneJson.length) / (BIG - 1);
  const binPerOp = (manyBin.byteLength - oneBin.byteLength) / (BIG - 1);

  return {
    jsonEncode,
    jsonDecode,
    binEncode,
    binDecode,
    apply,
    jsonBytes: (k) => oneJson.length + jsonPerOp * (k - 1),
    binBytes: (k) => oneBin.byteLength + binPerOp * (k - 1),
  };
}

/**
 * Each round applies into a fresh replica so the document never grows, then
 * subtracts what building that replica costs on its own.
 */
function measureApply(k: number): number {
  const ops = batch(k);
  const rounds = k === 1 ? 100_000 : 20_000;
  let sink = 0;

  const total = micros(() => {
    const doc = new Doc(1);
    doc.apply(ops);
    sink += doc.length;
  }, rounds);
  const overhead = micros(() => {
    const doc = new Doc(1);
    sink += doc.length;
  }, rounds);

  if (sink < 0) throw new Error("unreachable");
  return total - overhead;
}

export function cost(stage: StageCost, ops: number): number {
  return stage.fixed + stage.perOp * ops;
}
