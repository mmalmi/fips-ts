import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FipsNode,
  FMP_ESTABLISHED_HEADER_LEN,
  identityFromSecretKey,
  toHex,
  type Transport,
  type TransportAddress,
  type TransportContext,
} from "../src/index.js";
import { FMP_AEAD_TAG_LEN } from "../src/fmp/wire.js";

class TransportHub {
  private readonly transports = new Map<string, ControlledTransport>();

  register(transport: ControlledTransport): void {
    this.transports.set(`${transport.type}:${transport.localPubkey}`, transport);
  }

  unregister(transport: ControlledTransport): void {
    this.transports.delete(`${transport.type}:${transport.localPubkey}`);
  }

  peer(type: string, pubkey: string): ControlledTransport | undefined {
    return this.transports.get(`${type}:${pubkey}`);
  }
}

class ControlledTransport implements Transport {
  readonly mtu = 1400;
  localPubkey = "";
  holdOutgoing = false;
  rejectNextEstablished = false;
  confirmationGate?: Promise<void>;
  heartbeatSends = 0;

  private ctx?: TransportContext;
  private readonly held: Array<() => void> = [];

  constructor(readonly type: string, private readonly hub: TransportHub) {}

  async start(ctx: TransportContext): Promise<void> {
    this.ctx = ctx;
    this.localPubkey = toHex(ctx.localIdentity.publicKey);
    this.hub.register(this);
  }

  async stop(): Promise<void> {
    this.hub.unregister(this);
    this.ctx = undefined;
    this.held.length = 0;
  }

  async connect(addr: TransportAddress): Promise<void> {
    if (!this.hub.peer(this.type, addr.addr)) throw new Error("peer unavailable");
  }

  async send(addr: TransportAddress, packet: Uint8Array): Promise<void> {
    if (packet[0] === 0 && packet.length === FMP_ESTABLISHED_HEADER_LEN + FMP_AEAD_TAG_LEN + 5) {
      this.heartbeatSends++;
    }
    if (packet[0] === 0 && this.rejectNextEstablished) {
      this.rejectNextEstablished = false;
      throw new Error("confirmation send rejected");
    }
    if (packet[0] === 0 && this.confirmationGate) {
      const gate = this.confirmationGate;
      this.confirmationGate = undefined;
      await gate;
    }
    const remote = this.hub.peer(this.type, addr.addr);
    if (!remote?.ctx) throw new Error("peer unavailable");
    const deliver = () => remote.ctx?.onPacket({
      transportType: this.type,
      remoteAddr: { transport: this.type, addr: this.localPubkey },
      data: new Uint8Array(packet),
      receivedAtMs: Date.now(),
    });
    if (this.holdOutgoing) this.held.push(deliver);
    else queueMicrotask(deliver);
  }

  disconnect(addr: TransportAddress): void {
    this.ctx?.onConnectionState?.({ remoteAddr: addr, state: "disconnected" });
  }

  heldCount(): number {
    return this.held.length;
  }

  release(): void {
    for (const deliver of this.held.splice(0)) queueMicrotask(deliver);
  }
}

afterEach(() => vi.useRealTimers());

describe("physical path upgrade", () => {
  it("expires unconfirmed carriers within the handshake budget without disconnect events", async () => {
    const pair = await startPair(["bootstrap", "pending"]);
    const events: string[] = [];
    pair.b.on("peer", (event) => events.push((event as { state: string }).state));
    pair.b.registerService(9000, async ({ payload, reply }) => reply(payload));
    try {
      await pair.connect(0);
      await echo(pair.a, pair.bPubkey, "before-expiration");
      const healthy = (pair.b as any).peersByPubkey.get(pair.aPubkey);
      vi.useFakeTimers();
      pair.bTransports[1]!.holdOutgoing = true;
      const pending = pair.connect(1).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      const candidate = (pair.b as any).peers.get(`pending:${pair.aPubkey}`);
      expect(candidate.pendingResponderLink).toBeDefined();
      pair.aTransports[1]!.disconnect({ transport: "pending", addr: pair.bPubkey });
      await pending;
      await vi.advanceTimersByTimeAsync(15_000);
      expect((pair.b as any).peers.size).toBe(1);
      expect(candidate.pendingResponderLink).toBeUndefined();
      expect(candidate.link.state).toBe("closed");
      expect((pair.b as any).peersByPubkey.get(pair.aPubkey)).toBe(healthy);
      expect(events).toEqual(["connected"]);
      await echo(pair.a, pair.bPubkey, "after-expiration");
      const next = pair.connect(1).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      pair.bTransports[0]!.disconnect({ transport: "bootstrap", addr: pair.aPubkey });
      expect((pair.b as any).peersByPubkey.has(pair.aPubkey)).toBe(false);
      pair.aTransports[1]!.disconnect({ transport: "pending", addr: pair.bPubkey });
      await next;
      await vi.advanceTimersByTimeAsync(15_000);
      expect((pair.b as any).peers.size).toBe(0);
      expect(events).toEqual(["connected", "disconnected"]);
    } finally {
      await pair.stop();
    }
  });

  it("bounds pending carriers while preserving the established path", async () => {
    const pair = await startPair(["bootstrap", ...Array.from({ length: 65 }, (_, i) => `pending-${i}`)]);
    try {
      await pair.connect(0);
      const healthy = (pair.b as any).peersByPubkey.get(pair.aPubkey);
      vi.useFakeTimers();
      const pending: Promise<unknown>[] = [];
      for (let i = 1; i < pair.bTransports.length; i++) {
        pair.bTransports[i]!.holdOutgoing = true;
        pending.push(pair.connect(i).catch(() => {}));
      }
      await vi.advanceTimersByTimeAsync(0);
      expect((pair.b as any).peers.size).toBe(65);
      const retained = (pair.b as any).peers.get(`pending-0:${pair.aPubkey}`).pendingResponderLink;
      expect(pair.bTransports[1]!.heldCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pair.bTransports[1]!.heldCount()).toBe(2);
      expect((pair.b as any).peers.get(`pending-0:${pair.aPubkey}`).pendingResponderLink).toBe(retained);
      expect((pair.b as any).peers.size).toBe(65);
      expect((pair.b as any).peersByPubkey.get(pair.aPubkey)).toBe(healthy);
      await pair.stop();
      await Promise.all(pending);
    } finally {
      await pair.stop();
    }
  });

  it("prefers an established alternate over an earlier pending carrier", async () => {
    const pair = await startPair(["bootstrap", "pending", "direct"]);
    try {
      await pair.connect(0);
      pair.bTransports[1]!.holdOutgoing = true;
      const pending = pair.connect(1).catch(() => {});
      await waitUntil(() => pair.bTransports[1]!.heldCount() > 0);
      await pair.connect(2);
      pair.aTransports[0]!.disconnect({ transport: "bootstrap", addr: pair.bPubkey });
      await pair.connect(0);
      const direct = (pair.b as any).peers.get(`direct:${pair.aPubkey}`);
      pair.bTransports[0]!.disconnect({ transport: "bootstrap", addr: pair.aPubkey });
      expect((pair.b as any).peersByPubkey.get(pair.aPubkey)).toBe(direct);
      const events: unknown[] = [];
      pair.b.on("peer", (event) => events.push(event));
      pair.bTransports[1]!.disconnect({ transport: "pending", addr: pair.aPubkey });
      expect(events).toEqual([]);
      await pair.stop();
      await pending;
    } finally {
      await pair.stop();
    }
  });

  it("cleans a rejected confirmation before retrying the same path", async () => {
    const pair = await startPair(["bootstrap", "direct"]);
    try {
      await pair.connect(0);
      const healthy = (pair.a as any).peersByPubkey.get(pair.bPubkey);
      pair.aTransports[1]!.rejectNextEstablished = true;
      await expect(pair.connect(1)).rejects.toThrow("confirmation send rejected");
      expect((pair.a as any).peers.has(`direct:${pair.bPubkey}`)).toBe(false);
      expect((pair.a as any).peersByPubkey.get(pair.bPubkey)).toBe(healthy);
      await pair.connect(1);
      expect((pair.a as any).peersByPubkey.get(pair.bPubkey).remoteAddr.transport).toBe("direct");
    } finally {
      await pair.stop();
    }
  });

  it("waits for confirmation acceptance and ignores its completion after stop", async () => {
    const pair = await startPair(["bootstrap", "direct"]);
    let release!: () => void;
    try {
      await pair.connect(0);
      const healthy = (pair.a as any).peersByPubkey.get(pair.bPubkey);
      vi.useFakeTimers();
      pair.aTransports[1]!.confirmationGate = new Promise<void>((resolve) => { release = resolve; });
      let settled = false;
      const pending = pair.connect(1).then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      let duplicateSettled = false;
      const duplicate = pair.connect(1).then(
        () => { duplicateSettled = true; }, () => { duplicateSettled = true; },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(pair.aTransports[1]!.heartbeatSends).toBe(1);
      expect(settled).toBe(false);
      expect(duplicateSettled).toBe(false);
      expect((pair.a as any).peersByPubkey.get(pair.bPubkey)).toBe(healthy);
      await pair.stop();
      await pending;
      await duplicate;
      expect(vi.getTimerCount()).toBe(0);
      release();
      await vi.advanceTimersByTimeAsync(15_000);
      expect((pair.a as any).peers.size).toBe(0);
    } finally {
      release?.();
      await pair.stop();
    }
  });

  it("preserves the FSP session when bootstrap closes while a direct FMP handshake is pending", async () => {
    const hub = new TransportHub();
    const aIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x41));
    const bIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x42));
    const aBootstrap = new ControlledTransport("websocket", hub);
    const bBootstrap = new ControlledTransport("websocket", hub);
    const aDirect = new ControlledTransport("webrtc", hub);
    const bDirect = new ControlledTransport("webrtc", hub);
    const a = new FipsNode({
      identity: aIdentity,
      transports: [aBootstrap, aDirect],
    });
    const b = new FipsNode({
      identity: bIdentity,
      transports: [bBootstrap, bDirect],
    });
    const aPubkey = toHex(aIdentity.publicKey);
    const bPubkey = toHex(bIdentity.publicKey);
    const sessionStates: string[] = [];
    a.on("session", (event) => sessionStates.push((event as { state: string }).state));
    b.registerService(9000, async ({ payload, reply }) => reply(payload));

    await Promise.all([a.start(), b.start()]);
    try {
      await a.connect({ transport: "websocket", addr: bPubkey });
      await echo(a, bPubkey, "before-upgrade");
      expect(sessionStates).toContain("established");

      bDirect.holdOutgoing = true;
      const upgrade = a.connect({ transport: "webrtc", addr: bPubkey });
      await waitUntil(() => bDirect.heldCount() > 0);
      aBootstrap.disconnect({ transport: "websocket", addr: bPubkey });
      await new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });
      expect(sessionStates).not.toContain("closed");

      bDirect.holdOutgoing = false;
      bDirect.release();
      await upgrade;
      await echo(a, bPubkey, "after-upgrade");
      expect(sessionStates).not.toContain("closed");
      expect(aPubkey).not.toBe(bPubkey);
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  });
});

async function startPair(types: string[]) {
  const hub = new TransportHub();
  const aIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x51));
  const bIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x52));
  const aTransports = types.map((type) => new ControlledTransport(type, hub));
  const bTransports = types.map((type) => new ControlledTransport(type, hub));
  const a = new FipsNode({ identity: aIdentity, transports: aTransports });
  const b = new FipsNode({ identity: bIdentity, transports: bTransports });
  await Promise.all([a.start(), b.start()]);
  const aPubkey = toHex(aIdentity.publicKey);
  const bPubkey = toHex(bIdentity.publicKey);
  return {
    a, b, aPubkey, bPubkey, aTransports, bTransports,
    connect: (index: number) => a.connect({ transport: types[index]!, addr: bPubkey }),
    stop: () => Promise.all([a.stop(), b.stop()]),
  };
}

async function echo(node: FipsNode, remotePubkey: string, payload: string): Promise<void> {
  const expected = new TextEncoder().encode(payload);
  const received = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("echo timeout")), 5_000);
    const off = node.on("datagram", (event) => {
      const datagram = event as { dstPort: number; payload: Uint8Array };
      if (datagram.dstPort !== 9000 || toHex(datagram.payload) !== toHex(expected)) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
  await node.sendDatagram({
    dst: remotePubkey,
    srcPort: 9000,
    dstPort: 9000,
    payload: expected,
  });
  await received;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timeout");
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}
