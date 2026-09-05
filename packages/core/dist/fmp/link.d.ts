/**
 * FMP link state machine — adjacent-peer encrypted channel.
 *
 * Wire frames match Rust FIPS byte layout (FMP Msg1/Msg2/Established with
 * 4-byte common prefix and fixed Noise IK payload sizes 106/57). The inner
 * handshake is the real Noise_IK_secp256k1_ChaChaPoly_SHA256 pattern with an
 * 8-byte startup epoch payload used for restart detection.
 *
 * The link's job:
 *   - Noise IK handshake (msg1/msg2)
 *   - frame keep-alive and data packets with the split CipherStates
 *   - enforce replay window on the receive side
 */
import type { FipsIdentity } from "../identity/index.js";
import { FMP_PHASE_ESTABLISHED, FMP_PHASE_MSG1, FMP_PHASE_MSG2 } from "./wire.js";
export type FmpRole = "initiator" | "responder";
export interface FmpLinkInit {
    identity: FipsIdentity;
    remotePubkey?: Uint8Array;
    role: FmpRole;
    sessionIdx: number;
    /** Process-local startup epoch shared by every FMP/FSP handshake. */
    localEpoch: Uint8Array;
    /** Optional deterministic ephemeral for vectors/tests. */
    ephemeralOverride?: Uint8Array;
}
export interface FmpHandshakeOutbound {
    packet: Uint8Array;
}
export interface FmpHandshakeResult {
    reply?: Uint8Array;
    established: boolean;
    remotePubkey: Uint8Array;
}
export declare class FmpLink {
    readonly role: FmpRole;
    readonly localSessionIdx: number;
    readonly identity: FipsIdentity;
    readonly localEpoch: Uint8Array;
    remotePubkey?: Uint8Array;
    remoteSessionIdx?: number;
    remoteEpoch?: Uint8Array;
    private hs?;
    private tx?;
    private rx?;
    private establishedMsg1?;
    private establishedMsg2?;
    private txCounter;
    private sessionStartMs;
    private rxReplay;
    state: "init" | "handshaking" | "established" | "closed";
    constructor(init: FmpLinkInit);
    buildMsg1(_rand: (n: number) => Uint8Array): FmpHandshakeOutbound;
    handleMsg1(packet: Uint8Array, _rand: (n: number) => Uint8Array): FmpHandshakeResult;
    handleMsg2(packet: Uint8Array): FmpHandshakeResult;
    private finalize;
    encryptOutgoing(payload: Uint8Array, msgType?: number): Uint8Array;
    encryptKeepalive(): Uint8Array;
    decryptIncoming(packet: Uint8Array): {
        msgType: number;
        payload: Uint8Array;
    };
    close(): void;
}
export { FMP_PHASE_ESTABLISHED, FMP_PHASE_MSG1, FMP_PHASE_MSG2 };
export declare function isEqualPubkey(a: Uint8Array, b: Uint8Array): boolean;
//# sourceMappingURL=link.d.ts.map