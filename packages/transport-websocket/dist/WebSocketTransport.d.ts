import { type DiscoveredPeer, type Logger, type Transport, type TransportAddress, type TransportContext } from "@fips/core";
export declare const LOCAL_KEY_HINT_VERSION = 1;
export declare const LOCAL_KEY_HINT_REQUEST_BYTES = 9;
export declare const LOCAL_KEY_HINT_RESPONSE_BYTES = 41;
export type LocalKeyHint = {
    kind: "request";
    nonce: bigint;
} | {
    kind: "response";
    nonce: bigint;
    pubkey: Uint8Array;
};
export interface WebSocketTransportConfig {
    /** Explicit first-adjacency URLs. Remote URLs must use WSS; loopback may use WS for tests. */
    seedUrls: readonly string[];
    mtu?: number;
    maxFrameBytes?: number;
    maxSendQueue?: number;
    /** Browser WebSocket bufferedAmount ceiling before records wait in the bounded send queue. */
    maxBufferedBytes?: number;
    connectTimeoutMs?: number;
    keyHintTimeoutMs?: number;
    reconnectInitialMs?: number;
    reconnectMaxMs?: number;
    sendPollMs?: number;
    webSocket?: typeof WebSocket;
    logger?: Logger;
    /** Deterministic test hook. Production uses crypto.getRandomValues. */
    randomNonce?: () => bigint;
}
export interface WebSocketTransportStats {
    connectionAttempts: number;
    connectionsOpened: number;
    connectionsClosed: number;
    reconnectsScheduled: number;
    framesSent: number;
    framesReceived: number;
    bytesSent: number;
    bytesReceived: number;
    invalidFrames: number;
    sendQueueFull: number;
}
export declare class WebSocketTransport implements Transport {
    readonly type = "websocket";
    readonly mtu: number;
    private readonly WS;
    private readonly logger;
    private readonly maxFrameBytes;
    private readonly maxSendQueue;
    private readonly maxBufferedBytes;
    private readonly connectTimeoutMs;
    private readonly keyHintTimeoutMs;
    private readonly reconnectInitialMs;
    private readonly reconnectMaxMs;
    private readonly sendPollMs;
    private readonly randomNonce;
    private readonly seeds;
    private readonly counters;
    private ctx?;
    private discoveries?;
    private stopping;
    constructor(config: WebSocketTransportConfig);
    start(ctx: TransportContext): Promise<void>;
    stop(): Promise<void>;
    discover(): AsyncIterable<DiscoveredPeer>;
    connect(addr: TransportAddress): Promise<void>;
    send(addr: TransportAddress, packet: Uint8Array): Promise<void>;
    stats(): WebSocketTransportStats;
    private stateFor;
    private dial;
    private receive;
    private pump;
    private failSocket;
    private connectionEnded;
    private isReady;
    private isCurrent;
    private addr;
    private resolveReadyWaiters;
    private rejectReadyWaiters;
    private rejectQueue;
    private clearConnectionTimers;
    private clearTimers;
}
export declare function encodeLocalKeyHintRequest(nonce: bigint): Uint8Array;
export declare function encodeLocalKeyHintResponse(nonce: bigint, pubkey: Uint8Array): Uint8Array;
export declare function decodeLocalKeyHint(wire: Uint8Array): LocalKeyHint | undefined;
export declare function validateFipsWebSocketRecord(wire: Uint8Array, maxBytes?: number): void;
//# sourceMappingURL=WebSocketTransport.d.ts.map