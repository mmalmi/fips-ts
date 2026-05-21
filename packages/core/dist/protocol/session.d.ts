import type { NodeAddr } from "../nodeaddr/index.js";
export interface SessionSetup {
    srcCoords: NodeAddr[];
    destCoords: NodeAddr[];
    flags: number;
    handshakePayload: Uint8Array;
}
export interface SessionAck {
    srcCoords: NodeAddr[];
    destCoords: NodeAddr[];
    flags: number;
    handshakePayload: Uint8Array;
}
export interface SessionMsg3 {
    flags: number;
    handshakePayload: Uint8Array;
}
export declare function encodeSessionSetup(msg: SessionSetup): Uint8Array;
export declare function decodeSessionSetup(frame: Uint8Array): SessionSetup;
export declare function encodeSessionAck(msg: SessionAck): Uint8Array;
export declare function decodeSessionAck(frame: Uint8Array): SessionAck;
export declare function encodeSessionMsg3(msg: SessionMsg3): Uint8Array;
export declare function decodeSessionMsg3(frame: Uint8Array): SessionMsg3;
//# sourceMappingURL=session.d.ts.map