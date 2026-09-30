import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FipsNode, FmpLink, FMP_PHASE_MSG1, identityFromSecretKey, peekFmpPhase, toHex,
  type FipsIdentity, type Transport, type TransportAddress, type TransportContext,
} from "../src/index.js";
import { LinkMessageType } from "../src/protocol/link.js";
import { FmpReceiverReports } from "../src/fmp/receiverReports.js";

class SeedTransport implements Transport {
  readonly type = "reports";
  readonly mtu = 1_200;
  readonly received: Array<{ msgType: number; payload: Uint8Array }> = [];
  reportBarrier?: Promise<void>;
  private ctx?: TransportContext;
  constructor(public link: FmpLink, readonly identity: FipsIdentity) {}
  async start(ctx: TransportContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> { this.ctx = undefined; }
  async connect(_addr: TransportAddress): Promise<void> {}
  async send(_addr: TransportAddress, packet: Uint8Array): Promise<void> {
    if (peekFmpPhase(packet) === FMP_PHASE_MSG1) {
      this.inject(this.link.handleMsg1(packet, () => new Uint8Array(32)).reply!);
    } else {
      const received = this.link.decryptIncoming(packet);
      this.received.push(received);
      if (received.msgType === LinkMessageType.ReceiverReport) await this.reportBarrier;
    }
  }
  inject(packet: Uint8Array): void {
    this.ctx?.onPacket({
      transportType: this.type,
      remoteAddr: { transport: this.type, addr: toHex(this.identity.publicKey) },
      data: packet, receivedAtMs: Date.now(),
    });
  }
  sendMessage(type: number, payload = new Uint8Array(0)): Uint8Array {
    const packet = this.link.encryptOutgoing(payload, type);
    this.inject(packet);
    return packet;
  }
  reports(): Uint8Array[] {
    return this.received.filter(({ msgType }) => msgType === LinkMessageType.ReceiverReport)
      .map(({ payload }) => payload);
  }
  reconnect(): void {
    this.ctx?.onConnectionState?.({
      remoteAddr: { transport: this.type, addr: toHex(this.identity.publicKey) }, state: "disconnected",
    });
    this.link.close();
    this.link = new FmpLink({
      identity: this.identity, role: "responder", sessionIdx: 8, localEpoch: new Uint8Array(8),
    });
  }
}

async function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
  const identity = await identityFromSecretKey(new Uint8Array(32).fill(0x21));
  const seed = await identityFromSecretKey(new Uint8Array(32).fill(0x22));
  const link = new FmpLink({
    identity: seed, role: "responder", sessionIdx: 7, localEpoch: new Uint8Array(8),
  });
  const transport = new SeedTransport(link, seed);
  const node = new FipsNode({ identity, transports: [transport] });
  const errors: Error[] = [];
  node.on("error", ({ err }: { err: Error }) => errors.push(err));
  await node.start();
  await node.connect({ transport: transport.type, addr: toHex(seed.publicKey) });
  return { node, transport, clock, errors };
}

function view(payload: Uint8Array): DataView {
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("FMP link receiver reports", () => {
  it("reports observed CE flags and keeps loss statistics scoped to each interval", () => {
    const receiver = new FmpReceiverReports();
    receiver.record({ counter: 0n, timestamp: 100, bytes: 40, ceFlag: true }, 1_000);
    receiver.record({ counter: 2n, timestamp: 200, bytes: 40 }, 1_100);
    const first = view(receiver.forSenderReport(new Uint8Array(47), 1_100)!);
    expect(first.getUint32(43, true)).toBe(1);
    expect(first.getUint16(35, true)).toBe(256);
    receiver.record({ counter: 4n, timestamp: 400, bytes: 40, ceFlag: true }, 1_300);
    const next = view(receiver.forSenderReport(new Uint8Array(47), 1_300)!);
    expect(next.getUint32(43, true)).toBe(2);
    expect(next.getUint16(35, true)).toBe(256);
  });

  it("answers a native sender report with measured frame counters, bytes and timestamp echo", async () => {
    const { node, transport, clock, errors } = await setup();
    try {
      clock.mockReturnValue(1_100);
      const first = transport.sendMessage(LinkMessageType.Heartbeat);
      transport.link.encryptKeepalive(); // Lost counter 1: never received by the client.
      clock.mockReturnValue(1_200);
      const second = transport.sendMessage(LinkMessageType.Heartbeat);
      clock.mockReturnValue(1_300);
      const sr = transport.sendMessage(LinkMessageType.SenderReport, new Uint8Array(47));
      await Promise.resolve();
      expect(transport.reports()).toHaveLength(1);
      const body = transport.reports()[0]!;
      expect(body).toHaveLength(67);
      const report = view(body);
      expect(report.getBigUint64(3, true)).toBe(3n);
      expect(report.getBigUint64(11, true)).toBe(3n);
      expect(report.getBigUint64(19, true)).toBe(BigInt(first.length + second.length + sr.length));
      expect(report.getUint32(27, true)).toBe(300);
      expect(report.getUint16(31, true)).toBe(0);
      expect(report.getUint16(33, true)).toBe(1); // One observed missing frame.
      expect(report.getUint32(59, true)).toBe(3);
      expect(report.getUint32(63, true)).toBe(first.length + second.length + sr.length);
      expect(errors).toEqual([]);
    } finally { await node.stop(); }
  });

  it("does not respond to receiver reports or malformed sender reports, and bounds responses", async () => {
    const { node, transport, clock } = await setup();
    try {
      clock.mockReturnValue(1_100);
      transport.sendMessage(LinkMessageType.ReceiverReport, new Uint8Array(67));
      transport.sendMessage(LinkMessageType.SenderReport, new Uint8Array(46));
      expect(transport.reports()).toHaveLength(0);
      transport.sendMessage(LinkMessageType.SenderReport, new Uint8Array(47));
      expect(transport.reports()).toHaveLength(1);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      for (let i = 0; i < 10; i++) {
        transport.sendMessage(LinkMessageType.SenderReport, new Uint8Array(47));
      }
      clock.mockReturnValue(1_299);
      transport.sendMessage(LinkMessageType.SenderReport, new Uint8Array(47));
      expect(transport.reports()).toHaveLength(1);
      clock.mockReturnValue(1_300);
      transport.sendMessage(LinkMessageType.SenderReport, new Uint8Array(47));
      expect(transport.reports()).toHaveLength(2);
      expect(view(transport.reports()[1]!).getUint32(59, true)).toBe(12);
      await node.stop();
      const count = transport.received.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(transport.received).toHaveLength(count);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await node.stop(); }
  });

  it("starts fresh report counters when the same peer reconnects", async () => {
    const { node, transport, clock } = await setup();
    try {
      for (let connection = 0; connection < 2; connection++) {
        clock.mockReturnValue(2_000 + connection * 1_000);
        transport.sendMessage(LinkMessageType.SenderReport, new Uint8Array(47));
        expect(transport.reports()).toHaveLength(connection + 1);
        const report = view(transport.reports()[connection]!);
        expect(report.getBigUint64(3, true)).toBe(0n);
        expect(report.getBigUint64(11, true)).toBe(1n);
        if (connection === 0) {
          transport.reconnect();
          await node.connect({ transport: transport.type, addr: toHex(transport.identity.publicKey) });
        }
      }
    } finally { await node.stop(); }
  });

  it("counts only authenticated non-replayed frames", async () => {
    const { node, transport, clock, errors } = await setup();
    try {
      clock.mockReturnValue(1_100);
      const packet = transport.link.encryptKeepalive();
      const forged = packet.slice();
      forged[forged.length - 1] ^= 1;
      transport.inject(forged);
      transport.inject(packet);
      transport.inject(packet);
      clock.mockReturnValue(1_200);
      transport.sendMessage(LinkMessageType.SenderReport, new Uint8Array(47));
      expect(transport.reports()).toHaveLength(1);
      expect(view(transport.reports()[0]!).getBigUint64(11, true)).toBe(2n);
      expect(errors).toHaveLength(2);
    } finally { await node.stop(); }
  });

  it("keeps one report in flight while the transport is blocked", async () => {
    const { node, transport, clock } = await setup();
    let release!: () => void;
    transport.reportBarrier = new Promise<void>((resolve) => { release = resolve; });
    try {
      for (let sample = 0; sample < 4; sample++) {
        clock.mockReturnValue(2_000 + sample * 1_000);
        transport.sendMessage(LinkMessageType.SenderReport, new Uint8Array(47));
      }
      expect(transport.reports()).toHaveLength(1);
      release();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      clock.mockReturnValue(6_000);
      transport.sendMessage(LinkMessageType.SenderReport, new Uint8Array(47));
      expect(transport.reports()).toHaveLength(2);
      expect(view(transport.reports()[1]!).getUint32(59, true)).toBe(4);
    } finally { release(); await node.stop(); }
  });
});
