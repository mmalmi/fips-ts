import { describe, expect, it } from "vitest";

import {
  FipsNode,
  generateIdentity,
  toHex,
  type SessionDatagram,
} from "@fips/core";

import { MemoryHub, MemoryTransport } from "../src/index.js";

describe("FipsNode route safety", () => {
  it("does not send an unknown destination to the first established peer", async () => {
    const [a, b, c, unknown] = await Promise.all([
      generateIdentity(),
      generateIdentity(),
      generateIdentity(),
      generateIdentity(),
    ]);
    const hub = new MemoryHub();
    const aNode = new FipsNode({
      identity: a,
      transports: [new MemoryTransport({ hub })],
    });
    const bNode = new FipsNode({
      identity: b,
      transports: [new MemoryTransport({ hub })],
    });
    const cNode = new FipsNode({
      identity: c,
      transports: [new MemoryTransport({ hub })],
    });

    await aNode.start();
    await bNode.start();
    await cNode.start();
    try {
      await aNode.connect({ transport: "memory", addr: toHex(b.publicKey) });
      await aNode.connect({ transport: "memory", addr: toHex(c.publicKey) });

      const datagram: SessionDatagram = {
        ttl: 64,
        pathMtu: 1200,
        srcAddr: a.nodeAddr,
        destAddr: unknown.nodeAddr,
        payload: new Uint8Array([1, 2, 3]),
      };
      const sendSessionDatagram = (
        aNode as unknown as {
          routing: { sendSessionDatagram(value: SessionDatagram): Promise<void> };
        }
      ).routing.sendSessionDatagram.bind(
        (aNode as unknown as { routing: unknown }).routing,
      );

      await expect(sendSessionDatagram(datagram)).rejects.toThrow(
        `no route to ${toHex(unknown.nodeAddr)}`,
      );
    } finally {
      await aNode.stop();
      await bNode.stop();
      await cNode.stop();
    }
  });
});
