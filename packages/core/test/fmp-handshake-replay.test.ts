import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FipsNode,
  FmpLink,
  FMP_PHASE_MSG2,
  identityFromSecretKey,
  peekFmpPhase,
  toHex,
  type Transport,
  type TransportAddress,
  type TransportContext,
} from "../src/index.js";

const transports = new Map<string, ReplayTransport>();

class ReplayTransport implements Transport {
  readonly type = "replay";
  readonly mtu = 1_200;
  delayFirstMsg2 = false;
  sentMsg2 = 0;

  private ctx?: TransportContext;
  private localAddr = "";
  private delayedMsg2?: { addr: TransportAddress; packet: Uint8Array };

  async start(ctx: TransportContext): Promise<void> {
    this.ctx = ctx;
    this.localAddr = toHex(ctx.localIdentity.publicKey);
    transports.set(this.localAddr, this);
  }

  async stop(): Promise<void> {
    transports.delete(this.localAddr);
    this.ctx = undefined;
  }

  async connect(addr: TransportAddress): Promise<void> {
    if (!transports.has(addr.addr)) throw new Error(`missing replay peer ${addr.addr}`);
  }

  async send(addr: TransportAddress, packet: Uint8Array): Promise<void> {
    if (peekFmpPhase(packet) === FMP_PHASE_MSG2) {
      this.sentMsg2 += 1;
      if (this.delayFirstMsg2 && this.sentMsg2 === 1) {
        this.delayedMsg2 = { addr, packet: new Uint8Array(packet) };
        return;
      }
    }

    this.deliver(addr, packet);
    if (this.sentMsg2 === 2 && this.delayedMsg2) {
      const delayed = this.delayedMsg2;
      this.delayedMsg2 = undefined;
      queueMicrotask(() => this.deliver(delayed.addr, delayed.packet));
    }
  }

  private deliver(addr: TransportAddress, packet: Uint8Array): void {
    const remote = transports.get(addr.addr);
    if (!remote?.ctx) throw new Error(`missing replay peer ${addr.addr}`);
    remote.ctx.onPacket({
      transportType: this.type,
      remoteAddr: { transport: this.type, addr: this.localAddr },
      data: new Uint8Array(packet),
      receivedAtMs: Date.now(),
    });
  }
}

afterEach(() => {
  transports.clear();
  vi.useRealTimers();
});

describe("FipsNode exact FMP handshake replay", () => {
  it("accepts only byte-exact Msg1 and Msg2 replays after establishment", async () => {
    const initiatorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x31));
    const responderIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x32));
    const initiator = new FmpLink({
      identity: initiatorIdentity,
      remotePubkey: responderIdentity.publicKey,
      role: "initiator",
      sessionIdx: 10,
      localEpoch: new Uint8Array(8).fill(0x11),
    });
    const responder = new FmpLink({
      identity: responderIdentity,
      role: "responder",
      sessionIdx: 20,
      localEpoch: new Uint8Array(8).fill(0x22),
    });
    const msg1 = initiator.buildMsg1(() => new Uint8Array(32)).packet;
    const msg2 = responder.handleMsg1(msg1, () => new Uint8Array(32)).reply!;
    initiator.handleMsg2(msg2);
    expect(responder.remoteEpoch).toEqual(new Uint8Array(8).fill(0x11));
    expect(initiator.remoteEpoch).toEqual(new Uint8Array(8).fill(0x22));

    expect(responder.handleMsg1(msg1, () => new Uint8Array(32)).reply).toEqual(msg2);
    expect(initiator.handleMsg2(msg2).established).toBe(true);

    const changedMsg1 = new Uint8Array(msg1);
    changedMsg1[changedMsg1.length - 1] ^= 1;
    const changedMsg2 = new Uint8Array(msg2);
    changedMsg2[changedMsg2.length - 1] ^= 1;
    expect(() => responder.handleMsg1(changedMsg1, () => new Uint8Array(32))).toThrow(
      "unexpected FMP Msg1 after establishment",
    );
    expect(() => initiator.handleMsg2(changedMsg2)).toThrow(
      "unexpected FMP Msg2 after establishment",
    );

    const payload = new Uint8Array([1, 2, 3]);
    const packet = initiator.encryptOutgoing(payload);
    const forged = packet.slice();
    new DataView(forged.buffer).setBigUint64(8, 0xffff_ffff_ffff_fffen, true);
    expect(() => responder.decryptIncoming(forged)).toThrow();
    expect(responder.decryptIncoming(packet).payload).toEqual(payload);
    expect(() => responder.decryptIncoming(packet)).toThrow(/replay/);

    // Reach the u64 boundary without sending 2^64 packets.
    Reflect.set(initiator, "txCounter", 0xffff_ffff_ffff_fffen);
    expect(responder.decryptIncoming(initiator.encryptOutgoing(payload)).payload).toEqual(payload);
    expect(() => initiator.encryptOutgoing(payload)).toThrow(/nonce exhausted/);
    expect(() => initiator.encryptOutgoing(payload)).toThrow(/nonce exhausted/);
  });

  it("reuses Msg2 after a Msg1 resend and keeps one usable authenticated peer", async () => {
    vi.useFakeTimers();
    const initiatorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x41));
    const responderIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x52));
    const initiatorTransport = new ReplayTransport();
    const responderTransport = new ReplayTransport();
    responderTransport.delayFirstMsg2 = true;
    const initiator = new FipsNode({
      identity: initiatorIdentity,
      transports: [initiatorTransport],
    });
    const responder = new FipsNode({
      identity: responderIdentity,
      transports: [responderTransport],
    });
    let initiatorConnected = 0;
    let responderConnected = 0;
    const errors: Error[] = [];
    initiator.on("peer", () => initiatorConnected += 1);
    responder.on("peer", () => responderConnected += 1);
    initiator.on("error", (event) => errors.push((event as { err: Error }).err));
    responder.on("error", (event) => errors.push((event as { err: Error }).err));
    let receivedPayload: Uint8Array | undefined;
    responder.registerService(7_001, ({ payload }) => {
      receivedPayload = payload;
    });

    await responder.start();
    await initiator.start();
    try {
      const connecting = initiator.connect({
        transport: "replay",
        addr: toHex(responderIdentity.publicKey),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await connecting;
      await vi.runAllTicks();

      await initiator.sendDatagram({
        dst: toHex(responderIdentity.publicKey),
        dstPort: 7_001,
        payload: new Uint8Array([7, 0, 1]),
      });
      await vi.runAllTicks();

      expect(responderTransport.sentMsg2).toBe(2);
      expect(initiatorConnected).toBe(1);
      expect(responderConnected).toBe(1);
      expect(errors).toEqual([]);
      expect(receivedPayload).toEqual(new Uint8Array([7, 0, 1]));
    } finally {
      await initiator.stop();
      await responder.stop();
    }
  });
});
