import type { DiscoveredPeer } from "@fips/core";
interface AutoConnectCandidate {
    peer: DiscoveredPeer;
    createdAtSeconds: number;
    expiresAtMs: number;
}
export declare class WebRtcAutoConnectPolicy {
    private readonly preferredRanks;
    private readonly cooldowns;
    private readonly failureStreaks;
    constructor(preferredPeers: readonly string[]);
    /**
     * Replace the preferred identities (compressed or x-only hex; either parity
     * matches). Returns the x-only keys that became preferred, whose earlier
     * failure cooldowns no longer apply.
     */
    setPreferredPeers(peers: readonly string[]): string[];
    partitionByInitiator<T extends AutoConnectCandidate>(candidates: T[], localXOnlyPubkey: string, acceptsConnections: boolean): {
        outbound: T[];
        inbound: T[];
    };
    sort<T extends AutoConnectCandidate>(candidates: T[], attempts: ReadonlyMap<string, number>, nowMs?: number): T[];
    isPreferred(remote: string): boolean;
    /**
     * `attributable` is false while this node itself has no working link: such
     * failures say nothing about the remote and must not extend its cooldown.
     */
    recordFailure(remote: string, awaitingSessionRecovery: boolean, attributable?: boolean): void;
    /** A connected carrier ends the failure streak. */
    recordSuccess(remote: string): void;
    /** A newer advert proves the peer is alive: forget its failures and cooldown. */
    advertRefreshed(remote: string): boolean;
    cooldownUntil(remote: string): number;
    pruneCooldowns(now: number): void;
    recoverSession(remote: string): boolean;
    clearCooldowns(): void;
    shouldReserveSlot(cachedPeers: Iterable<string>, ...activePeerSets: Iterable<string>[]): boolean;
    connectionLimit(maximum: number, reservePreferredSlot: boolean, remote: string): number;
    private rank;
}
export {};
//# sourceMappingURL=WebRtcAutoConnectPolicy.d.ts.map