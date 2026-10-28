import type { FipsIdentity, Logger } from "@fips/core";
import { NostrRelayClient, type NostrEvent, type NostrFilter } from "./NostrRelayClient.js";
export declare const FIPS_ADVERT_KIND = 37195;
export declare const FIPS_ADVERT_IDENTIFIER = "fips-overlay-v1";
export declare const FIPS_ADVERT_D_TAG = "fips-overlay-v1";
export declare const FIPS_DEFAULT_DISCOVERY_APP = "fips-overlay-v1";
export declare const FIPS_PROTOCOL_VERSION = "1";
export declare const DEFAULT_FIPS_ADVERT_TTL_MS: number;
export interface FipsAdvertContent {
    identifier: typeof FIPS_ADVERT_IDENTIFIER;
    version: 1;
    endpoints: Array<{
        transport: string;
        addr: string;
    }>;
    stunServers: string[];
}
/** Application-selected event routing/storage; no transport dependency on pubsub. */
export interface NostrDiscoveryProvider {
    publish(event: NostrEvent): Promise<void>;
    subscribe(filter: NostrFilter, onEvent: (event: NostrEvent, source: string) => void): Promise<() => void>;
}
export interface NostrPeerDiscoveryOptions {
    identity: FipsIdentity;
    relays: NostrRelayClient[];
    provider?: NostrDiscoveryProvider;
    discoveryApp?: string;
    advertTtlMs?: number;
    logger?: Logger;
}
/** Public Nostr peer adverts. Private transport negotiation happens over FSP. */
export declare class NostrPeerDiscovery {
    private readonly provider?;
    private readonly identity;
    private readonly relays;
    private readonly discoveryApp;
    private readonly advertTtlMs;
    private readonly logger?;
    private readonly cleanups;
    private stopped;
    constructor(opts: NostrPeerDiscoveryOptions);
    stop(): void;
    publishAdvert(advert: FipsAdvertContent): Promise<void>;
    subscribeAdverts(cb: (event: NostrEvent, advert: FipsAdvertContent, sourceRelayUrl: string) => void, extraFilter?: {
        authors?: string[];
    }): Promise<() => void>;
}
//# sourceMappingURL=NostrPeerDiscovery.d.ts.map