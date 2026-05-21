import type { TransportAddress } from "@fips/core";
export interface WebRtcConnectionConfig {
    remotePubkeyHex: string;
    remoteAddr: TransportAddress;
    pc: RTCPeerConnection;
    dataChannel: RTCDataChannel;
    onPacket: (data: Uint8Array) => void;
    onState: (state: "connecting" | "connected" | "disconnected" | "failed") => void;
    readyFallbackMs?: number;
}
/**
 * A single WebRTC datachannel link to one remote pubkey.
 *
 * Reports `connected` after both pc.connectionState === "connected" and the
 * data channel is open, then waits for the peer's small ready marker or a
 * short compatibility grace period. The grace keeps old peers working while
 * avoiding the common race where FMP Msg1 is sent before the responder's
 * onmessage handler is installed.
 */
export declare class WebRtcConnection {
    readonly remotePubkeyHex: string;
    readonly remoteAddr: TransportAddress;
    readonly pc: RTCPeerConnection;
    readonly dataChannel: RTCDataChannel;
    private state;
    private readonly onPacket;
    private readonly onState;
    private readonly readyFallbackMs;
    private localReadySent;
    private remoteReady;
    private fallbackTimer?;
    constructor(cfg: WebRtcConnectionConfig);
    private evaluateState;
    private sendLocalReady;
    private startReadyFallback;
    send(data: Uint8Array): void;
    close(): void;
}
//# sourceMappingURL=WebRtcConnection.d.ts.map