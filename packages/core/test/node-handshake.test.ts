import { describe, expect, it, vi } from "vitest";

import {
  FipsNode,
  FMP_PHASE_MSG1,
  identityFromSecretKey,
  isDirectFspTransportFragment,
  toHex,
  type Transport,
  type TransportAddress,
  type TransportContext,
} from "../src/index.js";

const memoryRegistry = new Map<string, FlakyMemoryTransport>();

class FlakyMemoryTransport implements Transport {
  readonly type = "memory";
  readonly mtu: number;

  private ctx: TransportContext | null = null;
  private localAddr = "";
  dropFirstMsg1 = false;
  sentMsg1 = 0;
  droppedMsg1 = 0;
  sentPackets = 0;
  directFragments = 0;

  constructor(mtu = 1200) {
    this.mtu = mtu;
  }

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
    if (packet.length > this.mtu) {
      throw new Error(`memory packet ${packet.length} exceeds MTU ${this.mtu}`);
    }
    this.sentPackets += 1;
    if (isDirectFspTransportFragment(packet)) this.directFragments += 1;
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

  it("sends authenticated heartbeats after the adjacent link is established", async () => {
    vi.useFakeTimers();
    const initiatorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0xc1));
    const responderIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0xd2));
    const initiatorTransport = new FlakyMemoryTransport();
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
      const initiatorBaseline = initiatorTransport.sentPackets;
      const responderBaseline = responderTransport.sentPackets;

      await vi.advanceTimersByTimeAsync(5_000);

      expect(initiatorTransport.sentPackets).toBeGreaterThan(initiatorBaseline);
      expect(responderTransport.sentPackets).toBeGreaterThan(responderBaseline);
    } finally {
      await initiator.stop();
      await responder.stop();
      vi.useRealTimers();
    }
  });

  it("segments oversized direct FSP service requests and replies", async () => {
    const initiatorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0xe1));
    const responderIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0xf2));
    const initiatorTransport = new FlakyMemoryTransport(1_200);
    const responderTransport = new FlakyMemoryTransport(1_200);
    const initiator = new FipsNode({
      identity: initiatorIdentity,
      transports: [initiatorTransport],
    });
    const responder = new FipsNode({
      identity: responderIdentity,
      transports: [responderTransport],
    });
    const request = new Uint8Array(5_000).map((_, index) => index & 0xff);
    const reply = new Uint8Array(4_000).map((_, index) => (255 - index) & 0xff);
    let resolveReply: (payload: Uint8Array) => void = () => {};
    const receivedReply = new Promise<Uint8Array>((resolve) => {
      resolveReply = resolve;
    });
    initiator.registerService(5_000, (context) => resolveReply(context.payload));
    responder.registerService(4_242, async (context) => {
      expect(context.payload).toEqual(request);
      await context.reply(reply);
    });

    await responder.start();
    await initiator.start();
    try {
      await initiator.connect({
        transport: "memory",
        addr: toHex(responderIdentity.publicKey),
      });
      await initiator.sendDatagram({
        dst: toHex(responderIdentity.publicKey),
        srcPort: 5_000,
        dstPort: 4_242,
        payload: request,
      });

      const response = await Promise.race([
        receivedReply,
        new Promise<undefined>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (!response) throw new Error("direct FSP reply timed out");
      expect(response).toEqual(reply);
      expect(initiatorTransport.directFragments).toBeGreaterThan(1);
      expect(responderTransport.directFragments).toBeGreaterThan(1);
    } finally {
      await initiator.stop();
      await responder.stop();
    }
  }, 10_000);
});
