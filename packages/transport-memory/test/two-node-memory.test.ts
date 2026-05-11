import { describe, expect, it } from "vitest";

import { FipsNode, generateIdentity, toHex } from "@fips/core";

import { MemoryHub, MemoryTransport } from "../src/index.js";

describe("Two-node FIPS over MemoryTransport", () => {
  it("FMP handshake + FSP session + service-port echo", async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    const hub = new MemoryHub();

    const aNode = new FipsNode({
      identity: a,
      transports: [new MemoryTransport({ hub })],
    });
    const bNode = new FipsNode({
      identity: b,
      transports: [new MemoryTransport({ hub })],
    });

    bNode.registerService(9000, async ({ payload, reply }) => {
      await reply(payload);
    });

    await aNode.start();
    await bNode.start();
    try {
      await aNode.connect({ transport: "memory", addr: toHex(b.publicKey) });

      const reply = await new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 5000);
        const off = aNode.on("datagram", (evt) => {
          const dg = evt as { dstPort: number; payload: Uint8Array };
          if (dg.dstPort === 9000) {
            clearTimeout(timer);
            off();
            resolve(dg.payload);
          }
        });
        void aNode.sendDatagram({
          dst: toHex(b.publicKey),
          srcPort: 9000,
          dstPort: 9000,
          payload: new TextEncoder().encode("hello"),
        });
      });

      expect(new TextDecoder().decode(reply)).toBe("hello");
    } finally {
      await aNode.stop();
      await bNode.stop();
    }
  });
});
