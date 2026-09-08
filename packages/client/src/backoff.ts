export interface BackoffOptions {
  firstDelayMs: number;
  maxDelayMs: number;
  factor: number;
  /** Fraction of the delay to randomise away, so reconnects don't sync up. */
  jitter: number;
}

const DEFAULTS: BackoffOptions = {
  firstDelayMs: 300,
  maxDelayMs: 15_000,
  factor: 1.8,
  jitter: 0.3,
};

export class Backoff {
  private options: BackoffOptions;
  private tries = 0;

  constructor(options: Partial<BackoffOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  get attempts(): number {
    return this.tries;
  }

  next(): number {
    const { firstDelayMs, maxDelayMs, factor, jitter } = this.options;
    const raw = Math.min(firstDelayMs * factor ** this.tries, maxDelayMs);
    this.tries += 1;
    const spread = raw * jitter;
    return Math.round(raw - spread + Math.random() * spread * 2);
  }

  reset(): void {
    this.tries = 0;
  }
}
