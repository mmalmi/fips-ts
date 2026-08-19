import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FipsNode,
  FMP_PHASE_MSG1,
  FMP_PHASE_MSG2,
  identityFromSecretKey,
  peekFmpPhase,
  toHex,
  type Transport,
  type TransportAddress,
  type TransportContext,
} from "../src/index.js";

const transports = new Map<string, IdentityAliasTransport>();
const mutableAddressTransports = new Map<string, MutableAddressTransport>();

class IdentityAliasTransport implements Transport {
  readonly type = "identity_alias";
  readonly mtu = 1_200;
  capturedMsg1?: Uint8Array;
  dropNextMsg2 = false;
  closeCurrentCarrierOnRestart = false;
  readonly restartedPeers: string[] = [];

  private ctx?: TransportContext;
  private localXOnly = "";
  private readonly closedPeers = new Set<string>();

  async start(ctx: TransportContext): Promise<void> {
    this.ctx = ctx;
    this.localXOnly = toHex(ctx.localIdentity.xOnlyPubkey);
    transports.set(this.localXOnly, this);
  }

  async stop(): Promise<void> {
    if (transports.get(this.localXOnly) === this) transports.delete(this.localXOnly);
    this.ctx = undefined;
  }

  async connect(addr: TransportAddress): Promise<void> {
    if (!transports.has(xOnly(addr.addr))) throw new Error(`missing alias peer ${addr.addr}`);
  }

  async send(addr: TransportAddress, packet: Uint8Array): Promise<void> {
    if (this.closedPeers.has(xOnly(addr.addr))) {
      throw new Error("restart callback closed the authenticated replacement carrier");
    }
    const phase = peekFmpPhase(packet);
    if (phase === FMP_PHASE_MSG1 && !this.capturedMsg1) {
      this.capturedMsg1 = new Uint8Array(packet);
    }
    if (phase === FMP_PHASE_MSG2 && this.dropNextMsg2) {
      this.dropNextMsg2 = false;
      return;
    }
    const remote = transports.get(xOnly(addr.addr));
    if (!remote?.ctx) throw new Error(`missing alias peer ${addr.addr}`);
    remote.ctx.onPacket({
      transportType: this.type,
      remoteAddr: { transport: this.type, addr: this.localXOnly },
      data: new Uint8Array(packet),
      receivedAtMs: Date.now(),
    });
  }

  async handlePeerRestart(remotePubkeyHex: string): Promise<void> {
    this.restartedPeers.push(remotePubkeyHex);
    if (this.closeCurrentCarrierOnRestart) {
      this.closedPeers.add(xOnly(remotePubkeyHex));
    }
  }
}

class RestartTrackingTransport implements Transport {
  readonly type = "webrtc";
  readonly mtu = 1_200;
  readonly restartedPeers: string[] = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async connect(): Promise<void> { throw new Error("restart tracker cannot connect"); }
  async send(): Promise<void> { throw new Error("restart tracker cannot send"); }

  async handlePeerRestart(remotePubkeyHex: string): Promise<void> {
    this.restartedPeers.push(remotePubkeyHex);
  }
}

class AddressOnlyTransport implements Transport {
  readonly mtu = 1_200;
  closeCalls = 0;

  constructor(readonly type: "ethernet" | "memory") {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async connect(): Promise<void> { throw new Error(`${this.type} cannot connect in this test`); }
  async send(): Promise<void> { throw new Error(`${this.type} cannot send in this test`); }

  async close(): Promise<void> {
    this.closeCalls += 1;
    throw new Error(`${this.type} close requires its own transport address`);
  }
}

class MutableAddressTransport implements Transport {
  readonly type = "mutable_address";
  readonly mtu = 1_200;
  readonly identityMayChangeAtAddress = true;
  private ctx?: TransportContext;

  constructor(private readonly localAddress: string) {}

  async start(ctx: TransportContext): Promise<void> {
    this.ctx = ctx;
    mutableAddressTransports.set(this.localAddress, this);
  }

  async stop(): Promise<void> {
    if (mutableAddressTransports.get(this.localAddress) === this) {
      mutableAddressTransports.delete(this.localAddress);
    }
    this.ctx = undefined;
  }

  async connect(addr: TransportAddress): Promise<void> {
    if (!mutableAddressTransports.has(addr.addr)) throw new Error(`missing peer ${addr.addr}`);
  }

  async send(addr: TransportAddress, packet: Uint8Array): Promise<void> {
    const remote = mutableAddressTransports.get(addr.addr);
    if (!remote?.ctx) throw new Error(`missing peer ${addr.addr}`);
    remote.ctx.onPacket({
      transportType: this.type,
      remoteAddr: { transport: this.type, addr: this.localAddress },
      data: new Uint8Array(packet),
      receivedAtMs: Date.now(),
    });
  }
}

function xOnly(addr: string): string {
  const lower = addr.toLowerCase();
  return /^(02|03)[0-9a-f]{64}$/u.test(lower) ? lower.slice(2) : lower;
}

afterEach(() => {
  transports.clear();
  mutableAddressTransports.clear();
});

describe("FMP replacement-page address aliases", () => {
  it("authenticates a new identity after a mutable Ethernet-style address is reused", async () => {
    const browserIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x11));
    const firstGuestIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x12));
    const nextGuestIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x13));
    const browserAddress = toHex(browserIdentity.publicKey);
    const guestAddress = "guest-mac";
    const browser = new FipsNode({
      identity: browserIdentity,
      transports: [new MutableAddressTransport(browserAddress)],
      heartbeatIntervalMs: 60_000,
    });
    const peerEvents: Array<{ remotePubkey: string; state: string }> = [];
    browser.on("peer", (event) => {
      const peer = event as { remotePubkey: string; state: string };
      peerEvents.push({ remotePubkey: peer.remotePubkey, state: peer.state });
    });
    const firstGuest = new FipsNode({
      identity: firstGuestIdentity,
      transports: [new MutableAddressTransport(guestAddress)],
      heartbeatIntervalMs: 60_000,
    });

    await browser.start();
    await firstGuest.start();
    try {
      await firstGuest.connect({ transport: "mutable_address", addr: browserAddress });
      await firstGuest.stop();

      const nextGuest = new FipsNode({
        identity: nextGuestIdentity,
        transports: [new MutableAddressTransport(guestAddress)],
        heartbeatIntervalMs: 60_000,
      });
      const browserError = new Promise<Error>((resolve) => {
        browser.on("error", (event) => resolve((event as { err: Error }).err));
      });
      await nextGuest.start();
      try {
        const outcome = await Promise.race([
          nextGuest.connect({ transport: "mutable_address", addr: browserAddress })
            .then(() => "connected" as const),
          browserError.then(() => "error" as const),
        ]);
        expect(outcome).toBe("connected");
        const peers = (browser as any).peersByNodeAddr as Map<string, unknown>;
        expect(peers.has(toHex(firstGuestIdentity.nodeAddr))).toBe(false);
        expect(peers.has(toHex(nextGuestIdentity.nodeAddr))).toBe(true);
        expect(peers.size).toBe(1);
        expect(peerEvents).toEqual([
          { remotePubkey: toHex(firstGuestIdentity.publicKey), state: "connected" },
          { remotePubkey: toHex(firstGuestIdentity.publicKey), state: "disconnected" },
          { remotePubkey: toHex(nextGuestIdentity.publicKey), state: "connected" },
        ]);
      } finally {
        await nextGuest.stop();
      }
    } finally {
      await browser.stop();
      await firstGuest.stop();
    }
  });

  it("keeps the authenticating carrier and skips address-only transports", async () => {
    const survivorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x21));
    const restartedIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x32));
    const survivorTransport = new IdentityAliasTransport();
    const displacedTransport = new RestartTrackingTransport();
    const ethernetTransport = new AddressOnlyTransport("ethernet");
    const memoryTransport = new AddressOnlyTransport("memory");
    const original = new FipsNode({
      identity: restartedIdentity,
      transports: [new IdentityAliasTransport()],
      heartbeatIntervalMs: 60_000,
    });
    const survivor = new FipsNode({
      identity: survivorIdentity,
      transports: [
        survivorTransport,
        displacedTransport,
        ethernetTransport,
        memoryTransport,
      ],
      heartbeatIntervalMs: 60_000,
    });
    const restartedAddr = {
      transport: "identity_alias",
      addr: toHex(restartedIdentity.publicKey),
    };

    await survivor.start();
    await original.start();
    try {
      await survivor.connect(restartedAddr);
      await original.stop();
      survivorTransport.closeCurrentCarrierOnRestart = true;

      const replacement = new FipsNode({
        identity: restartedIdentity,
        transports: [new IdentityAliasTransport()],
        heartbeatIntervalMs: 60_000,
      });
      const survivorError = new Promise<Error>((resolve) => {
        survivor.on("error", (event) => resolve((event as { err: Error }).err));
      });
      await replacement.start();
      try {
        const connected = replacement.connect({
          transport: "identity_alias",
          addr: toHex(survivorIdentity.publicKey),
        });
        const outcome = await Promise.race([
          connected.then(() => "connected" as const),
          survivorError.then(() => "error" as const),
        ]);

        expect(outcome).toBe("connected");
        expect(survivorTransport.restartedPeers).toEqual([]);
        expect(displacedTransport.restartedPeers).toEqual([
          toHex(restartedIdentity.publicKey),
        ]);
        expect(ethernetTransport.closeCalls).toBe(0);
        expect(memoryTransport.closeCalls).toBe(0);
      } finally {
        await replacement.stop();
      }
    } finally {
      await survivor.stop();
      await original.stop();
    }
  }, 10_000);

  it("dispatches Msg2 by receiver index and replaces a replayed responder path", async () => {
    const survivorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x31));
    const restartedIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x42));
    const survivorTransport = new IdentityAliasTransport();
    const displacedTransport = new RestartTrackingTransport();
    const originalTransport = new IdentityAliasTransport();
    const survivor = new FipsNode({
      identity: survivorIdentity,
      transports: [survivorTransport, displacedTransport],
      heartbeatIntervalMs: 60_000,
    });
    const original = new FipsNode({
      identity: restartedIdentity,
      transports: [originalTransport],
      heartbeatIntervalMs: 60_000,
    });
    let request: Uint8Array | undefined;
    let reply: Uint8Array | undefined;
    survivor.registerService(7_401, async ({ payload, reply: sendReply }) => {
      request = payload;
      await sendReply(new Uint8Array([7, 4, 2]));
    });
    const restartedAddr = {
      transport: "identity_alias",
      addr: toHex(restartedIdentity.publicKey),
    };

    await survivor.start();
    await original.start();
    try {
      await survivor.connect(restartedAddr);
      const staleMsg1 = survivorTransport.capturedMsg1!;
      await original.stop();

      const replacementTransport = new IdentityAliasTransport();
      const replacement = new FipsNode({
        identity: restartedIdentity,
        transports: [replacementTransport],
        heartbeatIntervalMs: 60_000,
      });
      const errors: Error[] = [];
      replacement.on("error", (event) => errors.push((event as { err: Error }).err));
      replacement.registerService(7_402, ({ payload }) => {
        reply = payload;
      });
      await replacement.start();
      try {
        // A relay can replay the survivor's recent Msg1 into the replacement
        // page. The response is intentionally lost, leaving a half-open
        // responder under the incoming x-only address.
        replacementTransport.dropNextMsg2 = true;
        await survivorTransport.send(restartedAddr, staleMsg1);

        const error = new Promise<Error>((resolve) => {
          replacement.on("error", (event) => resolve((event as { err: Error }).err));
        });
        const connected = replacement.connect({
          transport: "identity_alias",
          addr: toHex(survivorIdentity.publicKey),
        }).then(() => undefined);
        const outcome = await Promise.race([
          connected.then(() => "connected" as const),
          error.then(() => "error" as const),
        ]);

        expect(outcome).toBe("connected");
        expect(errors).toEqual([]);
        const peers = [...(replacement as any).peers.values()];
        expect(peers).toHaveLength(1);
        expect(peers[0].link.role).toBe("initiator");
        expect(peers[0].remoteAddr.addr).toBe(toHex(survivorIdentity.publicKey));
        expect(survivorTransport.restartedPeers).toEqual([]);
        expect(displacedTransport.restartedPeers).toEqual([
          toHex(restartedIdentity.publicKey),
        ]);

        await replacement.sendDatagram({
          dst: toHex(survivorIdentity.publicKey),
          srcPort: 7_402,
          dstPort: 7_401,
          payload: new Uint8Array([7, 4, 1]),
        });
        await vi.waitFor(() => {
          expect(request).toEqual(new Uint8Array([7, 4, 1]));
          expect(reply).toEqual(new Uint8Array([7, 4, 2]));
        });
        expect(errors).toEqual([]);
      } finally {
        await replacement.stop();
      }
    } finally {
      await survivor.stop();
      await original.stop();
    }
  }, 10_000);
});
