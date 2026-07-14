import type { DiscoveredPeer } from "@fips/core";
import type { NostrEvent } from "./NostrRelayClient.js";
export interface CachedWebRtcAdvert {
    peer: DiscoveredPeer;
    createdAtSeconds: number;
    expiresAtMs: number;
}
export declare class WebRtcAdvertCache {
    private readonly advertTtlMs;
    private readonly onEvict;
    private readonly entries;
    constructor(advertTtlMs: number, onEvict: (remoteAddr: string) => void);
    clear(): void;
    values(): IterableIterator<CachedWebRtcAdvert>;
    store(nodeAddrHex: string, peer: DiscoveredPeer, event: NostrEvent, nowMs?: number): DiscoveredPeer | undefined;
    get(nodeAddrHex: string, nowMs?: number): DiscoveredPeer | undefined;
    prune(nowMs: number): void;
    private evict;
}
//# sourceMappingURL=WebRtcAdvertCache.d.ts.map