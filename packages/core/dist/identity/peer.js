/**
 * PeerIdentity — a remote peer's public-key-only identity.
 *
 * Mirrors Rust ~/src/fips/crates/fips-identity/src/peer.rs:
 *   - holds the x-only pubkey + NodeAddr
 *   - constructable from an npub string
 *   - verifies BIP-340 Schnorr signatures over SHA-256(data)
 */
import { sha256 } from "@noble/hashes/sha256";
import { verifySchnorr } from "./index.js";
import { decodeNpub, encodeNpub } from "./nip19.js";
import { deriveNodeAddr, } from "../nodeaddr/index.js";
export class PeerIdentity {
    xOnlyPubkey;
    nodeAddr;
    constructor(xOnlyPubkey) {
        if (xOnlyPubkey.length !== 32) {
            throw new Error("xOnly pubkey must be 32 bytes");
        }
        this.xOnlyPubkey = xOnlyPubkey;
        this.nodeAddr = deriveNodeAddr(xOnlyPubkey);
    }
    static fromXOnlyPubkey(xOnly) {
        return new PeerIdentity(xOnly);
    }
    static fromNpub(npub) {
        return new PeerIdentity(decodeNpub(npub));
    }
    npub() {
        return encodeNpub(this.xOnlyPubkey);
    }
    /** Short display: first 8 bytes of npub hex + ellipsis. */
    shortNpub() {
        return this.npub().slice(0, 12) + "…";
    }
    /**
     * Verify a Schnorr signature from this peer over SHA-256(data).
     * Returns true on success.
     */
    verify(data, signature) {
        if (signature.length !== 64)
            return false;
        const digest = sha256(data);
        return verifySchnorr(signature, digest, this.xOnlyPubkey);
    }
}
//# sourceMappingURL=peer.js.map