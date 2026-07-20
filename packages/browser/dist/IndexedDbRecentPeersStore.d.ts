import { type RecentPeers } from "@fips/core";
export declare const DEFAULT_RECENT_PEERS_DB_NAME = "fips-recent-peers";
export interface RecentPeersStore {
    load(localNpub: string, scope: string): Promise<RecentPeers>;
    save(recentPeers: RecentPeers): Promise<void>;
    clear(localNpub: string, scope: string): Promise<void>;
}
/**
 * Stores reconnect hints separately from durable FIPS identity material.
 * Loaded entries remain untrusted hints; callers must apply admission policy.
 */
export declare class IndexedDbRecentPeersStore implements RecentPeersStore {
    private readonly dbName;
    constructor(dbName?: string);
    load(localNpub: string, scope: string): Promise<RecentPeers>;
    save(recentPeers: RecentPeers): Promise<void>;
    clear(localNpub: string, scope: string): Promise<void>;
    private openDb;
}
//# sourceMappingURL=IndexedDbRecentPeersStore.d.ts.map