/**
 * Lightweight Nostr event builder and verifier for adverts and relay datagrams.
 * Signs with BIP-340 Schnorr. The event id is SHA-256 of the canonical
 * serialization (NIP-01).
 */
import { sha256 } from "@noble/hashes/sha256";
import { schnorr } from "@noble/curves/secp256k1";
import { toHex } from "@fips/core";
const textEncoder = new TextEncoder();
export function serializeForId(e) {
    // NIP-01: [0, pubkey, created_at, kind, tags, content]
    return textEncoder.encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]));
}
export function computeEventId(e) {
    return toHex(sha256(serializeForId(e)));
}
export function signEvent(identity, e) {
    const pubkey = toHex(identity.xOnlyPubkey);
    const unsigned = { pubkey, ...e };
    const id = computeEventId(unsigned);
    const sig = toHex(schnorr.sign(id, identity.secretKey));
    return { id, sig, ...unsigned };
}
export function verifyEventSignature(sig, id, pubkey) {
    try {
        return schnorr.verify(sig, id, pubkey);
    }
    catch {
        return false;
    }
}
export function verifyEvent(e) {
    return computeEventId(e) === e.id && verifyEventSignature(e.sig, e.id, e.pubkey);
}
//# sourceMappingURL=nostrEvent.js.map