import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FipsNode,
  FMP_PHASE_ESTABLISHED,
  LinkMessageType,
  encodeLookupRequestPayload,
  identityFromSecretKey,
  nodeAddrToHex,
  peekFmpPhase,
  toHex,
  type DiscoveredPeer,
  type NodeAddr,
  type SessionDatagram,
  type Transport,
  type TransportAddress,
  type TransportContext,
} from "../src/index.js";

const registry = new Map<string, RoutedTransport>();

class RoutedTransport implements Transport {
  readonly mtu = 1_200;
  resolveCalls = 0;
  establishedPackets = 0;
  resolvedPeers = new Map<string, Uint8Array>();
  resolveImpl?: (nodeAddr: NodeAddr, signal?: AbortSignal) => Promise<DiscoveredPeer | undefined>;

  private ctx?: TransportContext;
  private localAddr = "";

  constructor(readonly type: string) {}

  async start(ctx: TransportContext): Promise<void> {
    this.ctx = ctx;
    this.localAddr = toHex(ctx.localIdentity.publicKey);
    registry.set(this.key(this.localAddr), this);
  }

  async stop(): Promise<void> {
    registry.delete(this.key(this.localAddr));
    this.ctx = undefined;
  }

  async connect(addr: TransportAddress): Promise<void> {
    if (!registry.has(this.key(addr.addr))) {
      throw new Error(`missing ${this.type} peer ${addr.addr}`);
    }
  }

  async send(addr: TransportAddress, packet: Uint8Array): Promise<void> {
    if (peekFmpPhase(packet) === FMP_PHASE_ESTABLISHED) {
      this.establishedPackets += 1;
    }
    const remote = registry.get(this.key(addr.addr));
    if (!remote?.ctx) throw new Error(`missing ${this.type} peer ${addr.addr}`);
    queueMicrotask(() => {
      remote.ctx?.onPacket({
        transportType: this.type,
        remoteAddr: { transport: this.type, addr: this.localAddr },
        data: new Uint8Array(packet),
        receivedAtMs: Date.now(),
      });
    });
  }

  async resolve(nodeAddr: NodeAddr, signal?: AbortSignal): Promise<DiscoveredPeer | undefined> {
    this.resolveCalls += 1;
    if (this.resolveImpl) return this.resolveImpl(nodeAddr, signal);
    const publicKey = this.resolvedPeers.get(nodeAddrToHex(nodeAddr));
    if (!publicKey) return undefined;
    return {
      remoteAddr: { transport: this.type, addr: toHex(publicKey) },
      publicKey: new Uint8Array(publicKey),
    };
  }

  private key(addr: string): string {
    return `${this.type}:${addr}`;
  }
}

function sendSessionDatagram(node: FipsNode, datagram: SessionDatagram): Promise<void> {
  return (
    node as unknown as {
      sendSessionDatagram(value: SessionDatagram): Promise<void>;
    }
  ).sendSessionDatagram(datagram);
}

function sendLookupRequest(
  node: FipsNode,
  peerPubkey: string,
  request: Parameters<typeof encodeLookupRequestPayload>[0],
): Promise<void> {
  const internals = node as unknown as {
    peersByPubkey: Map<string, unknown>;
    sendLinkMessage(peer: unknown, msgType: number, payload: Uint8Array): Promise<void>;
  };
  const peer = internals.peersByPubkey.get(peerPubkey);
  if (!peer) throw new Error(`missing test peer ${peerPubkey}`);
  return internals.sendLinkMessage(
    peer,
    LinkMessageType.LookupRequest,
    encodeLookupRequestPayload(request),
  );
}

afterEach(() => {
  registry.clear();
  vi.useRealTimers();
});

describe("FipsNode on-demand route resolution", () => {
  it("times out a resolver that does not produce a route", async () => {
    vi.useFakeTimers();
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x11));
    const unknown = await identityFromSecretKey(new Uint8Array(32).fill(0x12));
    const transport = new RoutedTransport("waiting");
    transport.resolveImpl = (_nodeAddr, signal) => new Promise((resolve) => {
      signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    const node = new FipsNode({ identity: local, transports: [transport] });
    const datagram: SessionDatagram = {
      ttl: 63,
      pathMtu: 1_200,
      srcAddr: local.nodeAddr,
      destAddr: unknown.nodeAddr,
      payload: new Uint8Array([1]),
    };

    await node.start();
    try {
      const sending = sendSessionDatagram(node, datagram);
      const rejection = expect(sending).rejects.toThrow(
        `no route to ${nodeAddrToHex(unknown.nodeAddr)}`,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
      expect(transport.resolveCalls).toBe(1);
    } finally {
      await node.stop();
    }
  });

  it("single-flights concurrent resolution and authenticates through FMP", async () => {
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x21));
    const remote = await identityFromSecretKey(new Uint8Array(32).fill(0x22));
    const localTransport = new RoutedTransport("resolved");
    const remoteTransport = new RoutedTransport("resolved");
    let releaseResolution: (() => void) | undefined;
    localTransport.resolveImpl = async () => {
      await new Promise<void>((resolve) => {
        releaseResolution = resolve;
      });
      return {
        remoteAddr: { transport: "resolved", addr: toHex(remote.publicKey) },
        publicKey: remote.publicKey,
      };
    };
    const localNode = new FipsNode({ identity: local, transports: [localTransport] });
    const remoteNode = new FipsNode({ identity: remote, transports: [remoteTransport] });
    const datagram: SessionDatagram = {
      ttl: 63,
      pathMtu: 1_200,
      srcAddr: local.nodeAddr,
      destAddr: remote.nodeAddr,
      payload: new Uint8Array([1]),
    };

    await remoteNode.start();
    await localNode.start();
    try {
      const first = sendSessionDatagram(localNode, datagram);
      const second = sendSessionDatagram(localNode, datagram);
      expect(localTransport.resolveCalls).toBe(1);
      releaseResolution?.();
      await Promise.all([first, second]);

      expect(localTransport.resolveCalls).toBe(1);
      expect(localTransport.establishedPackets).toBe(2);
    } finally {
      await localNode.stop();
      await remoteNode.stop();
    }
  });

  it("uses Rust-compatible reply-learned lookup routing across a transit bridge", async () => {
    const a = await identityFromSecretKey(new Uint8Array(32).fill(0x31));
    const b = await identityFromSecretKey(new Uint8Array(32).fill(0x32));
    const c = await identityFromSecretKey(new Uint8Array(32).fill(0x33));
    const d = await identityFromSecretKey(new Uint8Array(32).fill(0x34));
    const aEthernet = new RoutedTransport("ethernet-like");
    const bEthernet = new RoutedTransport("ethernet-like");
    const bWebRtc = new RoutedTransport("webrtc-like");
    const cWebRtc = new RoutedTransport("webrtc-like");
    const cBackhaul = new RoutedTransport("backhaul-like");
    const dBackhaul = new RoutedTransport("backhaul-like");
    const aNode = new FipsNode({
      identity: a,
      transports: [aEthernet],
      defaultRoute: toHex(b.publicKey),
    });
    const bNode = new FipsNode({
      identity: b,
      transports: [bEthernet, bWebRtc],
      forwarding: true,
      routingMode: "reply_learned",
    });
    const cNode = new FipsNode({
      identity: c,
      transports: [cWebRtc, cBackhaul],
      forwarding: true,
      routingMode: "reply_learned",
      // This fixture has an extra transit hop; its planned backhaul route
      // stands in for Rust tree routing. WebVM itself has no default route.
      defaultRoute: toHex(b.publicKey),
    });
    const dNode = new FipsNode({
      identity: d,
      transports: [dBackhaul],
      defaultRoute: toHex(c.publicKey),
    });
    let received: Uint8Array | undefined;
    dNode.registerService(8_080, ({ payload }) => {
      received = payload;
    });

    await aNode.start();
    await bNode.start();
    await cNode.start();
    await dNode.start();
    try {
      await aNode.connect({
        transport: "ethernet-like",
        addr: toHex(b.publicKey),
      });
      await bNode.connect({
        transport: "webrtc-like",
        addr: toHex(c.publicKey),
      });
      await cNode.connect({
        transport: "backhaul-like",
        addr: toHex(d.publicKey),
      });
      await sendLookupRequest(aNode, toHex(b.publicKey), {
        requestId: 0x3132333435363738n,
        target: d.nodeAddr,
        origin: a.nodeAddr,
        ttl: 8,
        minMtu: 0,
        originCoords: [a.nodeAddr],
      });
      await vi.waitFor(() => {
        const learnedRoutes = (bNode as unknown as { learnedRoutes: Map<string, unknown> })
          .learnedRoutes;
        expect(learnedRoutes.has(nodeAddrToHex(d.nodeAddr))).toBe(true);
      });
      await aNode.sendDatagram({
        dst: toHex(d.publicKey),
        dstPort: 8_080,
        payload: new TextEncoder().encode("ethernet-to-webrtc"),
      });

      expect(new TextDecoder().decode(received)).toBe("ethernet-to-webrtc");
      expect(bWebRtc.resolveCalls).toBe(0);
    } finally {
      await aNode.stop();
      await bNode.stop();
      await cNode.stop();
      await dNode.stop();
    }
  });

  it("never forwards a datagram back to the peer it arrived from", async () => {
    const a = await identityFromSecretKey(new Uint8Array(32).fill(0x41));
    const b = await identityFromSecretKey(new Uint8Array(32).fill(0x42));
    const unknown = await identityFromSecretKey(new Uint8Array(32).fill(0x43));
    const claimedSource = await identityFromSecretKey(new Uint8Array(32).fill(0x44));
    const aTransport = new RoutedTransport("loop-like");
    const bTransport = new RoutedTransport("loop-like");
    const aNode = new FipsNode({
      identity: a,
      transports: [aTransport],
      defaultRoute: toHex(b.publicKey),
    });
    const bNode = new FipsNode({
      identity: b,
      transports: [bTransport],
      forwarding: true,
      routingMode: "reply_learned",
      defaultRoute: toHex(a.publicKey),
    });
    const noRoute = new Promise<void>((resolve) => {
      bNode.on("error", (event) => {
        const error = event as { err: Error };
        if (error.err.message === `no route to ${nodeAddrToHex(unknown.nodeAddr)}`) resolve();
      });
    });

    await aNode.start();
    await bNode.start();
    try {
      await aNode.connect({ transport: "loop-like", addr: toHex(b.publicKey) });
      await sendSessionDatagram(aNode, {
        ttl: 63,
        pathMtu: 1_200,
        srcAddr: claimedSource.nodeAddr,
        destAddr: unknown.nodeAddr,
        payload: new Uint8Array([1]),
      });

      await noRoute;
      expect(aTransport.resolveCalls).toBe(0);
      expect(bTransport.resolveCalls).toBe(0);
      const learnedRoutes = (bNode as unknown as { learnedRoutes: Map<string, unknown> })
        .learnedRoutes;
      expect(learnedRoutes.has(nodeAddrToHex(claimedSource.nodeAddr))).toBe(false);
    } finally {
      await aNode.stop();
      await bNode.stop();
    }
  });
});
