export declare const RECENT_PEERS_VERSION: 1;
export declare const RECENT_PEERS_MAX_PEERS = 256;
export declare const RECENT_PEERS_MAX_ENDPOINTS = 4;
export interface RecentPeerEndpoint {
    transport: "udp";
    addr: string;
    last_authenticated_at_ms: number;
}
export interface RecentPeer {
    last_authenticated_at_ms: number;
    endpoints: RecentPeerEndpoint[];
}
/**
 * Local reconnect hints learned from authenticated FIPS links.
 *
 * This cache is not an authorization source. Callers must apply their current
 * admission policy before dialing or accepting any cached identity.
 */
export interface RecentPeers {
    version: typeof RECENT_PEERS_VERSION;
    local_npub: string;
    scope: string;
    peers: Record<string, RecentPeer>;
}
export declare function createRecentPeers(localNpub: string, scope: string): RecentPeers;
export declare function parseRecentPeers(value: unknown, expectedLocalNpub: string, expectedScope: string): RecentPeers;
export declare function observeAuthenticatedPeer(recentPeers: RecentPeers, remoteNpub: string, authenticatedAtMs: number, udpAddr?: string): RecentPeers;
export declare function pruneRecentPeers(recentPeers: RecentPeers, nowMs: number, ttlMs: number): RecentPeers;
//# sourceMappingURL=recentPeers.d.ts.map