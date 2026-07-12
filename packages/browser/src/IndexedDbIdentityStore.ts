import {
  exportIdentity,
  generateIdentity,
  importIdentity,
  type FipsIdentity,
} from "@fips/core";

export interface IdentityStore {
  getOrCreateIdentity(): Promise<FipsIdentity>;
  exportNsec?: () => Promise<string>;
  importNsec?: (nsec: string) => Promise<void>;
}

const STORE_NAME = "fips-identity";
const KEY_NAME = "default";

export class IndexedDbIdentityStore implements IdentityStore {
  private readonly dbName: string;

  constructor(dbName = "fips") {
    this.dbName = dbName;
  }

  async getOrCreateIdentity(): Promise<FipsIdentity> {
    const candidate = await generateIdentity();
    const db = await this.openDb();
    try {
      const secretKeyHex = await new Promise<string>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(KEY_NAME);
        let selectedSecretKeyHex = exportIdentity(candidate).secretKeyHex;

        req.onsuccess = () => {
          const existing = req.result as { secretKeyHex: string } | undefined;
          if (existing) {
            selectedSecretKeyHex = existing.secretKeyHex;
          } else {
            store.put(exportIdentity(candidate), KEY_NAME);
          }
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => resolve(selectedSecretKeyHex);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("identity transaction aborted"));
      });
      return await importIdentity({
        type: "fips-identity-v1",
        secretKeyHex,
      });
    } finally {
      db.close();
    }
  }

  async importNsec(secretKeyHex: string): Promise<void> {
    const id = await importIdentity({
      type: "fips-identity-v1",
      secretKeyHex,
    });
    await this.save(id);
  }

  async exportNsec(): Promise<string> {
    const id = await this.load();
    if (!id) throw new Error("no identity to export");
    return exportIdentity(id).secretKeyHex;
  }

  private openDb(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async load(): Promise<FipsIdentity | null> {
    const db = await this.openDb();
    try {
      return await new Promise<FipsIdentity | null>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(KEY_NAME);
        req.onsuccess = async () => {
          const data = req.result as { secretKeyHex: string } | undefined;
          if (!data) return resolve(null);
          resolve(
            await importIdentity({
              type: "fips-identity-v1",
              secretKeyHex: data.secretKeyHex,
            }),
          );
        };
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  private async save(id: FipsIdentity): Promise<void> {
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.put(exportIdentity(id), KEY_NAME);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
}
