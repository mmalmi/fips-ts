import { describe, expect, it, vi } from "vitest";

import {
  FMP_PHASE_MSG2,
  FipsNode,
  FspSession,
  FmpLink,
  FMP_PHASE_MSG1,
  LinkMessageType,
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
  dropNextMsg2 = false;
  capturedMsg2?: Uint8Array;

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

  disconnect(addr: TransportAddress): void {
    this.ctx?.onConnectionState?.({ remoteAddr: addr, state: "disconnected" });
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
    if (packet[0] === FMP_PHASE_MSG2 && this.dropNextMsg2) {
      this.dropNextMsg2 = false;
      this.capturedMsg2 = new Uint8Array(packet);
      return;
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
  it("forgets disconnected peers' tree state before reconnect", async () => {
    const identityA = await identityFromSecretKey(new Uint8Array(32).fill(0x11));
    const identityB = await identityFromSecretKey(new Uint8Array(32).fill(0x22));
    const transportA = new FlakyMemoryTransport();
    const transportB = new FlakyMemoryTransport();
    const nodeA = new FipsNode({ identity: identityA, transports: [transportA] });
    const nodeB = new FipsNode({ identity: identityB, transports: [transportB] });
    const addressB = { transport: "memory", addr: toHex(identityB.publicKey) };

    await nodeA.start();
    await nodeB.start();
    try {
      await nodeA.connect(addressB);
      await vi.waitFor(() => {
        expect((nodeA as any).routing.treeState.peers.size).toBe(1);
      });

      transportA.disconnect(addressB);

      expect((nodeA as any).routing.treeState.peers.size).toBe(0);
    } finally {
      await nodeA.stop();
      await nodeB.stop();
    }
  });

  it("resolves simultaneous adjacent handshakes and keeps bidirectional service traffic", async () => {
    const identityA = await identityFromSecretKey(new Uint8Array(32).fill(0x21));
    const identityB = await identityFromSecretKey(new Uint8Array(32).fill(0x42));
    const transportA = new FlakyMemoryTransport();
    const transportB = new FlakyMemoryTransport();
    const nodeA = new FipsNode({ identity: identityA, transports: [transportA] });
    const nodeB = new FipsNode({ identity: identityB, transports: [transportB] });
    const errors: Error[] = [];
    const received: number[] = [];
    nodeA.on("error", (event) => errors.push((event as { err: Error }).err));
    nodeB.on("error", (event) => errors.push((event as { err: Error }).err));
    nodeA.registerService(7_301, ({ payload }) => received.push(payload[0]));
    nodeB.registerService(7_302, ({ payload }) => received.push(payload[0]));

    await nodeA.start();
    await nodeB.start();
    try {
      await Promise.all([
        nodeA.connect({ transport: "memory", addr: toHex(identityB.publicKey) }),
        nodeB.connect({ transport: "memory", addr: toHex(identityA.publicKey) }),
      ]);
      await Promise.all([
        nodeA.sendDatagram({
          dst: toHex(identityB.publicKey),
          dstPort: 7_302,
          payload: new Uint8Array([0xa2]),
        }),
        nodeB.sendDatagram({
          dst: toHex(identityA.publicKey),
          dstPort: 7_301,
          payload: new Uint8Array([0xb1]),
        }),
      ]);

      expect(errors).toEqual([]);
      expect(received.sort((a, b) => a - b)).toEqual([0xa2, 0xb1]);
    } finally {
      await nodeA.stop();
      await nodeB.stop();
    }
  }, 10_000);

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

  it("accepts a fresh authenticated Msg1 when an established initiator restarts", async () => {
    const initiatorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x71));
    const responderIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x82));
    const firstTransport = new FlakyMemoryTransport();
    const responderTransport = new FlakyMemoryTransport();
    const firstNode = new FipsNode({
      identity: initiatorIdentity,
      transports: [firstTransport],
    });
    const responder = new FipsNode({
      identity: responderIdentity,
      transports: [responderTransport],
    });
    const errors: Error[] = [];
    responder.on("error", (event) => errors.push((event as { err: Error }).err));
    let received: Uint8Array | undefined;
    responder.registerService(7_171, ({ payload }) => {
      received = payload;
    });

    await responder.start();
    await firstNode.start();
    try {
      const responderAddr = {
        transport: "memory",
        addr: toHex(responderIdentity.publicKey),
      };
      await firstNode.connect(responderAddr);
      await firstNode.stop();

      const restartedTransport = new FlakyMemoryTransport();
      const restartedNode = new FipsNode({
        identity: initiatorIdentity,
        transports: [restartedTransport],
      });
      await restartedNode.start();
      try {
        await restartedNode.connect(responderAddr);
        await restartedNode.sendDatagram({
          dst: toHex(responderIdentity.publicKey),
          dstPort: 7_171,
          payload: new Uint8Array([7, 1, 7, 1]),
        });

        expect(errors).toEqual([]);
        expect(received).toEqual(new Uint8Array([7, 1, 7, 1]));
      } finally {
        await restartedNode.stop();
      }
    } finally {
      await firstNode.stop();
      await responder.stop();
    }
  }, 10_000);

  it("keeps a replacement link when the retired startup epoch is replayed in either direction", async () => {
    const survivorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x11));
    const restartedIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x12));
    const survivorTransport = new FlakyMemoryTransport();
    const originalTransport = new FlakyMemoryTransport();
    const survivor = new FipsNode({
      identity: survivorIdentity,
      transports: [survivorTransport],
    });
    const original = new FipsNode({
      identity: restartedIdentity,
      transports: [originalTransport],
    });
    const errors: Error[] = [];
    survivor.on("error", (event) => errors.push((event as { err: Error }).err));
    const restartedAddr = {
      transport: "memory",
      addr: toHex(restartedIdentity.publicKey),
    };

    await original.start();
    await survivor.start();
    try {
      await survivor.connect(restartedAddr);
      const originalEpoch = new Uint8Array((original as any).startupEpoch);
      await original.stop();

      const replacementTransport = new FlakyMemoryTransport();
      const replacement = new FipsNode({
        identity: restartedIdentity,
        transports: [replacementTransport],
      });
      await replacement.start();
      try {
        await replacement.connect({
          transport: "memory",
          addr: toHex(survivorIdentity.publicKey),
        });
        const survivorPeer = [...(survivor as any).peers.values()][0];
        expect(survivorPeer.pendingResponderLink).toBeUndefined();
        expect(survivorPeer.link.role).toBe("responder");
        expect(survivorPeer.link.remoteEpoch).toEqual((replacement as any).startupEpoch);

        const replay = new FmpLink({
          identity: restartedIdentity,
          remotePubkey: survivorIdentity.publicKey,
          role: "initiator",
          sessionIdx: 0x6262,
          localEpoch: originalEpoch,
        });
        (survivor as any).packetProcessor.process(survivorTransport, {
          transportType: "memory",
          remoteAddr: { transport: "memory", addr: toHex(restartedIdentity.publicKey) },
          data: replay.buildMsg1((length) => new Uint8Array(length)).packet,
          receivedAtMs: Date.now(),
        });
        await Promise.resolve();

        expect(errors).toEqual([]);
        expect(survivorPeer.pendingResponderLink).toBeUndefined();
        expect(survivorPeer.link.remoteEpoch).toEqual((replacement as any).startupEpoch);

        const staleOutbound = new FmpLink({
          identity: survivorIdentity,
          remotePubkey: restartedIdentity.publicKey,
          role: "initiator",
          sessionIdx: 0x6363,
          localEpoch: (survivor as any).startupEpoch,
        });
        const staleResponder = new FmpLink({
          identity: restartedIdentity,
          role: "responder",
          sessionIdx: 0x6464,
          localEpoch: originalEpoch,
        });
        const staleMsg1 = staleOutbound.buildMsg1(
          (length) => new Uint8Array(length).fill(0x63),
        );
        const staleMsg2 = staleResponder.handleMsg1(
          staleMsg1.packet,
          (length) => new Uint8Array(length).fill(0x64),
        );
        const stalePeer = {
          pubkey: restartedIdentity.publicKey,
          pubkeyHex: toHex(restartedIdentity.publicKey),
          remoteAddr: { transport: "memory", addr: "retired-epoch-alias" },
          transport: survivorTransport,
          link: staleOutbound,
          outgoingHandshake: { resolve: () => {}, reject: () => {} },
        };
        (survivor as any).peers.set("retired-epoch-alias", stalePeer);
        (survivor as any).rememberPeer(stalePeer);
        (survivor as any).packetProcessor.process(survivorTransport, {
          transportType: "memory",
          remoteAddr: stalePeer.remoteAddr,
          data: staleMsg2.reply!,
          receivedAtMs: Date.now(),
        });
        await Promise.resolve();

        expect(errors).toEqual([]);
        expect(survivorPeer.link.remoteEpoch).toEqual((replacement as any).startupEpoch);
        expect((survivor as any).peersByPubkey.get(stalePeer.pubkeyHex)).toBe(survivorPeer);
        expect([...(survivor as any).peers.values()]).not.toContain(stalePeer);
      } finally {
        await replacement.stop();
      }
    } finally {
      await survivor.stop();
      await original.stop();
    }
  }, 10_000);

  it("drains the old receiver index until a replacement sends authenticated traffic", async () => {
    const initiatorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x91));
    const responderIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0xa2));
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
    const errors: Error[] = [];
    responder.on("error", (event) => errors.push((event as { err: Error }).err));

    await responder.start();
    await initiator.start();
    try {
      const responderAddr = {
        transport: "memory",
        addr: toHex(responderIdentity.publicKey),
      };
      await initiator.connect(responderAddr);
      const initiatorPeer = [...(initiator as any).peers.values()][0];
      const responderPeer = [...(responder as any).peers.values()][0];
      const oldResponderIndex = responderPeer.link.localSessionIdx;
      const oldFrame = initiatorPeer.link.encryptOutgoing(
        new Uint8Array(0),
        LinkMessageType.Heartbeat,
      );

      const replacement = new FmpLink({
        identity: initiatorIdentity,
        remotePubkey: responderIdentity.publicKey,
        role: "initiator",
        sessionIdx: 0x5151,
        localEpoch: (initiator as any).startupEpoch,
      });
      responderTransport.dropNextMsg2 = true;
      (responder as any).packetProcessor.process(responderTransport, {
        transportType: "memory",
        remoteAddr: { transport: "memory", addr: toHex(initiatorIdentity.publicKey) },
        data: replacement.buildMsg1((length) => new Uint8Array(length)).packet,
        receivedAtMs: Date.now(),
      });
      await Promise.resolve();

      expect(responderPeer.link.localSessionIdx).toBe(oldResponderIndex);
      expect(responderPeer.pendingResponderLink).toBeDefined();
      await initiatorTransport.send(responderAddr, oldFrame);
      expect(errors).toEqual([]);
      expect(responderPeer.link.localSessionIdx).toBe(oldResponderIndex);

      replacement.handleMsg2(responderTransport.capturedMsg2!);
      await initiatorTransport.send(
        responderAddr,
        replacement.encryptOutgoing(new Uint8Array(0), LinkMessageType.Heartbeat),
      );
      expect(errors).toEqual([]);
      expect(responderPeer.link.localSessionIdx).not.toBe(oldResponderIndex);
      expect(responderPeer.pendingResponderLink).toBeUndefined();
    } finally {
      await initiator.stop();
      await responder.stop();
    }
  }, 10_000);

  it("drains an established responder displaced by an address alias", async () => {
    const replacementIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0xb1));
    const survivorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0xb2));
    const replacementTransport = new FlakyMemoryTransport();
    const survivorTransport = new FlakyMemoryTransport();
    const replacement = new FipsNode({
      identity: replacementIdentity,
      transports: [replacementTransport],
    });
    const survivor = new FipsNode({
      identity: survivorIdentity,
      transports: [survivorTransport],
    });

    await replacement.start();
    await survivor.start();
    try {
      await survivor.connect({
        transport: "memory",
        addr: toHex(replacementIdentity.publicKey),
      });
      const displaced = [...(replacement as any).peers.values()][0];
      const displacedReceiverIdx = displaced.link.localSessionIdx;

      const replacementLink = new FmpLink({
        identity: replacementIdentity,
        remotePubkey: survivorIdentity.publicKey,
        role: "initiator",
        sessionIdx: 0xb1b1,
        localEpoch: new Uint8Array(8).fill(0xb1),
      });
      const remoteReplacementLink = new FmpLink({
        identity: survivorIdentity,
        role: "responder",
        sessionIdx: 0xb2b2,
        localEpoch: new Uint8Array(8).fill(0xb2),
      });
      const msg1 = replacementLink.buildMsg1((length) => new Uint8Array(length).fill(0x31));
      const msg2 = remoteReplacementLink.handleMsg1(
        msg1.packet,
        (length) => new Uint8Array(length).fill(0x32),
      );
      replacementLink.handleMsg2(msg2.reply!);
      const replacementPeer = {
        pubkey: survivorIdentity.publicKey,
        pubkeyHex: toHex(survivorIdentity.publicKey),
        remoteAddr: {
          transport: "memory",
          addr: toHex(survivorIdentity.publicKey),
        },
        transport: replacementTransport,
        link: replacementLink,
      };
      (replacement as any).peers.set("memory:replacement-alias", replacementPeer);

      (replacement as any).packetProcessor.retireDisplacedMsg2Peer(
        displaced.remoteAddr,
        replacementPeer,
      );

      expect(replacementPeer.drainingResponderLinks?.get(displacedReceiverIdx)?.link)
        .toBe(displaced.link);
      expect(displaced.link.state).toBe("established");
    } finally {
      await survivor.stop();
      await replacement.stop();
    }
  }, 10_000);

  it("sends authenticated heartbeats after the adjacent link is established", async () => {
    vi.useFakeTimers();
    const initiatorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0xc1));
    const responderIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0xd2));
    const initiatorTransport = new FlakyMemoryTransport();
    const responderTransport = new FlakyMemoryTransport();
    const initiator = new FipsNode({
      identity: initiatorIdentity,
      transports: [initiatorTransport],
    heartbeatIntervalMs: 1_000,
    });
    const responder = new FipsNode({
      identity: responderIdentity,
      transports: [responderTransport],
    heartbeatIntervalMs: 1_000,
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

    await vi.advanceTimersByTimeAsync(1_000);

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
        new Promise<undefined>((resolve) => {
          setTimeout(resolve, 2_000);
        }),
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

  it("routes FSP inside FMP when an adjacent peer lacks direct transport support", async () => {
    const support = vi
      .spyOn(FspSession.prototype, "remoteSupportsDirectFspTransport", "get")
      .mockReturnValue(false);
    const initiatorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0xe2));
    const responderIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0xf3));
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
    let resolveRequest: (payload: Uint8Array) => void = () => {};
    const receivedRequest = new Promise<Uint8Array>((resolve) => {
      resolveRequest = resolve;
    });
    responder.registerService(4_243, (context) => resolveRequest(context.payload));

    await responder.start();
    await initiator.start();
    try {
      await initiator.connect({
        transport: "memory",
        addr: toHex(responderIdentity.publicKey),
      });
      const payload = new TextEncoder().encode("legacy-routed-fsp");
      await initiator.sendDatagram({
        dst: toHex(responderIdentity.publicKey),
        dstPort: 4_243,
        payload,
      });

      await expect(receivedRequest).resolves.toEqual(payload);
      expect(initiatorTransport.directFragments).toBe(0);
      expect(responderTransport.directFragments).toBe(0);
    } finally {
      await initiator.stop();
      await responder.stop();
      support.mockRestore();
    }
  });
});
