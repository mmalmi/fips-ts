export function toHex(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
        s += bytes[i].toString(16).padStart(2, "0");
    }
    return s;
}
export function fromHex(hex) {
    if (hex.length % 2 !== 0)
        throw new Error("hex string must be even length");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        if (Number.isNaN(byte))
            throw new Error(`bad hex at index ${i * 2}`);
        out[i] = byte;
    }
    return out;
}
export function bytesEqual(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
}
export function concatBytes(...arrs) {
    let total = 0;
    for (const a of arrs)
        total += a.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrs) {
        out.set(a, off);
        off += a.length;
    }
    return out;
}
//# sourceMappingURL=hex.js.map