import { exportIdentity, generateIdentity, importIdentity, } from "@fips/core";
const STORE_NAME = "fips-identity";
const KEY_NAME = "default";
export class IndexedDbIdentityStore {
    dbName;
    constructor(dbName = "fips") {
        this.dbName = dbName;
    }
    async getOrCreateIdentity() {
        const existing = await this.load();
        if (existing)
            return existing;
        const id = await generateIdentity();
        await this.save(id);
        return id;
    }
    async importNsec(secretKeyHex) {
        const id = await importIdentity({
            type: "fips-identity-v1",
            secretKeyHex,
        });
        await this.save(id);
    }
    async exportNsec() {
        const id = await this.load();
        if (!id)
            throw new Error("no identity to export");
        return exportIdentity(id).secretKeyHex;
    }
    openDb() {
        return new Promise((resolve, reject) => {
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
    async load() {
        const db = await this.openDb();
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, "readonly");
                const store = tx.objectStore(STORE_NAME);
                const req = store.get(KEY_NAME);
                req.onsuccess = async () => {
                    const data = req.result;
                    if (!data)
                        return resolve(null);
                    resolve(await importIdentity({
                        type: "fips-identity-v1",
                        secretKeyHex: data.secretKeyHex,
                    }));
                };
                req.onerror = () => reject(req.error);
            });
        }
        finally {
            db.close();
        }
    }
    async save(id) {
        const db = await this.openDb();
        try {
            await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, "readwrite");
                const store = tx.objectStore(STORE_NAME);
                store.put(exportIdentity(id), KEY_NAME);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }
        finally {
            db.close();
        }
    }
}
//# sourceMappingURL=IndexedDbIdentityStore.js.map