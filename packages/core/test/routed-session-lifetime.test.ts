import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FMP_PHASE_MSG1, FipsNode, identityFromSecretKey, toHex,
  type Transport, type TransportAddress, type TransportContext,
} from '../src/index.js';
import type { FspSession } from '../src/fsp/session.js';
import type { AdjacentPeer } from '../src/node/PeerState.js';

class RoutedCarrier implements Transport {
  readonly mtu = 1400;
  context?: TransportContext;
  readonly closed = new Set<string>();
  sent = 0;
  holdMsg1 = false;
  constructor(readonly type: string, private readonly network: Map<string, RoutedCarrier>) {}
  async start(context: TransportContext) {
    this.context = context;
    this.network.set(`${this.type}:${toHex(context.localIdentity.publicKey)}`, this);
  }
  async stop() {
    if (this.context) this.network.delete(`${this.type}:${toHex(this.context.localIdentity.publicKey)}`);
    this.context = undefined;
  }
  async connect() {}
  async send(address: TransportAddress, data: Uint8Array) {
    const remote = this.network.get(`${this.type}:${address.addr}`);
    if (!this.context || !remote?.context || this.closed.has(address.addr)) throw new Error('carrier unavailable');
    this.sent++;
    if (this.holdMsg1 && data[0] === FMP_PHASE_MSG1) return;
    remote.context.onPacket({
      transportType: this.type,
      remoteAddr: { transport: this.type, addr: toHex(this.context.localIdentity.publicKey) },
      data: data.slice(), receivedAtMs: Date.now(),
    });
  }
  disconnect(address: TransportAddress) {
    this.closed.add(address.addr);
    this.context!.onConnectionState?.({ remoteAddr: address, state: 'disconnected' });
  }
}

interface SessionState { fsp: FspSession; currentKBit: boolean }
interface NodeState {
  peers: Map<string, AdjacentPeer>;
  peersByNodeAddr: Map<string, AdjacentPeer>;
  sessionManager: { sessions: Map<string, SessionState> };
}
const inspect = (node: FipsNode) => node as unknown as NodeState;
const active: FipsNode[] = [];
afterEach(async () => { await Promise.all(active.splice(0).map(node => node.stop())); });

async function fixture() {
  const network = new Map<string, RoutedCarrier>();
  const nodes = await Promise.all([0x31, 0x32, 0x33].map(async value => {
    const identity = await identityFromSecretKey(new Uint8Array(32).fill(value));
    const websocket = new RoutedCarrier('websocket', network);
    const webrtc = new RoutedCarrier('webrtc', network);
    const node = new FipsNode({ identity, transports: [websocket, webrtc], forwarding: true, routingMode: 'reply_learned' });
    const received: Uint8Array[] = [];
    const errors: unknown[] = [];
    node.on('endpointData', event => received.push((event as { payload: Uint8Array }).payload));
    node.on('error', event => errors.push(event));
    active.push(node);
    await node.start();
    return { node, identity, websocket, webrtc, received, errors };
  }));
  const [local, seed, remote] = nodes;
  const seedAddress = { transport: 'websocket', addr: toHex(seed.identity.publicKey) };
  await local.node.connect(seedAddress);
  await remote.node.connect(seedAddress);
  await local.node.sendEndpointData({ dst: toHex(remote.identity.publicKey), payload: new Uint8Array([1]) });
  await vi.waitFor(() => expect(remote.received).toEqual([new Uint8Array([1])]));
  await remote.node.sendEndpointData({ dst: toHex(local.identity.publicKey), payload: new Uint8Array([2]) });
  await vi.waitFor(() => expect(local.received).toEqual([new Uint8Array([2])]));
  return { local, seed, remote, network };
}

describe('routed FSP session lifetime', () => {
  it.each(['established', 'handshaking'] as const)('keeps both sessions and endpoint traffic after the %s direct carrier disappears', async (directState) => {
    const { local, seed, remote } = await fixture();
    const remoteKey = toHex(remote.identity.publicKey), localKey = toHex(local.identity.publicKey);
    const localState = inspect(local.node), remoteState = inspect(remote.node);
    const localSession = localState.sessionManager.sessions.get(toHex(remote.identity.nodeAddr))!;
    const remoteSession = remoteState.sessionManager.sessions.get(toHex(local.identity.nodeAddr))!;
    const localK = localSession.currentKBit, remoteK = remoteSession.currentKBit;
    expect(localState.peersByNodeAddr.has(toHex(remote.identity.nodeAddr))).toBe(false);
    let connectOutcome: Promise<string> | undefined;
    if (directState === 'handshaking') {
      local.webrtc.holdMsg1 = true;
      connectOutcome = local.node.connect({ transport: 'webrtc', addr: remoteKey })
        .then(() => 'connected', error => (error as Error).message);
      await vi.waitFor(() => expect(local.webrtc.sent).toBeGreaterThan(0));
      const pendingPeer = [...localState.peers.values()].find(peer => peer.transport === local.webrtc)!;
      expect(pendingPeer.pubkeyHex).toBe(remoteKey);
      expect(pendingPeer.link.state).not.toBe('established');
      expect(pendingPeer.outgoingHandshake).toBeDefined();
    } else {
      await local.node.connect({ transport: 'webrtc', addr: remoteKey });
      await local.node.sendEndpointData({ dst: remoteKey, payload: new Uint8Array([3]) });
      await vi.waitFor(() => expect(remote.received.at(-1)).toEqual(new Uint8Array([3])));
    }

    local.webrtc.disconnect({ transport: 'webrtc', addr: remoteKey });
    remote.webrtc.disconnect({ transport: 'webrtc', addr: localKey });
    if (connectOutcome) expect(await connectOutcome).toBe('FMP transport disconnected');

    // A seed is a different identity, not an alternate direct carrier. Its
    // authenticated routed path must nevertheless retain the same FSP keys.
    expect(localState.peersByNodeAddr.has(toHex(remote.identity.nodeAddr))).toBe(false);
    expect(localState.peersByNodeAddr.has(toHex(seed.identity.nodeAddr))).toBe(true);
    expect(localState.sessionManager.sessions.get(toHex(remote.identity.nodeAddr)) === localSession).toBe(true);
    expect(remoteState.sessionManager.sessions.get(toHex(local.identity.nodeAddr)) === remoteSession).toBe(true);
    expect(localSession.currentKBit).toBe(localK);
    expect(remoteSession.currentKBit).toBe(remoteK);
    expect(localSession.fsp.state).toBe('established');
    expect(remoteSession.fsp.state).toBe('established');
    const sentViaSeed = local.websocket.sent + remote.websocket.sent;
    await local.node.sendEndpointData({ dst: remoteKey, payload: new Uint8Array([4]) });
    await remote.node.sendEndpointData({ dst: localKey, payload: new Uint8Array([5]) });
    await vi.waitFor(() => {
      expect(remote.received.at(-1)).toEqual(new Uint8Array([4]));
      expect(local.received.at(-1)).toEqual(new Uint8Array([5]));
    });
    expect(local.websocket.sent + remote.websocket.sent).toBeGreaterThan(sentViaSeed);
    expect(local.errors).toEqual([]);
    expect(remote.errors).toEqual([]);
    await local.node.stop();
    await remote.node.stop();
    expect(localSession.fsp.state).toBe('closed');
    expect(remoteSession.fsp.state).toBe('closed');
    expect(localState.sessionManager.sessions.size).toBe(0);
    expect(remoteState.sessionManager.sessions.size).toBe(0);
  });

  it('closes the session when a previously learned route has no surviving carrier', async () => {
    const { local, seed, remote } = await fixture();
    const localSession = inspect(local.node).sessionManager.sessions.get(toHex(remote.identity.nodeAddr))!;
    await local.node.connect({ transport: 'webrtc', addr: toHex(remote.identity.publicKey) });
    local.websocket.disconnect({ transport: 'websocket', addr: toHex(seed.identity.publicKey) });
    local.webrtc.disconnect({ transport: 'webrtc', addr: toHex(remote.identity.publicKey) });
    expect(inspect(local.node).sessionManager.sessions.has(toHex(remote.identity.nodeAddr))).toBe(false);
    expect(localSession.fsp.state).toBe('closed');
  });

  it('still discards old endpoint keys after an authenticated remote process restart', async () => {
    const { local, remote, network } = await fixture();
    const localKey = toHex(local.identity.publicKey), remoteKey = toHex(remote.identity.publicKey);
    await remote.node.connect({ transport: 'webrtc', addr: localKey });
    const oldSession = inspect(local.node).sessionManager.sessions.get(toHex(remote.identity.nodeAddr))!;
    await remote.node.stop();
    const replacement = new FipsNode({ identity: remote.identity,
      transports: [new RoutedCarrier('webrtc', network)], routingMode: 'reply_learned' });
    const received: Uint8Array[] = [];
    replacement.on('endpointData', event => received.push((event as { payload: Uint8Array }).payload));
    active.push(replacement);
    await replacement.start();
    await replacement.connect({ transport: 'webrtc', addr: localKey });
    expect(oldSession.fsp.state).toBe('closed');
    expect(inspect(local.node).sessionManager.sessions.has(toHex(remote.identity.nodeAddr))).toBe(false);
    await replacement.sendEndpointData({ dst: localKey, payload: new Uint8Array([6]) });
    await vi.waitFor(() => expect(local.received.at(-1)).toEqual(new Uint8Array([6])));
    await local.node.sendEndpointData({ dst: remoteKey, payload: new Uint8Array([7]) });
    await vi.waitFor(() => expect(received).toEqual([new Uint8Array([7])]));
    expect(inspect(local.node).sessionManager.sessions.get(toHex(remote.identity.nodeAddr)) === oldSession).toBe(false);
    expect(local.errors).toEqual([]);
  });
});
