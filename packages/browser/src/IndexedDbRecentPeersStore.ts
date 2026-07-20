import {
  createRecentPeers,
  parseRecentPeers,
  type RecentPeers,
} from "@fips/core";

export const DEFAULT_RECENT_PEERS_DB_NAME = "fips-recent-peers";

const DB_VERSION = 1;
const STORE_NAME = "recent-peers";

export interface RecentPeersStore {
  load(localNpub: string, scope: string): Promise<RecentPeers>;
  save(recentPeers: RecentPeers): Promise<void>;
  clear(localNpub: string, scope: string): Promise<void>;
}

/**
 * Stores reconnect hints separately from durable FIPS identity material.
 * Loaded entries remain untrusted hints; callers must apply admission policy.
 */
export class IndexedDbRecentPeersStore implements RecentPeersStore {
  private readonly dbName: string;

  constructor(dbName = DEFAULT_RECENT_PEERS_DB_NAME) {
    this.dbName = dbName;
  }

  async load(localNpub: string, scope: string): Promise<RecentPeers> {
    const empty = createRecentPeers(localNpub, scope);
    const db = await this.openDb();
    try {
      return await new Promise<RecentPeers>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get([localNpub, scope]);
        req.onsuccess = () => {
          try {
            resolve(req.result === undefined
              ? empty
              : parseRecentPeers(req.result, localNpub, scope));
          } catch (error) {
            reject(error);
          }
        };
        req.onerror = () => reject(req.error);
        tx.onabort = () => reject(tx.error ?? new Error("recent peers transaction aborted"));
      });
    } finally {
      db.close();
    }
  }

  async save(recentPeers: RecentPeers): Promise<void> {
    const validated = parseRecentPeers(
      recentPeers,
      recentPeers.local_npub,
      recentPeers.scope,
    );
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(validated);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("recent peers transaction aborted"));
      });
    } finally {
      db.close();
    }
  }

  async clear(localNpub: string, scope: string): Promise<void> {
    createRecentPeers(localNpub, scope);
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete([localNpub, scope]);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("recent peers transaction aborted"));
      });
    } finally {
      db.close();
    }
  }

  private openDb(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, {
            keyPath: ["local_npub", "scope"],
          });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}
