import { toHex } from "@fips/core";

import type { LocalLikeStore } from "../src/FipsHashtreeStore.js";

export class MemoryStore implements LocalLikeStore {
  private readonly map = new Map<string, Uint8Array>();

  async get(hash: Uint8Array): Promise<Uint8Array | null> {
    return this.map.get(toHex(hash)) ?? null;
  }

  async put(hash: Uint8Array, data: Uint8Array): Promise<boolean> {
    const key = toHex(hash);
    const fresh = !this.map.has(key);
    this.map.set(key, data);
    return fresh;
  }

  async has(hash: Uint8Array): Promise<boolean> {
    return this.map.has(toHex(hash));
  }

  async delete(hash: Uint8Array): Promise<boolean> {
    return this.map.delete(toHex(hash));
  }
}
