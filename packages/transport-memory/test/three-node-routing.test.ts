import { describe, expect, it } from "vitest";

import { FipsNode, generateIdentity, toHex } from "@fips/core";

import { MemoryHub, MemoryTransport } from "../src/index.js";

describe("Three-node FIPS routing (A - B - C) over MemoryTransport", () => {
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
