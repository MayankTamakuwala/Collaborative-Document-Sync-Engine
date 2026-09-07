const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Writer {
  private buf = new Uint8Array(512);
  private len = 0;

  private need(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(value: number): void {
    this.need(1);
    this.buf[this.len++] = value & 0xff;
  }

  /** LEB128. Everything on the wire is non-negative so no zigzag needed. */
  varint(value: number): void {
    this.need(5);
    let v = value;
    while (v > 0x7f) {
      this.buf[this.len++] = (v & 0x7f) | 0x80;
      v = Math.floor(v / 128);
    }
    this.buf[this.len++] = v;
  }

  str(value: string): void {
    const bytes = encoder.encode(value);
    this.varint(bytes.length);
    this.need(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class Reader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw new RangeError("read past end of frame");
    return this.buf[this.pos++];
  }

  varint(): number {
    let result = 0;
    let shift = 1;
    for (;;) {
      const byte = this.u8();
      result += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) return result;
      shift *= 128;
    }
  }

  str(): string {
    const len = this.varint();
    const end = this.pos + len;
    if (end > this.buf.length) throw new RangeError("string runs past end of frame");
    const out = decoder.decode(this.buf.subarray(this.pos, end));
    this.pos = end;
    return out;
  }
}
