import { type NodeAddr } from "../nodeaddr/index.js";
export interface FipsIdentity {
    readonly secretKey: Uint8Array;
    readonly publicKey: Uint8Array;
    readonly xOnlyPubkey: Uint8Array;
    readonly nodeAddr: NodeAddr;
}
/** Reconstruct and validate the canonical even-parity compressed key for an x-only key. */
export declare function compressedPubkeyFromXOnly(xOnlyPubkey: Uint8Array): Uint8Array;
export declare function generateIdentity(): Promise<FipsIdentity>;
export declare function identityFromSecretKey(secretKey: Uint8Array): Promise<FipsIdentity>;
export interface SerializedIdentity {
    type: "fips-identity-v1";
    secretKeyHex: string;
}
export declare function exportIdentity(id: FipsIdentity): SerializedIdentity;
export declare function importIdentity(serialized: SerializedIdentity): Promise<FipsIdentity>;
/** 64-byte BIP-340 Schnorr signature over message digest (must be 32 bytes). */
export declare function signSchnorr(identity: FipsIdentity, message: Uint8Array): Uint8Array;
export declare function verifySchnorr(signature: Uint8Array, message: Uint8Array, xOnlyPubkey: Uint8Array): boolean;
/**
 * FIPS Noise DH: SHA-256 of the ECDH x-coordinate.
 *
 * This matches Rust FIPS `crates/fips-core/src/noise/handshake.rs::ecdh` which
 * hashes the x-coord to produce a parity-independent shared secret (necessary
 * because Nostr npubs are x-only without parity, so initiator and responder
 * may pick opposite parities for the same logical key but P and -P produce
 * the same x). Without this hash, Noise handshakes do not interop with Rust.
 */
export declare function ecdh(secretKey: Uint8Array, peerCompressedPubkey: Uint8Array): Uint8Array;
//# sourceMappingURL=index.d.ts.map