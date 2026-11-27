import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FipsNode, identityFromSecretKey, toHex,
  type Transport, type TransportAddress, type TransportContext,
} from "../src/index.js";
import type { PeerEvent } from "../src/node/types.js";

/**
 * In-process carrier that forwards packets between adjacent peers through a
 * shared network map. A directed `silentFrom` entry drops every packet the
 * named sender emits without informing the receiver or the sender — the
 * network stays reachable in the other direction, as a stream-carried link
 * whose far end went away without a close does.
 */
class MeshCarrier implements Transport {
  readonly type = "mesh";
  readonly mtu = 1400;
  readonly silentFrom = new Set<string>();
  context?: TransportContext;
  closed = false;
  constructor(private readonly network: Map<string, MeshCarrier>) {}
  async start(context: TransportContext) {
    this.context = context;
    this.network.set(toHex(context.localIdentity.publicKey), this);
  }
  async stop() {
    this.closed = true;
    if (this.context) this.network.delete(toHex(this.context.localIdentity.publicKey));
    this.context = undefined;
  }
  async connect() {}
  async send(address: TransportAddress, data: Uint8Array) {
    if (!this.context || this.closed) return;
    const remote = this.network.get(address.addr);
    if (!remote?.context || remote.closed) return;
    const selfKey = toHex(this.context.localIdentity.publicKey);
    if (remote.silentFrom.has(selfKey) || this.silentFrom.has(address.addr)) return;
    remote.context.onPacket({
      transportType: this.type,
      remoteAddr: { transport: this.type, addr: selfKey },
      data: data.slice(), receivedAtMs: Date.now(),
    });
  }
  async close(address: TransportAddress) {
    if (!this.context) return;
    this.context.onConnectionState?.({ remoteAddr: address, state: "disconnected" });
  }
}

interface NodeCtx {
  node: FipsNode;
  key: string;
  carrier: MeshCarrier;
  peerEvents: PeerEvent[];
  received: Uint8Array[];
  errors: unknown[];
}

const active: FipsNode[] = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map(node => node.stop()));
  vi.useRealTimers();
});

async function makeNode(seed: number, network: Map<string, MeshCarrier>,
  routingMode: "tree" | "reply_learned" = "tree"): Promise<NodeCtx> {
  const identity = await identityFromSecretKey(new Uint8Array(32).fill(seed));
  const carrier = new MeshCarrier(network);
  const node = new FipsNode({ identity, transports: [carrier], forwarding: true, routingMode });
  const peerEvents: PeerEvent[] = [];
  const received: Uint8Array[] = [];
  const errors: unknown[] = [];
  node.on("peer", event => peerEvents.push(event));
  node.on("endpointData", event => received.push(event.payload));
  node.on("error", event => errors.push(event));
  active.push(node);
  await node.start();
  return { node, key: toHex(identity.publicKey), carrier, peerEvents, received, errors };
}

function disconnectedFor(events: PeerEvent[], peerKey: string): number {
  return events.filter(event => event.state === "disconnected" && event.remotePubkey === peerKey).length;
}

describe("FMP link-dead timeout", () => {
  // Measured behaviour: fips-ts 0.0.61 sent heartbeats every 5 s but had no
  // receive-side link timer — a link whose far end went silent stayed in the
  // `established` state and routed into nothing. In a four-node mesh, a
  // dead direct peer kept its routing-table slot for over 150 s while a
  // working two-hop path through a third node existed. The fix ends an
  // established link that has received nothing for 30 s.

  it("ends an established link whose far end stopped sending, "
    + "within the timeout plus one heartbeat, and never before the timeout", async () => {
    vi.useFakeTimers({ now: 0 });
    const network = new Map<string, MeshCarrier>();
    const a = await makeNode(0x21, network);
    const b = await makeNode(0x22, network);
    await a.node.connect({ transport: "mesh", addr: b.key });
    expect(a.peerEvents.some(e => e.state === "connected" && e.remotePubkey === b.key)).toBe(true);
    const beforeDisconnect = disconnectedFor(a.peerEvents, b.key);
    // B stops sending to A; its carrier keeps accepting A's packets so A has
    // no clue through the transport layer, matching a dropped UDP peer.
    a.carrier.silentFrom.add(b.key);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(disconnectedFor(a.peerEvents, b.key)).toBe(beforeDisconnect);
    // Past the timeout plus one heartbeat (30 + 5 = 35 s with slack).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(disconnectedFor(a.peerEvents, b.key)).toBe(beforeDisconnect + 1);
    expect(a.errors).toEqual([]);
  }, 20_000);

  it("keeps a link whose far end keeps heartbeating for 120 s", async () => {
    vi.useFakeTimers({ now: 0 });
    const network = new Map<string, MeshCarrier>();
    const a = await makeNode(0x23, network);
    const b = await makeNode(0x24, network);
    await a.node.connect({ transport: "mesh", addr: b.key });
    const beforeDisconnect = disconnectedFor(a.peerEvents, b.key)
      + disconnectedFor(b.peerEvents, a.key);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(disconnectedFor(a.peerEvents, b.key)
      + disconnectedFor(b.peerEvents, a.key)).toBe(beforeDisconnect);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  }, 20_000);

  it("ends a link that comes up and whose far end then sends nothing", async () => {
    vi.useFakeTimers({ now: 0 });
    const network = new Map<string, MeshCarrier>();
    const a = await makeNode(0x25, network);
    const b = await makeNode(0x26, network);
    await a.node.connect({ transport: "mesh", addr: b.key });
    expect(a.peerEvents.some(e => e.state === "connected" && e.remotePubkey === b.key)).toBe(true);
    const beforeDisconnect = disconnectedFor(a.peerEvents, b.key);
    a.carrier.silentFrom.add(b.key);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(disconnectedFor(a.peerEvents, b.key)).toBe(beforeDisconnect + 1);
    expect(a.errors).toEqual([]);
  }, 20_000);

  // A silent direct link ends and a send to that peer's key goes through a
  // remaining two-hop path. B is the seed; A reaches C both direct and via
  // B (established by a two-hop send before any direct link is dialled, so
  // B's reply-learned routing holds the A-C return path). After the direct
  // link's sweep, A removes that direct peer and the send routes via B.
  it("falls back to the two-hop path once the silent direct link to C ends", async () => {
    vi.useFakeTimers({ now: 0 });
    const network = new Map<string, MeshCarrier>();
    const a = await makeNode(0x27, network, "reply_learned");
    const b = await makeNode(0x28, network, "reply_learned");
    const c = await makeNode(0x29, network, "reply_learned");
    await a.node.connect({ transport: "mesh", addr: b.key });
    await c.node.connect({ transport: "mesh", addr: b.key });
    // First A->C exchange runs two-hop through B; B learns both reverse paths.
    await a.node.sendEndpointData({ dst: c.key, payload: new Uint8Array([1]) });
    await vi.waitFor(() => expect(c.received.at(-1)).toEqual(new Uint8Array([1])));
    await c.node.sendEndpointData({ dst: a.key, payload: new Uint8Array([9]) });
    await vi.waitFor(() => expect(a.received.at(-1)).toEqual(new Uint8Array([9])));
    // Dial a direct A-C link; the next send travels direct.
    await a.node.connect({ transport: "mesh", addr: c.key });
    await a.node.sendEndpointData({ dst: c.key, payload: new Uint8Array([3]) });
    await vi.waitFor(() => expect(c.received.at(-1)).toEqual(new Uint8Array([3])));
    // C falls silent to A over the direct link; the triangle through B is
    // untouched, so B keeps hearing both peers and can relay.
    a.carrier.silentFrom.add(c.key);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(disconnectedFor(a.peerEvents, c.key)).toBeGreaterThanOrEqual(1);
    const receivedBefore = c.received.length;
    await a.node.sendEndpointData({ dst: c.key, payload: new Uint8Array([2]) });
    await vi.waitFor(() => expect(c.received.length).toBe(receivedBefore + 1));
    expect(c.received.at(-1)).toEqual(new Uint8Array([2]));
    expect(a.errors).toEqual([]);
  }, 30_000);
});
