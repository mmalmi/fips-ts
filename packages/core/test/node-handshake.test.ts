import { describe, expect, it } from "vitest";

import {
  FipsNode,
  FMP_PHASE_MSG1,
  identityFromSecretKey,
  toHex,
  type Transport,
  type TransportAddress,
  type TransportContext,
} from "../src/index.js";

const memoryRegistry = new Map<string, FlakyMemoryTransport>();

class FlakyMemoryTransport implements Transport {
  readonly type = "memory";
  readonly mtu = 1200;

  private ctx: TransportContext | null = null;
  private localAddr = "";
  dropFirstMsg1 = false;
  sentMsg1 = 0;
  droppedMsg1 = 0;

  async start(ctx: TransportContext): Promise<void> {
    this.ctx = ctx;
    this.localAddr = toHex(ctx.localIdentity.publicKey);
    memoryRegistry.set(this.localAddr, this);
  }

  async stop(): Promise<void> {
    memoryRegistry.delete(this.localAddr);
    this.ctx = null;
    this.localAddr = "";
  }

  async connect(addr: TransportAddress): Promise<void> {
    this.ctx?.onConnectionState?.({ remoteAddr: addr, state: "connected" });
  }

  async send(addr: TransportAddress, packet: Uint8Array): Promise<void> {
    if (packet[0] === FMP_PHASE_MSG1) {
      this.sentMsg1 += 1;
      if (this.dropFirstMsg1 && this.droppedMsg1 === 0) {
        this.droppedMsg1 += 1;
        return;
      }
    }
    const remote = memoryRegistry.get(addr.addr);
    if (!remote?.ctx) {
      throw new Error(`memory peer not found: ${addr.addr}`);
    }
    remote.ctx.onPacket({
      transportType: this.type,
      remoteAddr: { transport: this.type, addr: this.localAddr },
      data: packet,
      receivedAtMs: Date.now(),
    });
  }
}

describe("FipsNode FMP handshake", () => {
  it("resends Msg1 so a dropped first WebRTC-style packet does not stall connect", async () => {
    const initiatorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0xa1));
    const responderIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0xb2));
    const initiatorTransport = new FlakyMemoryTransport();
    initiatorTransport.dropFirstMsg1 = true;
    const responderTransport = new FlakyMemoryTransport();
    const initiator = new FipsNode({
      identity: initiatorIdentity,
      transports: [initiatorTransport],
    });
    const responder = new FipsNode({
      identity: responderIdentity,
      transports: [responderTransport],
    });

    await responder.start();
    await initiator.start();
    try {
      await initiator.connect({
        transport: "memory",
        addr: toHex(responderIdentity.publicKey),
      });
      expect(initiatorTransport.droppedMsg1).toBe(1);
      expect(initiatorTransport.sentMsg1).toBeGreaterThanOrEqual(2);
    } finally {
      await initiator.stop();
      await responder.stop();
    }
  });
});
