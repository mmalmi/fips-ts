import { type Logger, type Transport, type TransportAddress, type TransportContext } from "@fips/core";
import { NostrRelayClient, type NostrEvent } from "./NostrRelayClient.js";
export declare const NOSTR_RELAY_DATAGRAM_KIND = 21060;
export interface NostrRelayTransportConfig {
    relays: string[];
    relayClients?: NostrRelayClient[];
    mtu?: number;
    webSocket?: typeof WebSocket;
    relayConnectTimeoutMs?: number;
    logger?: Logger;
}
/**
 * Low-priority FIPS wire datagrams carried in targeted ephemeral Nostr events.
 * Relay selection and route affinity remain application-side policy.
 */
export declare class NostrRelayTransport implements Transport {
    readonly type = "nostr_relay";
    readonly mtu: number;
    private readonly cfg;
    private readonly logger;
    private ctx?;
    private clients;
    private ownsClients;
    private cleanups;
    private readonly affinity;
    constructor(config: NostrRelayTransportConfig);
    start(ctx: TransportContext): Promise<void>;
    stop(): Promise<void>;
    connect(addr: TransportAddress): Promise<void>;
    send(addr: TransportAddress, packet: Uint8Array): Promise<void>;
    /** Prefer fresh relays that delivered this peer's public advert. */
    recordAdvertSource(remotePubkeyHex: string, relayUrl: string): void;
    /** Validate and inject a kind-21060 event received by an external adapter. */
    ingestEvent(event: NostrEvent): boolean;
    private createClients;
    private destinationXOnly;
    private deliveryClients;
}
//# sourceMappingURL=NostrRelayTransport.d.ts.map