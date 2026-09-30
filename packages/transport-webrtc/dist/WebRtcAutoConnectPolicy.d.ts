import type { DiscoveredPeer } from "@fips/core";
interface AutoConnectCandidate {
    peer: DiscoveredPeer;
    expiresAtMs: number;
}
export declare class WebRtcAutoConnectPolicy {
    private readonly preferredRanks;
    private readonly cooldowns;
    constructor(preferredPeers: string[]);
    partitionByInitiator<T extends AutoConnectCandidate>(candidates: T[], localXOnlyPubkey: string, acceptsConnections: boolean): {
        outbound: T[];
        inbound: T[];
    };
    sort<T extends AutoConnectCandidate>(candidates: T[], attempts: ReadonlyMap<string, number>): T[];
    isPreferred(remote: string): boolean;
    recordFailure(remote: string, awaitingSessionRecovery: boolean): void;
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