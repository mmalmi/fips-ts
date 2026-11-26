import { sha256 } from "@noble/hashes/sha256";
import { BinaryReader, BinaryWriter, writeU64le } from "../codec/binary.js";
import { bytesEqual } from "../codec/hex.js";
import { signSchnorr, verifySchnorr } from "../identity/index.js";
import { compareNodeAddr } from "../nodeaddr/index.js";
import { LinkMessageType } from "./link.js";
export const TREE_ANNOUNCE_VERSION = 1;
export const TREE_COORD_ENTRY_SIZE = 32;
export const TREE_ANNOUNCE_MIN_PAYLOAD_SIZE = 99;
export function treeDeclarationBytes(nodeAddr, parent, sequence, timestamp) {
    const out = new Uint8Array(48);
    out.set(nodeAddr, 0);
    out.set(parent, 16);
    writeU64le(out, 32, sequence);
    writeU64le(out, 40, timestamp);
    return out;
}
export function buildTreeAnnounce(identity, parent, sequence, timestamp, ancestry) {
    const signature = signSchnorr(identity, sha256(treeDeclarationBytes(identity.nodeAddr, parent, sequence, timestamp)));
    return { sequence, timestamp, parent, ancestry, signature };
}
export function encodeTreeAnnounce(announce) {
    validateTreeAnnounceSemantics(announce);
    if (announce.signature.length !== 64)
        throw new Error("TreeAnnounce signature must be 64 bytes");
    const writer = new BinaryWriter();
    writer.u8(LinkMessageType.TreeAnnounce);
    writer.u8(TREE_ANNOUNCE_VERSION);
    writer.u64le(announce.sequence);
    writer.u64le(announce.timestamp);
    writer.bytes(announce.parent);
    writer.u16le(announce.ancestry.length);
    for (const entry of announce.ancestry) {
        writer.bytes(entry.nodeAddr);
        writer.u64le(entry.sequence);
        writer.u64le(entry.timestamp);
    }
    writer.bytes(announce.signature);
    return writer.toBytes();
}
export function decodeTreeAnnounce(buf) {
    if (buf.length < 1 + TREE_ANNOUNCE_MIN_PAYLOAD_SIZE) {
        throw new Error("TreeAnnounce too short");
    }
    if (buf[0] !== LinkMessageType.TreeAnnounce)
        throw new Error("not a TreeAnnounce");
    return decodeTreeAnnouncePayload(buf.subarray(1));
}
export function decodeTreeAnnouncePayload(payload) {
    if (payload.length < TREE_ANNOUNCE_MIN_PAYLOAD_SIZE) {
        throw new Error("TreeAnnounce too short");
    }
    const reader = new BinaryReader(payload);
    if (reader.u8() !== TREE_ANNOUNCE_VERSION)
        throw new Error("unsupported TreeAnnounce version");
    const sequence = reader.u64le();
    const timestamp = reader.u64le();
    const parent = reader.bytes(16);
    const count = reader.u16le();
    if (count === 0 || reader.remaining !== count * TREE_COORD_ENTRY_SIZE + 64) {
        throw new Error("invalid TreeAnnounce ancestry length");
    }
    const ancestry = [];
    for (let i = 0; i < count; i++) {
        ancestry.push({
            nodeAddr: reader.bytes(16),
            sequence: reader.u64le(),
            timestamp: reader.u64le(),
        });
    }
    const announce = { sequence, timestamp, parent, ancestry, signature: reader.bytes(64) };
    validateTreeAnnounceSemantics(announce);
    return announce;
}
export function verifyTreeAnnounce(announce, peerPubkey) {
    const nodeAddr = announce.ancestry[0].nodeAddr;
    return verifySchnorr(announce.signature, sha256(treeDeclarationBytes(nodeAddr, announce.parent, announce.sequence, announce.timestamp)), peerPubkey.subarray(1));
}
export function validateTreeAnnounceSemantics(announce) {
    const first = announce.ancestry[0];
    if (!first)
        throw new Error("TreeAnnounce ancestry cannot be empty");
    const isRoot = bytesEqual(first.nodeAddr, announce.parent);
    if (isRoot && announce.ancestry.length !== 1)
        throw new Error("invalid root ancestry");
    if (!isRoot && !bytesEqual(announce.ancestry[1]?.nodeAddr ?? new Uint8Array(), announce.parent)) {
        throw new Error("TreeAnnounce parent does not match ancestry");
    }
    const root = announce.ancestry.at(-1).nodeAddr;
    for (const entry of announce.ancestry) {
        if (compareNodeAddr(entry.nodeAddr, root) < 0) {
            throw new Error("TreeAnnounce root is not the minimum ancestry address");
        }
    }
}
//# sourceMappingURL=tree.js.map