import type { TransportAddress } from "@fips/core";
export interface WebRtcConnectionConfig {
    remotePubkeyHex: string;
    remoteAddr: TransportAddress;
    pc: RTCPeerConnection;
    dataChannel: RTCDataChannel;
    onPacket: (data: Uint8Array) => void;
    onState: (state: "connecting" | "connected" | "disconnected" | "failed") => void;
}
/**
 * A single WebRTC datachannel link to one remote pubkey.
 *
 * Reports `connected` only when both pc.connectionState === "connected" AND
 * dataChannel.readyState === "open".
 */
export declare class WebRtcConnection {
    readonly remotePubkeyHex: string;
    readonly remoteAddr: TransportAddress;
    readonly pc: RTCPeerConnection;
    readonly dataChannel: RTCDataChannel;
    private state;
    private readonly onPacket;
    private readonly onState;
    constructor(cfg: WebRtcConnectionConfig);
    private evaluateState;
    send(data: Uint8Array): void;
    close(): void;
}
//# sourceMappingURL=WebRtcConnection.d.ts.map