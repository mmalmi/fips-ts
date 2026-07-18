import { describe, expect, it } from "vitest";

import {
  FipsNode,
  identityFromSecretKey,
  toHex,
  type Transport,
  type TransportAddress,
  type TransportContext,
} from "../src/index.js";

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

describe("physical path upgrade", () => {
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
