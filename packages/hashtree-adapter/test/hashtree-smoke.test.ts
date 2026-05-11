import { sha256 } from "@noble/hashes/sha256";

import { describe, expect, it } from "vitest";

import {
  FipsNode,
  bytesEqual,
  generateIdentity,
  toHex,
} from "@fips/core";
import { MemoryHub, MemoryTransport } from "@fips/transport-memory";

import { FipsHashtreeStore } from "../src/FipsHashtreeStore.js";
import { MemoryStore } from "./MemoryStore.js";

describe("Hashtree adapter smoke test (FIPS service port 7001)", () => {
  it("Browser C fetches a blob from Browser A by hash over FIPS", async () => {
    const aId = await generateIdentity();
    const cId = await generateIdentity();
    const hub = new MemoryHub();
    const aNode = new FipsNode({ identity: aId, transports: [new MemoryTransport({ hub })] });
    const cNode = new FipsNode({ identity: cId, transports: [new MemoryTransport({ hub })] });

    // A stores blob locally; C does not.
    const aStore = new MemoryStore();
    const blob = new TextEncoder().encode("the merkle tree is the territory");
    const hash = sha256(blob);
    await aStore.put(hash, blob);

    const aHashtree = new FipsHashtreeStore({ node: aNode, localStore: aStore, peers: [] });
    const cHashtree = new FipsHashtreeStore({
      node: cNode,
      localStore: new MemoryStore(),
      peers: [toHex(aId.publicKey)],
      requestTimeoutMs: 5_000,
    });

    await aNode.start();
    await cNode.start();
    try {
      await cNode.connect({ transport: "memory", addr: toHex(aId.publicKey) });
      const fetched = await cHashtree.get(hash);
      expect(fetched).not.toBeNull();
      expect(bytesEqual(fetched!, blob)).toBe(true);
      expect(bytesEqual(sha256(fetched!), hash)).toBe(true);
    } finally {
      aHashtree.stop();
      cHashtree.stop();
      await aNode.stop();
      await cNode.stop();
    }
  });
});
