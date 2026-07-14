/**
 * Minimal Nostr relay WebSocket client for FIPS peerfinding and datagrams:
 *   - publish an EVENT
 *   - REQ a single filter with a callback for matched events
 *   - close subscriptions / disconnect
 *
 * Avoids any framework. Works in browser and Node (where the consumer
 * supplies a WebSocket-like constructor).
 */
export type WebSocketCtor = typeof WebSocket;
export interface NostrEvent {
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
    sig: string;
}
export interface NostrFilter {
    authors?: string[];
    kinds?: number[];
    since?: number;
    until?: number;
    limit?: number;
    "#p"?: string[];
    "#d"?: string[];
    [key: string]: unknown;
}
export interface NostrRelayClientOptions {
    url: string;
    webSocket?: WebSocketCtor;
    connectTimeoutMs?: number;
    publishAckTimeoutMs?: number;
    onClose?: () => void;
    logger?: {
        debug: (...a: unknown[]) => void;
        warn: (...a: unknown[]) => void;
    };
}
type SubCallbacks = {
    onEvent: (ev: NostrEvent) => void;
    onEose?: () => void;
};
export declare class NostrRelayClient {
    readonly url: string;
    private ws?;
    private readyPromise?;
    private readonly subs;
    private readonly pendingPublishes;
    private readonly WS;
    private readonly connectTimeoutMs;
    private readonly publishAckTimeoutMs;
    private closed;
    private subCounter;
    private readonly logger;
    constructor(opts: NostrRelayClientOptions);
    isConnected(): boolean;
    connect(): Promise<void>;
    publish(event: NostrEvent): Promise<void>;
    subscribe(filter: NostrFilter, cb: SubCallbacks): Promise<() => void>;
    close(): void;
    private onMessage;
    private onPublishOk;
    private clearPendingPublish;
    private rejectPendingPublishes;
}
export {};
//# sourceMappingURL=NostrRelayClient.d.ts.map