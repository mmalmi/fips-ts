/**
 * Lightweight Nostr event builder and verifier — kind 1/37195/21059 etc.
 * Signs with BIP-340 Schnorr. The event id is SHA-256 of the canonical
 * serialization (NIP-01).
 */
import { sha256 } from "@noble/hashes/sha256";
import { schnorr } from "@noble/curves/secp256k1";
import { toHex } from "@fips/core";
export function serializeForId(e) {
    // NIP-01: [0, pubkey, created_at, kind, tags, content]
    return new TextEncoder().encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]));
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
export function verifyEvent(e) {
    const id = computeEventId(e);
    if (id !== e.id)
        return false;
    try {
        return schnorr.verify(e.sig, e.id, e.pubkey);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=nostrEvent.js.map