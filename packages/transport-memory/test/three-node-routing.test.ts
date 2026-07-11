import { describe, expect, it } from "vitest";

import {
  FipsNode,
  generateIdentity,
  identityFromSecretKey,
  nodeAddrToHex,
  toHex,
  type NodeAddr,
} from "@fips/core";

import { MemoryHub, MemoryTransport } from "../src/index.js";

describe("Three-node FIPS routing (A - B - C) over MemoryTransport", () => {
  it("converges tree coordinates and routes both ways without default routes", async () => {
    const a = await identityFromSecretKey(new Uint8Array(32).fill(0x61));
    const b = await identityFromSecretKey(new Uint8Array(32).fill(0x62));
    const c = await identityFromSecretKey(new Uint8Array(32).fill(0x63));
    const hub = new MemoryHub();
    const aNode = new FipsNode({ identity: a, transports: [new MemoryTransport({ hub })] });
    const bNode = new FipsNode({
      identity: b,
      transports: [new MemoryTransport({ hub })],
      forwarding: true,
    });
    const cNode = new FipsNode({ identity: c, transports: [new MemoryTransport({ hub })] });
    cNode.registerService(9_001, async ({ payload, reply }) => reply(payload));

    await Promise.all([aNode.start(), bNode.start(), cNode.start()]);
    try {
      await aNode.connect({ transport: "memory", addr: toHex(b.publicKey) });
      await bNode.connect({ transport: "memory", addr: toHex(c.publicKey) });
      const internals = (node: FipsNode) => node as unknown as {
        treeState: { coords: NodeAddr[]; root: NodeAddr };
        coordCache: Map<string, NodeAddr[]>;
      };
      await expect.poll(() => {
        const roots = [aNode, bNode, cNode].map((node) => nodeAddrToHex(internals(node).treeState.root));
        return new Set(roots).size;
      }).toBe(1);
      internals(aNode).coordCache.set(nodeAddrToHex(c.nodeAddr), internals(cNode).treeState.coords);

      const response = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("tree route timeout")), 5_000);
        aNode.on("datagram", (event) => {
          const datagram = event as { src: string; payload: Uint8Array };
          if (datagram.src !== toHex(c.publicKey)) return;
          clearTimeout(timer);
          resolve(new TextDecoder().decode(datagram.payload));
        });
      });
      await aNode.sendDatagram({
        dst: toHex(c.publicKey),
        srcPort: 9_001,
        dstPort: 9_001,
        payload: new TextEncoder().encode("tree-routed"),
      });
      await expect(response).resolves.toBe("tree-routed");
    } finally {
      await Promise.all([aNode.stop(), bNode.stop(), cNode.stop()]);
    }
  });

  it("A sends to C via forwarding B; C reply returns to A", async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    const c = await generateIdentity();
    const hub = new MemoryHub();

    const aNode = new FipsNode({
      identity: a,
      transports: [new MemoryTransport({ hub })],
      forwarding: false,
      defaultRoute: toHex(b.publicKey),
    });
    const bNode = new FipsNode({
      identity: b,
      transports: [new MemoryTransport({ hub })],
      forwarding: true,
    });
    const cNode = new FipsNode({
      identity: c,
      transports: [new MemoryTransport({ hub })],
      forwarding: false,
      defaultRoute: toHex(b.publicKey),
    });

    let bSawAppPayload = false;
    bNode.on("datagram", () => {
      bSawAppPayload = true;
    });
    cNode.registerService(9000, async ({ payload, reply }) => {
      await reply(payload);
    });

    await aNode.start();
    await bNode.start();
    await cNode.start();
    try {
      // Adjacency: A↔B and B↔C but NOT A↔C.
      await aNode.connect({ transport: "memory", addr: toHex(b.publicKey) });
      await bNode.connect({ transport: "memory", addr: toHex(c.publicKey) });

      const reply = await new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 5000);
        const off = aNode.on("datagram", (evt) => {
          const dg = evt as { src: string; dstPort: number; payload: Uint8Array };
          if (dg.src === toHex(c.publicKey) && dg.dstPort === 9000) {
            clearTimeout(timer);
            off();
            resolve(dg.payload);
          }
        });
        void aNode.sendDatagram({
          dst: toHex(c.publicKey),
          srcPort: 9000,
          dstPort: 9000,
          payload: new TextEncoder().encode("via-B"),
        });
      });

      expect(new TextDecoder().decode(reply)).toBe("via-B");
      expect(bSawAppPayload).toBe(false);
    } finally {
      await aNode.stop();
      await bNode.stop();
      await cNode.stop();
    }
  });
});
