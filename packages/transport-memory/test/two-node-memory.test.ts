import { describe, expect, it } from "vitest";

import {
  FipsNode,
  generateIdentity,
  identityFromSecretKey,
  toHex,
  type Logger,
} from "@fips/core";

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

  it("carries endpoint data without service ports", async () => {
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

    await aNode.start();
    await bNode.start();
    try {
      await aNode.connect({ transport: "memory", addr: toHex(b.publicKey) });

      const received = await new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 5000);
        const off = bNode.on("endpointData", (evt) => {
          const msg = evt as { src: string; payload: Uint8Array };
          if (msg.src === toHex(a.publicKey)) {
            clearTimeout(timer);
            off();
            resolve(msg.payload);
          }
        });
        void aNode.sendEndpointData({
          dst: toHex(b.publicKey),
          payload: new TextEncoder().encode("hashtree over fips"),
        });
      });

      expect(new TextDecoder().decode(received)).toBe("hashtree over fips");
    } finally {
      await aNode.stop();
      await bNode.stop();
    }
  });

  it("keeps endpoint data flowing after simultaneous FSP session setup", async () => {
    const a = await identityFromSecretKey(new Uint8Array(32).fill(0x32));
    const b = await identityFromSecretKey(new Uint8Array(32).fill(0x76));
    const hub = new MemoryHub();
    const debugMessages: string[] = [];
    const logger: Logger = {
      debug: (message) => debugMessages.push(String(message)),
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    const aNode = new FipsNode({
      identity: a,
      transports: [new MemoryTransport({ hub })],
      routingMode: "reply_learned",
      logger,
    });
    const bNode = new FipsNode({
      identity: b,
      transports: [new MemoryTransport({ hub })],
      routingMode: "reply_learned",
      logger,
    });

    await Promise.all([aNode.start(), bNode.start()]);
    try {
      await aNode.connect({ transport: "memory", addr: toHex(b.publicKey) });
      const receivedByA: string[] = [];
      const receivedByB: string[] = [];
      aNode.on("endpointData", (event) => {
        receivedByA.push(new TextDecoder().decode((event as { payload: Uint8Array }).payload));
      });
      bNode.on("endpointData", (event) => {
        receivedByB.push(new TextDecoder().decode((event as { payload: Uint8Array }).payload));
      });

      await Promise.all([
        aNode.sendEndpointData({
          dst: toHex(b.publicKey),
          payload: new TextEncoder().encode("a-first"),
        }),
        bNode.sendEndpointData({
          dst: toHex(a.publicKey),
          payload: new TextEncoder().encode("b-first"),
        }),
      ]);
      await Promise.all([
        aNode.sendEndpointData({
          dst: toHex(b.publicKey),
          payload: new TextEncoder().encode("a-second"),
        }),
        bNode.sendEndpointData({
          dst: toHex(a.publicKey),
          payload: new TextEncoder().encode("b-second"),
        }),
      ]);

      await expect.poll(() => receivedByA).toEqual(["b-first", "b-second"]);
      await expect.poll(() => receivedByB).toEqual(["a-first", "a-second"]);
      expect(debugMessages).toContain("simultaneous FSP handshake: local initiator wins");
      expect(debugMessages).toContain("simultaneous FSP handshake: remote initiator wins");
    } finally {
      await Promise.all([aNode.stop(), bNode.stop()]);
    }
  });
});
