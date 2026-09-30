import { describe, expect, it, vi } from 'vitest';
import {
  FipsNode, LinkMessageType, decodeLookupRequest, identityFromSecretKey, toHex,
  type LinkNegotiationMessage, type Transport, type TransportAddress, type TransportContext,
} from '../src/index.js';

class MemoryTransport implements Transport {
  context?: TransportContext;
  readonly packets: number[] = [];
  readonly offers: LinkNegotiationMessage[] = [];
  constructor(readonly type: string, readonly mtu: number, private readonly network: Map<string, MemoryTransport>, readonly maxFrameBytes?: number) {}
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
    if (packet.length > (this.maxFrameBytes ?? this.mtu)) throw new Error(`packet ${packet.length} exceeds MTU ${this.mtu}`);
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

async function setup(maxWebSocketFrameBytes?: number) {
  const network = new Map<string, MemoryTransport>();
  const nodes = await Promise.all([11, 12, 13, 14].map(async value => {
    const identity = await identityFromSecretKey(new Uint8Array(32).fill(value));
    const webrtc = new MemoryTransport('webrtc', 1200, network);
    const websocket = new MemoryTransport('websocket', 1400, network, maxWebSocketFrameBytes);
    const node = new FipsNode({ identity, transports: [webrtc, websocket], forwarding: true, routingMode: 'reply_learned' });
    await node.start();
    return { node, webrtc, websocket };
  }));
  return { nodes, close: () => Promise.all(nodes.map(({ node }) => node.stop())) };
}

const signal = (size: number): LinkNegotiationMessage => ({
  version: 1, negotiationId: `offer-${size}`, linkType: 'webrtc', kind: 'offer',
  createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
  payload: { sdp: 'a'.repeat(size) },
});

describe('routed signaling MTU', () => {
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
