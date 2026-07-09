import { describe, expect, it } from "vitest";

import {
  FipsNode,
  FmpLink,
  FMP_PHASE_MSG1,
  generateIdentity,
  peekFmpPhase,
  toHex,
  type DiscoveredPeer,
  type Transport,
  type TransportAddress,
  type TransportContext,
} from "../src/index.js";

class DiscoveringTransport implements Transport {
  readonly type = "discovering";
  readonly mtu = 1200;
  readonly connected: TransportAddress[] = [];
  readonly sentPhases: number[] = [];
  private ctx?: TransportContext;
  private readonly peer: DiscoveredPeer;
  private readonly responder: FmpLink;

  constructor(peer: DiscoveredPeer, responder: FmpLink) {
    this.peer = peer;
    this.responder = responder;
  }

  async start(ctx: TransportContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {
    this.ctx = undefined;
  }

  async connect(addr: TransportAddress): Promise<void> {
    this.connected.push(addr);
  }

  async send(addr: TransportAddress, packet: Uint8Array): Promise<void> {
    const phase = peekFmpPhase(packet);
    this.sentPhases.push(phase);
    if (phase !== FMP_PHASE_MSG1) return;
    const result = this.responder.handleMsg1(packet, () => new Uint8Array(32));
    queueMicrotask(() => {
      this.ctx?.onPacket({
        transportType: this.type,
        remoteAddr: addr,
        data: result.reply!,
        receivedAtMs: Date.now(),
      });
    });
  }

  async *discover(): AsyncIterable<DiscoveredPeer> {
    yield this.peer;
  }
}

describe("FipsNode transport discovery", () => {
  it("turns a discovered identity hint into a real FMP connection", async () => {
    const local = await generateIdentity();
    const remote = await generateIdentity();
    const remoteAddr = { transport: "discovering", addr: "aa:bb:cc:dd:ee:ff" };
    const transport = new DiscoveringTransport(
      { remoteAddr, publicKey: remote.publicKey },
      new FmpLink({
        identity: remote,
        role: "responder",
        sessionIdx: 42,
      }),
    );
    const node = new FipsNode({ identity: local, transports: [transport] });

    const connected = new Promise<void>((resolve) => {
      node.on("peer", (event) => {
        const peer = event as { remotePubkey: string; state: string };
        if (peer.remotePubkey === toHex(remote.publicKey) && peer.state === "connected") {
          resolve();
        }
      });
    });

    await node.start();
    try {
      await connected;
      expect(transport.connected).toEqual([remoteAddr]);
      expect(transport.sentPhases).toContain(FMP_PHASE_MSG1);
    } finally {
      await node.stop();
    }
  });
});
