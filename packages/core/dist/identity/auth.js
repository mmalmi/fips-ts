/**
 * Auth challenge-response (mirrors Rust ~/src/fips/crates/fips-identity/auth.rs).
 *
 * Domain: SHA256("fips-auth-v1" || challenge(32) || timestamp_be(8))
 * Signature: BIP-340 Schnorr by the responder's static key.
 * Verify yields the responder's 16-byte NodeAddr on success.
 */
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes } from "../codec/hex.js";
import { deriveNodeAddr, } from "../nodeaddr/index.js";
import { signSchnorr, verifySchnorr } from "./index.js";
const AUTH_DOMAIN = new TextEncoder().encode("fips-auth-v1");
function u64BigEndian(n) {
    if (n < 0n || n > 0xffffffffffffffffn) {
        throw new RangeError(`u64 out of range: ${n}`);
    }
    const out = new Uint8Array(8);
    let v = n;
    for (let i = 7; i >= 0; i--) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
}
/** Compute the auth-challenge digest exactly as Rust does. */
export function authChallengeDigest(challenge, timestamp) {
    if (challenge.length !== 32) {
        throw new Error("challenge must be 32 bytes");
    }
    return sha256(concatBytes(AUTH_DOMAIN, challenge, u64BigEndian(timestamp)));
}
/** Sign a challenge with `identity`, producing an AuthResponse. */
export function signChallenge(identity, challenge, timestamp) {
    const digest = authChallengeDigest(challenge, timestamp);
    const signature = signSchnorr(identity, digest);
    return {
        xOnlyPubkey: identity.xOnlyPubkey,
        timestamp,
        signature,
    };
}
/**
 * Verify that `response` is a valid response to `challenge`. Returns the
 * responder's NodeAddr on success; throws on signature failure.
 */
export function verifyChallenge(challenge, response) {
    const digest = authChallengeDigest(challenge, response.timestamp);
    const ok = verifySchnorr(response.signature, digest, response.xOnlyPubkey);
    if (!ok) {
        throw new Error("auth signature verification failed");
    }
    return deriveNodeAddr(response.xOnlyPubkey);
}
/** Generate a fresh 32-byte random challenge. */
export function generateAuthChallenge() {
    const out = new Uint8Array(32);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        crypto.getRandomValues(out);
    }
    else {
        for (let i = 0; i < out.length; i++)
            out[i] = Math.floor(Math.random() * 256);
    }
    return out;
}
//# sourceMappingURL=auth.js.map