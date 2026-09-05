export { bytesToHex as toHex, hexToBytes as fromHex, concatBytes } from "@noble/hashes/utils";
export function bytesEqual(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
}
//# sourceMappingURL=hex.js.map