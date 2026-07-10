import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FipsNode,
  FMP_PHASE_ESTABLISHED,
  deriveNodeAddr,
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

  it("forwards from an Ethernet-like link onto a resolved WebRTC-like link", async () => {
    const a = await identityFromSecretKey(new Uint8Array(32).fill(0x31));
    const b = await identityFromSecretKey(new Uint8Array(32).fill(0x32));
    const c = await identityFromSecretKey(new Uint8Array(32).fill(0x33));
    const aEthernet = new RoutedTransport("ethernet-like");
    const bEthernet = new RoutedTransport("ethernet-like");
    const bWebRtc = new RoutedTransport("webrtc-like");
    const cWebRtc = new RoutedTransport("webrtc-like");
    bWebRtc.resolvedPeers.set(nodeAddrToHex(deriveNodeAddr(c.publicKey)), c.publicKey);
    const aNode = new FipsNode({
      identity: a,
      transports: [aEthernet],
      defaultRoute: toHex(b.publicKey),
    });
    const bNode = new FipsNode({
      identity: b,
      transports: [bEthernet, bWebRtc],
      forwarding: true,
    });
    const cNode = new FipsNode({
      identity: c,
      transports: [cWebRtc],
      defaultRoute: toHex(b.publicKey),
    });
    let received: Uint8Array | undefined;
    cNode.registerService(8_080, ({ payload }) => {
      received = payload;
    });

    await aNode.start();
    await bNode.start();
    await cNode.start();
    try {
      await aNode.connect({
        transport: "ethernet-like",
        addr: toHex(b.publicKey),
      });
      await aNode.sendDatagram({
        dst: toHex(c.publicKey),
        dstPort: 8_080,
        payload: new TextEncoder().encode("ethernet-to-webrtc"),
      });

      expect(new TextDecoder().decode(received)).toBe("ethernet-to-webrtc");
      expect(bWebRtc.resolveCalls).toBe(1);
    } finally {
      await aNode.stop();
      await bNode.stop();
      await cNode.stop();
    }
  });
});
