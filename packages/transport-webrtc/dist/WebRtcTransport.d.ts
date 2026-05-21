import { type Logger, type Transport, type TransportAddress, type TransportContext } from "@fips/core";
export interface WebRtcTransportConfig {
    relays: string[];
    stunServers?: string[];
    advertiseOnNostr?: boolean;
    acceptConnections?: boolean;
    autoConnect?: boolean;
    discoveryApp?: string;
    advertTtlMs?: number;
    mtu?: number;
    maxConnections?: number;
    connectTimeoutMs?: number;
    relayConnectTimeoutMs?: number;
    iceGatherTimeoutMs?: number;
    dataChannelLabel?: string;
    ordered?: boolean;
    maxRetransmits?: number | null;
    webSocket?: typeof WebSocket;
    rtcPeerConnection?: typeof RTCPeerConnection;
    debug?: boolean;
    logger?: Logger;
}
export declare class WebRtcTransport implements Transport {
    readonly type = "webrtc";
    readonly mtu: number;
    private ctx?;
    private readonly cfg;
    private readonly logger;
    private readonly RTCPC;
    private signaling?;
    private relayClients;
    private readonly conns;
    private readonly pendingDials;
    private readonly autoConnectPeers;
    private readonly knownSessionIds;
    private readonly seenSessionIds;
    private advertCleanup?;
    constructor(config: WebRtcTransportConfig);
    start(ctx: TransportContext): Promise<void>;
    stop(): Promise<void>;
    private handleAdvert;
    connect(addr: TransportAddress): Promise<void>;
    send(addr: TransportAddress, packet: Uint8Array): Promise<void>;
    close(addr: TransportAddress): Promise<void>;
    private startInitiatorHandshake;
    private handleIncomingSignal;
}
//# sourceMappingURL=WebRtcTransport.d.ts.map