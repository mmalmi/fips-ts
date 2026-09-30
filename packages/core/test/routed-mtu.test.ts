import { describe, expect, it, vi } from 'vitest';
import {
  FipsNode, LinkMessageType, decodeLookupRequest, identityFromSecretKey, nodeAddrToHex, toHex,
  type LinkNegotiationMessage, type Transport, type TransportAddress, type TransportContext,
} from '../src/index.js';
import type { LearnedRouteTable } from '../src/node/LearnedRouteTable.js';

class MemoryTransport implements Transport {
  context?: TransportContext;
  readonly packets: number[] = [];
  readonly sent: { address: string; bytes: number }[] = [];
  readonly offers: LinkNegotiationMessage[] = [];
  constructor(readonly type: string, readonly mtu: number, private readonly network: Map<string, MemoryTransport>, readonly maxFrameBytes?: number, private readonly wireCapacity = maxFrameBytes ?? mtu) {}
  async start(context: TransportContext): Promise<void> {
    this.context = context;
    this.network.set(`${this.type}:${toHex(context.localIdentity.publicKey)}`, this);
  }
  async stop(): Promise<void> {
    if (this.context) this.network.delete(`${this.type}:${toHex(this.context.localIdentity.publicKey)}`);
    this.context = undefined;
  }
  async connect(): Promise<void> {}
  async send(address: TransportAddress, packet: Uint8Array): Promise<void> {
    this.packets.push(packet.length);
    this.sent.push({ address: address.addr, bytes: packet.length });
    if (packet.length > this.wireCapacity) throw new Error(`packet ${packet.length} exceeds MTU ${this.mtu}`);
    const remote = this.network.get(`${this.type}:${address.addr}`);
    if (!remote?.context || !this.context) throw new Error('peer unavailable');
    remote.context.onPacket({
      transportType: this.type,
      remoteAddr: { transport: this.type, addr: toHex(this.context.localIdentity.publicKey) },
      data: packet, receivedAtMs: Date.now(),
    });
  }
  handleLinkNegotiation(_peer: string, message: LinkNegotiationMessage): void { this.offers.push(message); }
}

async function setup(maxWebSocketFrameBytes?: number, legacyWebSocketHop = false) {
  const network = new Map<string, MemoryTransport>();
  const nodes = await Promise.all([11, 12, 13, 14].map(async value => {
    const identity = await identityFromSecretKey(new Uint8Array(32).fill(value));
    const webrtc = new MemoryTransport('webrtc', 1200, network);
    const websocket = new MemoryTransport('websocket', 1400, network,
      legacyWebSocketHop && value === 12 ? undefined : maxWebSocketFrameBytes, maxWebSocketFrameBytes ?? 1400);
    const udp = new MemoryTransport('udp', 1280, network);
    const node = new FipsNode({ identity, transports: [webrtc, websocket, udp], forwarding: true, routingMode: 'reply_learned' });
    await node.start();
    return { node, webrtc, websocket, udp };
  }));
  return { nodes, close: () => Promise.all(nodes.map(({ node }) => node.stop())) };
}

const signal = (size: number): LinkNegotiationMessage => ({
  version: 1, negotiationId: `offer-${size}`, linkType: 'webrtc', kind: 'offer',
  createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
  payload: { sdp: 'a'.repeat(size) },
});

describe('routed signaling MTU', () => {
  it('rejects a record that exceeds a downstream bottleneck hidden behind a wide first hop', async () => {
    const { nodes: [source, narrow, , destination], close } = await setup(4096);
    const target = toHex(destination.node.identity.publicKey);
    try {
      await source.node.connect({ transport: 'websocket', addr: toHex(narrow.node.identity.publicKey) });
      await narrow.node.connect({ transport: 'udp', addr: target });
      await source.webrtc.context!.sendLinkNegotiation!(target, signal(50));
      await vi.waitFor(() => expect(destination.webrtc.offers).toHaveLength(1));
      await expect(source.webrtc.context!.sendLinkNegotiation!(target, signal(1100))).rejects.toThrow('no route');
      expect(source.websocket.packets.every(length => length <= 1280)).toBe(true);
      expect(narrow.udp.packets.every(length => length <= 1280)).toBe(true);
    } finally { await close(); }
  }, 10_000);

  it('does not assume that a legacy WebSocket path advertising 1400 supports a larger record', async () => {
    const { nodes: [source, legacy, , destination], close } = await setup(4096, true);
    const target = toHex(destination.node.identity.publicKey);
    try {
      await source.node.connect({ transport: 'websocket', addr: toHex(legacy.node.identity.publicKey) });
      await legacy.node.connect({ transport: 'websocket', addr: target });
      await source.webrtc.context!.sendLinkNegotiation!(target, signal(50));
      await vi.waitFor(() => expect(destination.webrtc.offers).toHaveLength(1));
      // Its wire could carry 4096, but the old peer only verifies 1400 in lookup.
      // Enabling larger records needs a truthful capacity advertisement first.
      await expect(source.webrtc.context!.sendLinkNegotiation!(target, signal(2560))).rejects.toThrow('no route');
      expect(source.websocket.packets.every(length => length <= 1400)).toBe(true);
    } finally { await close(); }
  }, 10_000);

  it('retains the downstream bottleneck and selects the successful size-qualified lookup route', async () => {
    const { nodes: [source, narrow, wide, destination], close } = await setup(4096);
    const target = toHex(destination.node.identity.publicKey);
    const wideKey = toHex(wide.node.identity.publicKey);
    const sends = vi.spyOn(source.node as unknown as {
      sendLinkMessage(peer: unknown, type: number, payload: Uint8Array): Promise<void>;
    }, 'sendLinkMessage');
    try {
      await source.node.connect({ transport: 'websocket', addr: toHex(narrow.node.identity.publicKey) });
      await narrow.node.connect({ transport: 'udp', addr: target });
      await source.webrtc.context!.sendLinkNegotiation!(target, signal(50));
      await vi.waitFor(() => expect(destination.webrtc.offers).toHaveLength(1));
      await source.node.connect({ transport: 'websocket', addr: wideKey });
      await wide.node.connect({ transport: 'websocket', addr: target });
      const offer = signal(1100);
      await source.webrtc.context!.sendLinkNegotiation!(target, offer);
      await vi.waitFor(() => expect(destination.webrtc.offers).toContainEqual(offer));
      const largePackets = source.websocket.sent.filter(({ bytes }) => bytes > 1280);
      expect(largePackets.length).toBeGreaterThan(0);
      expect(largePackets.every(({ address }) => address === wideKey)).toBe(true);
      const requestedMtus = sends.mock.calls.filter(([, type]) => type === LinkMessageType.LookupRequest)
        .map(([, , payload]) => decodeLookupRequest(payload).minMtu);
      expect(requestedMtus).toContain(Math.max(...largePackets.map(({ bytes }) => bytes)));
      expect(narrow.udp.packets.every(length => length <= 1280)).toBe(true);
    } finally { await close(); }
  });

  it('uses the qualified lookup response even when stale scores fill the learned-route cache', async () => {
    const { nodes: [source, narrow, wide, destination], close } = await setup(4096);
    const target = toHex(destination.node.identity.publicKey);
    try {
      await source.node.connect({ transport: 'websocket', addr: toHex(narrow.node.identity.publicKey) });
      await narrow.node.connect({ transport: 'udp', addr: target });
      await source.webrtc.context!.sendLinkNegotiation!(target, signal(50));
      await vi.waitFor(() => expect(destination.webrtc.offers).toHaveLength(1));
      await source.node.connect({ transport: 'websocket', addr: toHex(wide.node.identity.publicKey) });
      await wide.node.connect({ transport: 'websocket', addr: target });
      const routes = (source.node as unknown as { routing: { learnedRoutes: LearnedRouteTable } }).routing.learnedRoutes;
      for (let hop = 0; hop < 4; hop++) {
        const nextHop = hop === 0 ? nodeAddrToHex(narrow.node.identity.nodeAddr) : `stale-${hop}`;
        for (let score = 0; score < 4; score++) {
          routes.learn(nodeAddrToHex(destination.node.identity.nodeAddr), nextHop, Date.now(), 300, 4, 1280);
        }
      }
      const offer = signal(1100);
      await source.webrtc.context!.sendLinkNegotiation!(target, offer);
      await vi.waitFor(() => expect(destination.webrtc.offers).toContainEqual(offer));
    } finally { await close(); }
  });

  it('discovers a wide route instead of sending an oversized offer over a learned WebRTC hop', async () => {
    const { nodes: [source, narrow, wide, destination], close } = await setup();
    const target = toHex(destination.node.identity.publicKey);
    const sends = vi.spyOn(source.node as unknown as {
      sendLinkMessage(peer: unknown, type: number, payload: Uint8Array): Promise<void>;
    }, 'sendLinkMessage');
    try {
      await source.node.connect({ transport: 'webrtc', addr: toHex(narrow.node.identity.publicKey) });
      await narrow.node.connect({ transport: 'websocket', addr: target });
      await source.webrtc.context!.sendLinkNegotiation!(target, signal(50));
      await vi.waitFor(() => expect(destination.webrtc.offers).toHaveLength(1));
      // Learn the destination over the narrow route first, then make an alternate
      // carrier available without warming its path with application traffic.
      await source.node.connect({ transport: 'websocket', addr: toHex(wide.node.identity.publicKey) });
      await wide.node.connect({ transport: 'websocket', addr: target });
      const offer = signal(993);
      await source.webrtc.context!.sendLinkNegotiation!(target, offer);
      await vi.waitFor(() => expect(destination.webrtc.offers).toContainEqual(offer));
      expect(source.webrtc.packets.every(length => length <= 1200)).toBe(true);
      expect(source.websocket.packets.some(length => length > 1200 && length <= 1400)).toBe(true);
      const requestedMtus = sends.mock.calls.filter(([, type]) => type === LinkMessageType.LookupRequest)
        .map(([, , payload]) => decodeLookupRequest(payload).minMtu);
      expect(requestedMtus).toContain(Math.max(...source.websocket.packets));
    } finally { await close(); }
  });

  it('keeps a large SDP on the existing framed carrier when a newer narrow adjacency hides it', async () => {
    const { nodes: [source, hop, , destination], close } = await setup(4096);
    const target = toHex(destination.node.identity.publicKey);
    try {
      await source.node.connect({ transport: 'websocket', addr: toHex(hop.node.identity.publicKey) });
      await hop.node.connect({ transport: 'websocket', addr: target });
      await source.webrtc.context!.sendLinkNegotiation!(target, signal(50));
      await vi.waitFor(() => expect(destination.webrtc.offers).toHaveLength(1));
      await source.node.connect({ transport: 'webrtc', addr: toHex(hop.node.identity.publicKey) });
      const offer = signal(2560);
      await source.webrtc.context!.sendLinkNegotiation!(target, offer);
      await vi.waitFor(() => expect(destination.webrtc.offers).toContainEqual(offer));
      expect(source.webrtc.packets.every(length => length <= 1200)).toBe(true);
      expect(source.websocket.packets.some(length => length > 2800)).toBe(true);
    } finally { await close(); }
  });

  it('fails without emitting an oversized packet when no compatible carrier exists', async () => {
    const { nodes: [source, hop, , destination], close } = await setup();
    const target = toHex(destination.node.identity.publicKey);
    try {
      await source.node.connect({ transport: 'webrtc', addr: toHex(hop.node.identity.publicKey) });
      await hop.node.connect({ transport: 'websocket', addr: target });
      await source.webrtc.context!.sendLinkNegotiation!(target, signal(50));
      await vi.waitFor(() => expect(destination.webrtc.offers).toHaveLength(1));
      await expect(source.webrtc.context!.sendLinkNegotiation!(target, signal(993))).rejects.toThrow('no route');
      expect(source.webrtc.packets.every(length => length <= 1200)).toBe(true);
    } finally { await close(); }
  });

  it('selects a compatible onward route at an intermediate node too', async () => {
    const { nodes: [source, middle, wide, destination], close } = await setup();
    const target = toHex(destination.node.identity.publicKey);
    try {
      await source.node.connect({ transport: 'websocket', addr: toHex(middle.node.identity.publicKey) });
      await middle.node.connect({ transport: 'webrtc', addr: target });
      await source.webrtc.context!.sendLinkNegotiation!(target, signal(50));
      await vi.waitFor(() => expect(destination.webrtc.offers).toHaveLength(1));
      await middle.node.connect({ transport: 'websocket', addr: toHex(wide.node.identity.publicKey) });
      await wide.node.connect({ transport: 'websocket', addr: target });
      const offer = signal(993);
      await source.webrtc.context!.sendLinkNegotiation!(target, offer);
      await vi.waitFor(() => expect(destination.webrtc.offers).toContainEqual(offer));
      expect(middle.webrtc.packets.every(length => length <= 1200)).toBe(true);
      expect(middle.websocket.packets.some(length => length > 1200)).toBe(true);
    } finally { await close(); }
  });
});
