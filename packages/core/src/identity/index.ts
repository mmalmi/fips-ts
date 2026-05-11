import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { randomBytes } from "@noble/hashes/utils";

import { fromHex, toHex } from "../codec/hex.js";
import { deriveNodeAddr, type NodeAddr } from "../nodeaddr/index.js";

export interface FipsIdentity {
  readonly secretKey: Uint8Array;   // 32 bytes
  readonly publicKey: Uint8Array;   // 33 bytes, compressed (0x02/0x03 prefix)
  readonly xOnlyPubkey: Uint8Array; // 32 bytes
  readonly nodeAddr: NodeAddr;      // 16 bytes
}

export async function generateIdentity(): Promise<FipsIdentity> {
  const secretKey = randomBytes(32);
  return identityFromSecretKey(secretKey);
}

export async function identityFromSecretKey(
  secretKey: Uint8Array,
): Promise<FipsIdentity> {
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

export interface SerializedIdentity {
  type: "fips-identity-v1";
  secretKeyHex: string;
}

export function exportIdentity(id: FipsIdentity): SerializedIdentity {
  return { type: "fips-identity-v1", secretKeyHex: toHex(id.secretKey) };
}

export async function importIdentity(
  serialized: SerializedIdentity,
): Promise<FipsIdentity> {
  if (serialized.type !== "fips-identity-v1") {
    throw new Error(`unknown identity type: ${serialized.type}`);
  }
  return identityFromSecretKey(fromHex(serialized.secretKeyHex));
}

/** 64-byte BIP-340 Schnorr signature over message digest (must be 32 bytes). */
export function signSchnorr(
  identity: FipsIdentity,
  message: Uint8Array,
): Uint8Array {
  return schnorr.sign(message, identity.secretKey);
}

export function verifySchnorr(
  signature: Uint8Array,
  message: Uint8Array,
  xOnlyPubkey: Uint8Array,
): boolean {
  if (signature.length !== 64) return false;
  if (xOnlyPubkey.length !== 32) return false;
  return schnorr.verify(signature, message, xOnlyPubkey);
}

/**
 * secp256k1 ECDH: returns the 32-byte x-coordinate of `secret * peerPubkey`.
 * Used internally by the Noise IK/XK handshakes.
 */
export function ecdh(
  secretKey: Uint8Array,
  peerCompressedPubkey: Uint8Array,
): Uint8Array {
  if (peerCompressedPubkey.length !== 33) {
    throw new Error("peer pubkey must be 33-byte compressed");
  }
  const shared = secp256k1.getSharedSecret(secretKey, peerCompressedPubkey, true);
  // getSharedSecret returns 33 bytes (compressed point); take x-coordinate.
  return shared.slice(1);
}
