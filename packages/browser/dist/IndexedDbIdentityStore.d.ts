import { type FipsIdentity } from "@fips/core";
export interface IdentityStore {
    getOrCreateIdentity(): Promise<FipsIdentity>;
    exportNsec?: () => Promise<string>;
    importNsec?: (nsec: string) => Promise<void>;
}
export declare class IndexedDbIdentityStore implements IdentityStore {
    private readonly dbName;
    constructor(dbName?: string);
    getOrCreateIdentity(): Promise<FipsIdentity>;
    importNsec(secretKeyHex: string): Promise<void>;
    exportNsec(): Promise<string>;
    private openDb;
    private load;
    private save;
}
//# sourceMappingURL=IndexedDbIdentityStore.d.ts.map