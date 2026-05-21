/**
 * Minimal Nostr relay WebSocket client — only what the FIPS WebRTC signaling
 * path needs:
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
    private readonly WS;
    private readonly connectTimeoutMs;
    private closed;
    private subCounter;
    private readonly logger;
    constructor(opts: NostrRelayClientOptions);
    connect(): Promise<void>;
    publish(event: NostrEvent): Promise<void>;
    subscribe(filter: NostrFilter, cb: SubCallbacks): Promise<() => void>;
    close(): void;
    private onMessage;
}
export {};
//# sourceMappingURL=NostrRelayClient.d.ts.map