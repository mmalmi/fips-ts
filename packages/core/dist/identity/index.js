import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "@noble/hashes/utils";
import { fromHex, toHex } from "../codec/hex.js";
import { deriveNodeAddr } from "../nodeaddr/index.js";
/** Reconstruct and validate the canonical even-parity compressed key for an x-only key. */
export function compressedPubkeyFromXOnly(xOnlyPubkey) {
    if (xOnlyPubkey.length !== 32) {
        throw new Error("x-only pubkey must be 32 bytes");
    }
    const publicKey = new Uint8Array(33);
    publicKey[0] = 0x02;
    publicKey.set(xOnlyPubkey, 1);
    secp256k1.ProjectivePoint.fromHex(publicKey);
    return publicKey;
}
export async function generateIdentity() {
    const secretKey = randomBytes(32);
    return identityFromSecretKey(secretKey);
}
export async function identityFromSecretKey(secretKey) {
    if (secretKey.length !== 32) {
        throw new Error("secret key must be 32 bytes");
    }
    // Compressed pubkey: 33 bytes, includes parity prefix. FIPS NodeAddr uses
    // the x-only (BIP-340) variant — first byte stripped.
    const publicKey = secp256k1.getPublicKey(secretKey, true);
    const xOnlyPubkey = publicKey.slice(1);
    const nodeAddr = deriveNodeAddr(xOnlyPubkey);
    return { secretKey, publicKey, xOnlyPubkey, nodeAddr };
}
export function exportIdentity(id) {
    return { type: "fips-identity-v1", secretKeyHex: toHex(id.secretKey) };
}
export async function importIdentity(serialized) {
    if (serialized.type !== "fips-identity-v1") {
        throw new Error(`unknown identity type: ${serialized.type}`);
    }
    return identityFromSecretKey(fromHex(serialized.secretKeyHex));
}
/** 64-byte BIP-340 Schnorr signature over message digest (must be 32 bytes). */
export function signSchnorr(identity, message) {
    return schnorr.sign(message, identity.secretKey);
}
export function verifySchnorr(signature, message, xOnlyPubkey) {
    if (signature.length !== 64)
        return false;
    if (xOnlyPubkey.length !== 32)
        return false;
    return schnorr.verify(signature, message, xOnlyPubkey);
}
/**
 * FIPS Noise DH: SHA-256 of the ECDH x-coordinate.
 *
 * This matches Rust FIPS `crates/fips-core/src/noise/handshake.rs::ecdh` which
 * hashes the x-coord to produce a parity-independent shared secret (necessary
 * because Nostr npubs are x-only without parity, so initiator and responder
 * may pick opposite parities for the same logical key but P and -P produce
 * the same x). Without this hash, Noise handshakes do not interop with Rust.
 */
export function ecdh(secretKey, peerCompressedPubkey) {
    if (peerCompressedPubkey.length !== 33) {
        throw new Error("peer pubkey must be 33-byte compressed");
    }
    const shared = secp256k1.getSharedSecret(secretKey, peerCompressedPubkey, true);
    // getSharedSecret returns 33 bytes (parity prefix || x-coord). Hash the
    // x-coord per FIPS spec.
    const x = shared.slice(1);
    return sha256(x);
}
//# sourceMappingURL=index.js.map