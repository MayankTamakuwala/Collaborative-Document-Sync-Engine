/** Minimal binary heap over (time, callback); the simulation's only scheduler. */
export class Timeline {
  private times: number[] = [];
  private tasks: Array<() => void> = [];

  get size(): number {
    return this.times.length;
  }

  at(time: number, task: () => void): void {
    this.times.push(time);
    this.tasks.push(task);

    let i = this.times.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.times[parent] <= this.times[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  run(): void {
    while (this.times.length > 0) {
      const task = this.tasks[0];
      this.pop();
      task();
    }
  }

  private pop(): void {
    const last = this.times.length - 1;
    this.swap(0, last);
    this.times.pop();
    this.tasks.pop();

    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      if (left < this.times.length && this.times[left] < this.times[smallest]) smallest = left;
      if (right < this.times.length && this.times[right] < this.times[smallest]) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    [this.times[a], this.times[b]] = [this.times[b], this.times[a]];
    [this.tasks[a], this.tasks[b]] = [this.tasks[b], this.tasks[a]];
  }
}

/** Latency samples in 0.1ms buckets; cheaper than keeping millions of floats. */
export class Histogram {
  private buckets = new Uint32Array(60_000);
  private count = 0;
  private total = 0;

  add(ms: number): void {
    const bucket = Math.min(this.buckets.length - 1, Math.max(0, Math.round(ms * 10)));
    this.buckets[bucket] += 1;
    this.count += 1;
    this.total += ms;
  }

  get samples(): number {
    return this.count;
  }

  get mean(): number {
    return this.count === 0 ? 0 : this.total / this.count;
  }

  quantile(q: number): number {
    if (this.count === 0) return 0;
    const target = q * this.count;
    let seen = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      seen += this.buckets[i];
      if (seen >= target) return i / 10;
    }
    return this.buckets.length / 10;
  }
}
