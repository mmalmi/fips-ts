import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FipsNode, identityFromSecretKey, toHex,
  type Transport, type TransportAddress, type TransportContext,
} from "../src/index.js";
import type { SessionEvent } from "../src/node/types.js";

/**
 * Single-process transport that carries every packet between two local nodes
 * through a synchronous callback. A dropped carrier delivers no packets in
 * either direction but keeps `send` from throwing, so the remote peer stops
 * hearing from the near end without the near end hearing anything back.
 */
class MemoryCarrier implements Transport {
  readonly type = "memory";
  readonly mtu = 1400;
  context?: TransportContext;
  dropped = false;
  constructor(private readonly network: Map<string, MemoryCarrier>) {}
  async start(context: TransportContext) {
    this.context = context;
    this.network.set(toHex(context.localIdentity.publicKey), this);
  }
  async stop() {
    if (this.context) this.network.delete(toHex(this.context.localIdentity.publicKey));
    this.context = undefined;
  }
  async connect() {}
  async send(address: TransportAddress, data: Uint8Array) {
    if (!this.context || this.dropped) return;
    const remote = this.network.get(address.addr);
    if (!remote?.context || remote.dropped) return;
    remote.context.onPacket({
      transportType: this.type,
      remoteAddr: { transport: this.type, addr: toHex(this.context.localIdentity.publicKey) },
      data: data.slice(), receivedAtMs: Date.now(),
    });
  }
}

interface Fixture {
  local: FipsNode; remote: FipsNode;
  localKey: string; remoteKey: string;
  localSessions: SessionEvent[]; remoteSessions: SessionEvent[];
  localReceived: Uint8Array[]; remoteReceived: Uint8Array[];
  localErrors: unknown[]; remoteErrors: unknown[];
  localCarrier: MemoryCarrier; remoteCarrier: MemoryCarrier;
}

const active: FipsNode[] = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map(node => node.stop()));
  vi.useRealTimers();
});

async function openPair(localSeed: number, remoteSeed: number): Promise<Fixture> {
  const network = new Map<string, MemoryCarrier>();
  const localIdentity = await identityFromSecretKey(new Uint8Array(32).fill(localSeed));
  const remoteIdentity = await identityFromSecretKey(new Uint8Array(32).fill(remoteSeed));
  const localCarrier = new MemoryCarrier(network);
  const remoteCarrier = new MemoryCarrier(network);
  const local = new FipsNode({ identity: localIdentity, transports: [localCarrier] });
  const remote = new FipsNode({ identity: remoteIdentity, transports: [remoteCarrier] });
  active.push(local, remote);
  const localSessions: SessionEvent[] = [], remoteSessions: SessionEvent[] = [];
  const localReceived: Uint8Array[] = [], remoteReceived: Uint8Array[] = [];
  const localErrors: unknown[] = [], remoteErrors: unknown[] = [];
  local.on("session", event => localSessions.push(event));
  remote.on("session", event => remoteSessions.push(event));
  local.on("datagram", event => localReceived.push(event.payload));
  remote.on("datagram", event => remoteReceived.push(event.payload));
  local.on("endpointData", event => localReceived.push(event.payload));
  remote.on("endpointData", event => remoteReceived.push(event.payload));
  local.on("error", event => localErrors.push(event));
  remote.on("error", event => remoteErrors.push(event));
  await local.start();
  await remote.start();
  const localKey = toHex(localIdentity.publicKey);
  const remoteKey = toHex(remoteIdentity.publicKey);
  await local.connect({ transport: "memory", addr: remoteKey });
  return {
    local, remote, localKey, remoteKey,
    localSessions, remoteSessions,
    localReceived, remoteReceived,
    localErrors, remoteErrors,
    localCarrier, remoteCarrier,
  };
}

function closedFor(events: SessionEvent[], peerKey: string): number {
  return events.filter(event => event.state === "closed" && event.remotePubkey === peerKey).length;
}
function establishedFor(events: SessionEvent[], peerKey: string): number {
  return events.filter(event => event.state === "established"
    && (event.remotePubkey === peerKey || event.peerId === peerKey.slice(2))).length;
}

describe("FSP session idle timeout", () => {
  // Measured behaviour: fips-ts 0.0.61 held a session with no application
  // data past the original FIPS daemon's 90 s idle timeout, so later sends
  // reached the daemon as "Encrypted session message for unknown session"
  // and were lost. The fix ends the session on each side at 90 s silence,
  // and the next send opens a fresh one.
  it("ends an established session with no application data at the 90 s timeout", async () => {
    vi.useFakeTimers({ now: 0 });
    const f = await openPair(0x11, 0x12);
    await f.local.sendDatagram({ dst: f.remoteKey, dstPort: 4242, payload: new Uint8Array([1]) });
    await vi.waitFor(() => expect(f.remoteReceived.at(-1)).toEqual(new Uint8Array([1])));
    expect(establishedFor(f.localSessions, f.remoteKey)).toBeGreaterThanOrEqual(1);
    expect(establishedFor(f.remoteSessions, f.localKey)).toBeGreaterThanOrEqual(1);
    const localBeforeClose = closedFor(f.localSessions, f.remoteKey);
    const remoteBeforeClose = closedFor(f.remoteSessions, f.localKey);
    await vi.advanceTimersByTimeAsync(89_000);
    expect(closedFor(f.localSessions, f.remoteKey)).toBe(localBeforeClose);
    expect(closedFor(f.remoteSessions, f.localKey)).toBe(remoteBeforeClose);
    await vi.advanceTimersByTimeAsync(2_000); // past 90 s
    expect(closedFor(f.localSessions, f.remoteKey)).toBe(localBeforeClose + 1);
    expect(closedFor(f.remoteSessions, f.localKey)).toBe(remoteBeforeClose + 1);
    const remoteCountBefore = f.remoteReceived.length;
    await f.local.sendDatagram({ dst: f.remoteKey, dstPort: 4242, payload: new Uint8Array([2]) });
    await vi.waitFor(() => expect(f.remoteReceived.length).toBe(remoteCountBefore + 1));
    expect(f.remoteReceived.at(-1)).toEqual(new Uint8Array([2]));
    expect(establishedFor(f.localSessions, f.remoteKey)).toBeGreaterThanOrEqual(2);
    expect(f.localErrors).toEqual([]);
    expect(f.remoteErrors).toEqual([]);
  }, 20_000);

  it("keeps a session alive while a service-port datagram lands every 30 s for 200 s", async () => {
    vi.useFakeTimers({ now: 0 });
    const f = await openPair(0x13, 0x14);
    await f.local.sendDatagram({ dst: f.remoteKey, dstPort: 4242, payload: new Uint8Array([0]) });
    await vi.waitFor(() => expect(f.remoteReceived.length).toBe(1));
    const closedBefore = closedFor(f.localSessions, f.remoteKey)
      + closedFor(f.remoteSessions, f.localKey);
    for (let step = 1; step <= 6; step++) {
      await vi.advanceTimersByTimeAsync(30_000);
      await f.local.sendDatagram({ dst: f.remoteKey, dstPort: 4242, payload: new Uint8Array([step]) });
      await vi.waitFor(() => expect(f.remoteReceived.length).toBe(step + 1));
    }
    // 6 × 30 s = 180 s; cover 200 s overall with a final quiet span under 90 s.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(closedFor(f.localSessions, f.remoteKey)
      + closedFor(f.remoteSessions, f.localKey)).toBe(closedBefore);
    expect(f.localErrors).toEqual([]);
    expect(f.remoteErrors).toEqual([]);
  }, 20_000);

  it("keeps a session alive while endpoint data lands every 30 s for 200 s", async () => {
    vi.useFakeTimers({ now: 0 });
    const f = await openPair(0x15, 0x16);
    await f.local.sendEndpointData({ dst: f.remoteKey, payload: new Uint8Array([0]) });
    await vi.waitFor(() => expect(f.remoteReceived.length).toBe(1));
    const closedBefore = closedFor(f.localSessions, f.remoteKey)
      + closedFor(f.remoteSessions, f.localKey);
    for (let step = 1; step <= 6; step++) {
      await vi.advanceTimersByTimeAsync(30_000);
      await f.local.sendEndpointData({ dst: f.remoteKey, payload: new Uint8Array([step]) });
      await vi.waitFor(() => expect(f.remoteReceived.length).toBe(step + 1));
    }
    await vi.advanceTimersByTimeAsync(20_000);
    expect(closedFor(f.localSessions, f.remoteKey)
      + closedFor(f.remoteSessions, f.localKey)).toBe(closedBefore);
    expect(f.localErrors).toEqual([]);
    expect(f.remoteErrors).toEqual([]);
  }, 20_000);

  // Half-dropped session (the far end tore it down without a word, e.g. a
  // UDP peer that stopped answering). The near end's 90 s idle sweep must
  // still fire, and the next send must open a fresh session end to end.
  it("recovers once the near end's idle sweep fires on a session the far end silently dropped",
    async () => {
      vi.useFakeTimers({ now: 0 });
      const f = await openPair(0x17, 0x18);
      await f.local.sendDatagram({ dst: f.remoteKey, dstPort: 4242, payload: new Uint8Array([1]) });
      await vi.waitFor(() => expect(f.remoteReceived.length).toBe(1));
      // The remote stops hearing the near end entirely but never signals a
      // close; its own idle sweep will fire independently and will clear its
      // session too, so only the local close is asserted here.
      f.remoteCarrier.dropped = true;
      f.localCarrier.dropped = true;
      const localBeforeClose = closedFor(f.localSessions, f.remoteKey);
      await vi.advanceTimersByTimeAsync(91_000);
      expect(closedFor(f.localSessions, f.remoteKey)).toBe(localBeforeClose + 1);
      // The carrier is restored; a fresh session must re-handshake and deliver.
      f.remoteCarrier.dropped = false;
      f.localCarrier.dropped = false;
      const remoteCountBefore = f.remoteReceived.length;
      await f.local.sendDatagram({ dst: f.remoteKey, dstPort: 4242, payload: new Uint8Array([2]) });
      await vi.waitFor(() => expect(f.remoteReceived.length).toBe(remoteCountBefore + 1));
      expect(f.remoteReceived.at(-1)).toEqual(new Uint8Array([2]));
    }, 20_000);
});
