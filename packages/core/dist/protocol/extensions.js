import { BinaryReader, BinaryWriter } from "../codec/binary.js";
const MAGIC = new TextEncoder().encode("FIPS-EXT");
const VERSION = 1;
export const EXTENSION_LINK_MESSAGE_TYPE = 0xe0;
export const FSP_EXTENSION_DIRECT = 0x0001;
export const FMP_EXTENSION_CLIENT_ROLE = 0x0002;
export function hasExtensionMagic(payload) {
    return payload.length >= MAGIC.length
        && MAGIC.every((byte, index) => payload[index] === byte);
}
function extensionHeader(kind) {
    const writer = new BinaryWriter();
    writer.bytes(MAGIC);
    writer.u8(VERSION);
    writer.u8(kind);
    return writer;
}
export function encodeExtensionCapabilities(kind, capabilities) {
    if (kind !== 1 && kind !== 2)
        throw new RangeError("invalid capability message kind");
    const writer = extensionHeader(kind);
    writer.u16le(capabilities);
    return writer.toBytes();
}
export function decodeExtensionCapabilities(payload) {
    if (payload.length !== 12 || !hasExtensionMagic(payload) || payload[8] !== VERSION) {
        return undefined;
    }
    const kind = payload[9];
    if (kind !== 1 && kind !== 2)
        return undefined;
    return {
        kind,
        // Callers use only the capabilities defined for their protocol layer.
        capabilities: payload[10] | (payload[11] << 8),
    };
}
export function encodeExtensionClientOnly(sequence) {
    const writer = extensionHeader(3);
    writer.u64le(sequence);
    return writer.toBytes();
}
export function decodeLinkExtension(payload) {
    if (!hasExtensionMagic(payload) || payload[8] !== VERSION)
        return undefined;
    if (payload[9] === 1 || payload[9] === 2)
        return decodeExtensionCapabilities(payload);
    if (payload[9] === 3 && payload.length === 18) {
        return { kind: 3, sequence: new BinaryReader(payload.subarray(10)).u64le() };
    }
    // Listener advertisements (kind 4) are intentionally unsupported by JS.
    return undefined;
}
//# sourceMappingURL=extensions.js.map