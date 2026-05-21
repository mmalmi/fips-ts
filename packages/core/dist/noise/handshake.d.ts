/**
 * Noise HandshakeState for the two patterns FIPS uses:
 *
 *   Noise_IK_secp256k1_ChaChaPoly_SHA256
 *     <- s
 *     ...
 *     -> e, es, s, ss
 *     <- e, ee, se
 *
 *   Noise_XK_secp256k1_ChaChaPoly_SHA256
 *     <- s
 *     ...
 *     -> e
 *     <- e, ee
 *     -> s, se
 *
 * DH function: secp256k1 ECDH. Public keys are 33-byte compressed; the
 * shared-secret material is the 32-byte x-coordinate.
 *
 * AEAD: ChaCha20-Poly1305; nonce = 4×0 || u64 LE counter (matches Rust FIPS).
 * HASH: SHA-256.
 */
import { type FipsIdentity } from "../identity/index.js";
import type { CipherState } from "./cipherState.js";
export type NoisePattern = "IK" | "XK";
export type NoiseRole = "initiator" | "responder";
export interface NoiseHandshakeInit {
    pattern: NoisePattern;
    role: NoiseRole;
    identity: FipsIdentity;
    /** Required for IK initiator and XK initiator: responder's static pubkey (33 bytes compressed). */
    remoteStatic?: Uint8Array;
    /** Required for IK responder and XK responder: empty since their own static is the identity. */
    /** Optional deterministic ephemeral private key (32 bytes); for tests/vectors. */
    ephemeralOverride?: Uint8Array;
}
/**
 * NoiseHandshake state machine. `writeMessage` and `readMessage` advance one
 * pattern step at a time. Call `split()` after the final step to obtain a pair
 * of CipherStates `(initiatorTx, responderTx)`.
 */
export declare class NoiseHandshake {
    readonly pattern: NoisePattern;
    readonly role: NoiseRole;
    private readonly ss;
    private readonly s;
    private e?;
    private rs?;
    private re?;
    private readonly ephemeralOverride?;
    private step;
    constructor(init: NoiseHandshakeInit);
    /** Returns the running handshake hash for diagnostics. */
    getHandshakeHash(): Uint8Array;
    /** Build the next outbound handshake message, encrypting the given payload. */
    writeMessage(payload: Uint8Array): Uint8Array;
    /** Consume an inbound handshake message; returns the plaintext payload. */
    readMessage(message: Uint8Array): Uint8Array;
    /** Returns `(tx, rx)` where `tx` is for sending from our role. */
    splitTxRx(): {
        tx: CipherState;
        rx: CipherState;
    };
    /** Remote static, captured during the handshake (for IK responder etc.). */
    getRemoteStatic(): Uint8Array | undefined;
    private tokensForStep;
    private isSenderForStep;
    private dh;
}
//# sourceMappingURL=handshake.d.ts.map