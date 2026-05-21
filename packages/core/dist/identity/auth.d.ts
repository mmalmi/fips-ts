/**
 * Auth challenge-response (mirrors Rust ~/src/fips/crates/fips-identity/auth.rs).
 *
 * Domain: SHA256("fips-auth-v1" || challenge(32) || timestamp_be(8))
 * Signature: BIP-340 Schnorr by the responder's static key.
 * Verify yields the responder's 16-byte NodeAddr on success.
 */
import { type NodeAddr } from "../nodeaddr/index.js";
import { type FipsIdentity } from "./index.js";
export interface AuthResponse {
    /** Responder's x-only pubkey (32 bytes). */
    xOnlyPubkey: Uint8Array;
    /** u64 timestamp included in the signed digest. */
    timestamp: bigint;
    /** 64-byte BIP-340 Schnorr signature. */
    signature: Uint8Array;
}
/** Compute the auth-challenge digest exactly as Rust does. */
export declare function authChallengeDigest(challenge: Uint8Array, timestamp: bigint): Uint8Array;
/** Sign a challenge with `identity`, producing an AuthResponse. */
export declare function signChallenge(identity: FipsIdentity, challenge: Uint8Array, timestamp: bigint): AuthResponse;
/**
 * Verify that `response` is a valid response to `challenge`. Returns the
 * responder's NodeAddr on success; throws on signature failure.
 */
export declare function verifyChallenge(challenge: Uint8Array, response: AuthResponse): NodeAddr;
/** Generate a fresh 32-byte random challenge. */
export declare function generateAuthChallenge(): Uint8Array;
//# sourceMappingURL=auth.d.ts.map