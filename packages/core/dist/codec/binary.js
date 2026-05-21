export class BinaryWriter {
    chunks = [];
    len = 0;
    u8(n) {
        if (!Number.isInteger(n) || n < 0 || n > 0xff) {
            throw new RangeError(`u8 out of range: ${n}`);
        }
        this.chunks.push(new Uint8Array([n]));
        this.len += 1;
    }
    u16le(n) {
        if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
            throw new RangeError(`u16 out of range: ${n}`);
        }
        const b = new Uint8Array(2);
        b[0] = n & 0xff;
        b[1] = (n >>> 8) & 0xff;
        this.chunks.push(b);
        this.len += 2;
    }
    u32le(n) {
        if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
            throw new RangeError(`u32 out of range: ${n}`);
        }
        const b = new Uint8Array(4);
        b[0] = n & 0xff;
        b[1] = (n >>> 8) & 0xff;
        b[2] = (n >>> 16) & 0xff;
        b[3] = (n >>> 24) & 0xff;
        this.chunks.push(b);
        this.len += 4;
    }
    u64le(n) {
        if (typeof n !== "bigint")
            throw new TypeError("u64le expects bigint");
        if (n < 0n || n > 0xffffffffffffffffn) {
            throw new RangeError(`u64 out of range: ${n}`);
        }
        const b = new Uint8Array(8);
        let v = n;
        for (let i = 0; i < 8; i++) {
            b[i] = Number(v & 0xffn);
            v >>= 8n;
        }
        this.chunks.push(b);
        this.len += 8;
    }
    bytes(b) {
        this.chunks.push(b);
        this.len += b.length;
    }
    get length() {
        return this.len;
    }
    toBytes() {
        const out = new Uint8Array(this.len);
        let off = 0;
        for (const c of this.chunks) {
            out.set(c, off);
            off += c.length;
        }
        return out;
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
        const v = this.buf[this.off] | (this.buf[this.off + 1] << 8);
        this.off += 2;
        return v >>> 0;
    }
    u32le() {
        this.require(4);
        const v = this.buf[this.off] |
            (this.buf[this.off + 1] << 8) |
            (this.buf[this.off + 2] << 16) |
            (this.buf[this.off + 3] << 24);
        this.off += 4;
        return v >>> 0;
    }
    u64le() {
        this.require(8);
        let v = 0n;
        for (let i = 7; i >= 0; i--) {
            v = (v << 8n) | BigInt(this.buf[this.off + i]);
        }
        this.off += 8;
        return v;
    }
    bytes(n) {
        this.require(n);
        const out = this.buf.subarray(this.off, this.off + n);
        this.off += n;
        return new Uint8Array(out);
    }
    rest() {
        const out = this.buf.subarray(this.off);
        this.off = this.buf.length;
        return new Uint8Array(out);
    }
    get position() {
        return this.off;
    }
    get remaining() {
        return this.buf.length - this.off;
    }
}
//# sourceMappingURL=binary.js.map