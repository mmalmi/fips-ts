export function writeU16le(buf, off, n) {
    buf[off] = n & 0xff;
    buf[off + 1] = (n >>> 8) & 0xff;
}
export function writeU32le(buf, off, n) {
    buf[off] = n & 0xff;
    buf[off + 1] = (n >>> 8) & 0xff;
    buf[off + 2] = (n >>> 16) & 0xff;
    buf[off + 3] = (n >>> 24) & 0xff;
}
export function writeU64le(buf, off, n) {
    writeU32le(buf, off, Number(n & 0xffffffffn));
    writeU32le(buf, off + 4, Number((n >> 32n) & 0xffffffffn));
}
export function readU16le(buf, off) {
    return (buf[off] | (buf[off + 1] << 8)) >>> 0;
}
export function readU32le(buf, off) {
    return (buf[off]
        | (buf[off + 1] << 8)
        | (buf[off + 2] << 16)
        | (buf[off + 3] << 24)) >>> 0;
}
export function readU64le(buf, off) {
    return (BigInt(readU32le(buf, off + 4)) << 32n) | BigInt(readU32le(buf, off));
}
export class BinaryWriter {
    buf;
    len = 0;
    constructor(initialCapacity = 64) {
        this.buf = new Uint8Array(initialCapacity);
    }
    ensure(extra) {
        const needed = this.len + extra;
        if (needed <= this.buf.length)
            return;
        let cap = this.buf.length || 64;
        while (cap < needed)
            cap *= 2;
        const next = new Uint8Array(cap);
        next.set(this.buf.subarray(0, this.len));
        this.buf = next;
    }
    u8(n) {
        if (!Number.isInteger(n) || n < 0 || n > 0xff) {
            throw new RangeError(`u8 out of range: ${n}`);
        }
        this.ensure(1);
        this.buf[this.len++] = n;
    }
    u16le(n) {
        if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
            throw new RangeError(`u16 out of range: ${n}`);
        }
        this.ensure(2);
        writeU16le(this.buf, this.len, n);
        this.len += 2;
    }
    u32le(n) {
        if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
            throw new RangeError(`u32 out of range: ${n}`);
        }
        this.ensure(4);
        writeU32le(this.buf, this.len, n);
        this.len += 4;
    }
    u64le(n) {
        if (typeof n !== "bigint")
            throw new TypeError("u64le expects bigint");
        if (n < 0n || n > 0xffffffffffffffffn) {
            throw new RangeError(`u64 out of range: ${n}`);
        }
        this.ensure(8);
        writeU64le(this.buf, this.len, n);
        this.len += 8;
    }
    bytes(b) {
        this.ensure(b.length);
        this.buf.set(b, this.len);
        this.len += b.length;
    }
    get length() {
        return this.len;
    }
    toBytes() {
        return this.buf.slice(0, this.len);
    }
}
export class BinaryReader {
    buf;
    off = 0;
    constructor(buf) {
        this.buf = buf;
    }
    require(n) {
        if (this.off + n > this.buf.length) {
            throw new RangeError(`BinaryReader: need ${n} byte(s) at offset ${this.off}, have ${this.buf.length - this.off}`);
        }
    }
    u8() {
        this.require(1);
        return this.buf[this.off++];
    }
    u16le() {
        this.require(2);
        const v = readU16le(this.buf, this.off);
        this.off += 2;
        return v;
    }
    u32le() {
        this.require(4);
        const v = readU32le(this.buf, this.off);
        this.off += 4;
        return v;
    }
    u64le() {
        this.require(8);
        const v = readU64le(this.buf, this.off);
        this.off += 8;
        return v;
    }
    bytes(n) {
        this.require(n);
        const out = this.buf.slice(this.off, this.off + n);
        this.off += n;
        return out;
    }
    rest() {
        const out = this.buf.slice(this.off);
        this.off = this.buf.length;
        return out;
    }
    get position() {
        return this.off;
    }
    get remaining() {
        return this.buf.length - this.off;
    }
}
//# sourceMappingURL=binary.js.map