/**
 * PeerIdentity — a remote peer's public-key-only identity.
 *
 * Mirrors Rust ~/src/fips/crates/fips-identity/src/peer.rs:
 *   - holds the x-only pubkey + NodeAddr
 *   - constructable from an npub string
 *   - verifies BIP-340 Schnorr signatures over SHA-256(data)
 */
import { type NodeAddr } from "../nodeaddr/index.js";
export declare class PeerIdentity {
    readonly xOnlyPubkey: Uint8Array;
    readonly nodeAddr: NodeAddr;
    private constructor();
    static fromXOnlyPubkey(xOnly: Uint8Array): PeerIdentity;
    static fromNpub(npub: string): PeerIdentity;
    npub(): string;
    /** Short display: first 8 bytes of npub hex + ellipsis. */
    shortNpub(): string;
    /**
     * Verify a Schnorr signature from this peer over SHA-256(data).
     * Returns true on success.
     */
    verify(data: Uint8Array, signature: Uint8Array): boolean;
}
//# sourceMappingURL=peer.d.ts.map