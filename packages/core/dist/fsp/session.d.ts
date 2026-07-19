/**
 * FSP end-to-end session — same Rust-compatible wire envelope as before,
 * with the inner handshake now using the real Noise_XK_secp256k1_ChaChaPoly_SHA256
 * pattern. 8-byte epoch payloads at handshake steps 2 and 3 (XK msg1 has no
 * payload).
 */
import type { FipsIdentity } from "../identity/index.js";
import type { NodeAddr } from "../nodeaddr/index.js";
import { type DataPacket } from "./wire.js";
export type FspRole = "initiator" | "responder";
export interface FspSessionInit {
    identity: FipsIdentity;
    remotePubkey?: Uint8Array;
    role: FspRole;
    ephemeralOverride?: Uint8Array;
    localEpoch?: Uint8Array;
}
export declare class FspSession {
    readonly identity: FipsIdentity;
    readonly role: FspRole;
    remotePubkey?: Uint8Array;
    remoteEpoch?: Uint8Array;
    private readonly localEpoch;
    private hs?;
    private tx?;
    private rx?;
    private receivedSessionSetup?;
    private sentSessionAck?;
    private receivedSessionAck?;
    private sentSessionMsg3?;
    private establishedMsg3?;
    private remoteDirectFspTransport;
    private txCounter;
    private replay;
    state: "init" | "handshaking" | "established" | "closed";
    constructor(init: FspSessionInit);
    get remoteSupportsDirectFspTransport(): boolean;
    buildMsg1(_rand: (n: number) => Uint8Array): Uint8Array;
    buildSessionSetup(_rand: (n: number) => Uint8Array, srcCoords: NodeAddr | NodeAddr[], destCoords: NodeAddr | NodeAddr[]): Uint8Array;
    handleMsg1(packet: Uint8Array, _rand: (n: number) => Uint8Array): Uint8Array;
    handleSessionSetup(packet: Uint8Array, _rand: (n: number) => Uint8Array, localCoords: NodeAddr | NodeAddr[]): Uint8Array;
    matchesSessionSetup(packet: Uint8Array): boolean;
    handleMsg2(packet: Uint8Array, _rand: (n: number) => Uint8Array): Uint8Array;
    handleSessionAck(packet: Uint8Array, _rand: (n: number) => Uint8Array): Uint8Array;
    handleMsg3(packet: Uint8Array): void;
    handleSessionMsg3(packet: Uint8Array): void;
    private finalize;
    encryptDatagram(data: DataPacket, flags?: number): Uint8Array;
    encryptEndpointData(payload: Uint8Array, flags?: number): Uint8Array;
    encryptMessage(msgType: number, payload: Uint8Array, flags?: number): Uint8Array;
    encryptKeepalive(flags?: number): Uint8Array;
    decryptIncoming(packet: Uint8Array): {
        msgType: number;
        data?: DataPacket;
        endpointData?: Uint8Array;
        payload?: Uint8Array;
    };
    close(): void;
}
//# sourceMappingURL=session.d.ts.map