export function writeU16le(buf: Uint8Array, off: number, n: number): void {
  buf[off] = n & 0xff;
  buf[off + 1] = (n >>> 8) & 0xff;
}

export function writeU32le(buf: Uint8Array, off: number, n: number): void {
  buf[off] = n & 0xff;
  buf[off + 1] = (n >>> 8) & 0xff;
  buf[off + 2] = (n >>> 16) & 0xff;
  buf[off + 3] = (n >>> 24) & 0xff;
}

export function writeU64le(buf: Uint8Array, off: number, n: bigint): void {
  writeU32le(buf, off, Number(n & 0xffff_ffffn));
  writeU32le(buf, off + 4, Number((n >> 32n) & 0xffff_ffffn));
}

export function readU16le(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8)) >>> 0;
}

export function readU32le(buf: Uint8Array, off: number): number {
  return (
    buf[off]!
    | (buf[off + 1]! << 8)
    | (buf[off + 2]! << 16)
    | (buf[off + 3]! << 24)
  ) >>> 0;
}

export function readU64le(buf: Uint8Array, off: number): bigint {
  return (BigInt(readU32le(buf, off + 4)) << 32n) | BigInt(readU32le(buf, off));
}

export class BinaryWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialCapacity = 64) {
    this.buf = new Uint8Array(initialCapacity);
  }

  private ensure(extra: number): void {
    const needed = this.len + extra;
    if (needed <= this.buf.length) return;
    let cap = this.buf.length || 64;
    while (cap < needed) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > 0xff) {
      throw new RangeError(`u8 out of range: ${n}`);
    }
    this.ensure(1);
    this.buf[this.len++] = n;
  }

  u16le(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
      throw new RangeError(`u16 out of range: ${n}`);
    }
    this.ensure(2);
    writeU16le(this.buf, this.len, n);
    this.len += 2;
  }

  u32le(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
      throw new RangeError(`u32 out of range: ${n}`);
    }
    this.ensure(4);
    writeU32le(this.buf, this.len, n);
    this.len += 4;
  }

  u64le(n: bigint): void {
    if (typeof n !== "bigint") throw new TypeError("u64le expects bigint");
    if (n < 0n || n > 0xffffffffffffffffn) {
      throw new RangeError(`u64 out of range: ${n}`);
    }
    this.ensure(8);
    writeU64le(this.buf, this.len, n);
    this.len += 8;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  get length(): number {
    return this.len;
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class BinaryReader {
  private off = 0;
  constructor(private readonly buf: Uint8Array) {}

  private require(n: number): void {
    if (this.off + n > this.buf.length) {
      throw new RangeError(
        `BinaryReader: need ${n} byte(s) at offset ${this.off}, have ${this.buf.length - this.off}`,
      );
    }
  }

  u8(): number {
    this.require(1);
    return this.buf[this.off++]!;
  }

  u16le(): number {
    this.require(2);
    const v = readU16le(this.buf, this.off);
    this.off += 2;
    return v;
  }

  u32le(): number {
    this.require(4);
    const v = readU32le(this.buf, this.off);
    this.off += 4;
    return v;
  }

  u64le(): bigint {
    this.require(8);
    const v = readU64le(this.buf, this.off);
    this.off += 8;
    return v;
  }

  bytes(n: number): Uint8Array {
    this.require(n);
    const out = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }

  rest(): Uint8Array {
    const out = this.buf.slice(this.off);
    this.off = this.buf.length;
    return out;
  }

  get position(): number {
    return this.off;
  }

  get remaining(): number {
    return this.buf.length - this.off;
  }
}
