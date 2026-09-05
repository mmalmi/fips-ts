import { afterEach, describe, expect, it, vi } from "vitest";

import { FspReceiverReports } from "../src/fsp/receiverReports.js";
import { FspSession } from "../src/fsp/session.js";
import { FSP_MSG_DATA, FSP_MSG_RECEIVER_REPORT } from "../src/fsp/wire.js";
import { identityFromSecretKey } from "../src/identity/index.js";
import { FspSessionManager } from "../src/node/FspSessionManager.js";
import type { FipsRouting } from "../src/node/FipsRouting.js";

afterEach(() => vi.useRealTimers());

describe("FSP receiver reports", () => {
  it("encodes Rust's 66-byte body with lifetime, interval, gap and reordered counts", () => {
    const receiver = new FspReceiverReports();
    receiver.record({ counter: 0n, timestamp: 100, bytes: 20 }, 1_000);
    receiver.record({ counter: 3n, timestamp: 200, bytes: 30 }, 1_100);
    receiver.record({ counter: 1n, timestamp: 150, bytes: 40 }, 1_150);
    const body = receiver.build(1_175)!;
    const view = new DataView(body.buffer);
    expect(body.length).toBe(66);
    expect(view.getUint16(0, true)).toBe(0);
    expect(view.getBigUint64(2, true)).toBe(3n);
    expect(view.getBigUint64(10, true)).toBe(3n);
    expect(view.getBigUint64(18, true)).toBe(90n);
    expect(view.getUint32(26, true)).toBe(150);
    expect(view.getUint16(30, true)).toBe(25);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(512);
    expect(view.getUint16(36, true)).toBe(0);
    expect(view.getUint32(38, true)).toBe(6_250);
    expect(view.getUint32(50, true)).toBe(1);
    expect(view.getUint32(54, true)).toBe(1);
    expect(view.getUint32(58, true)).toBe(3);
    expect(view.getUint32(62, true)).toBe(90);
    expect(receiver.build(1_200)).toBeUndefined();
    receiver.record({ counter: 4n, timestamp: 300, bytes: 10 }, 1_300);
    const next = new DataView(receiver.build(1_300)!.buffer);
    expect(next.getBigUint64(10, true)).toBe(4n);
    expect(next.getBigUint64(18, true)).toBe(100n);
    expect(next.getUint32(58, true)).toBe(1);
    expect(next.getUint16(32, true)).toBe(0);
  });

  it("preserves lifetime totals through rekey without mixing old counters or timestamps", () => {
    const receiver = new FspReceiverReports();
    receiver.record({ counter: 1n << 60n, timestamp: 99_000, bytes: 40 }, 1);
    receiver.build(2);
    receiver.resetEpoch();
    receiver.record({ counter: 0n, timestamp: 5, bytes: 20 }, 10);
    receiver.record({ counter: (1n << 60n) + 1n, timestamp: 99_100, bytes: 30 }, 15, false);
    const view = new DataView(receiver.build(20)!.buffer);
    expect(view.getBigUint64(2, true)).toBe(0n);
    expect(view.getBigUint64(10, true)).toBe(3n);
    expect(view.getBigUint64(18, true)).toBe(90n);
    expect(view.getUint32(26, true)).toBe(5);
    expect(view.getUint16(30, true)).toBe(10);
    expect(view.getUint32(58, true)).toBe(1);
    expect(view.getUint32(54, true)).toBe(0);
  });

  it("handles timestamp wrap and marks an expired RTT echo unusable", () => {
    const receiver = new FspReceiverReports();
    receiver.record({ counter: 0n, timestamp: 0xffff_fffa, bytes: 6 }, 100);
    receiver.record({ counter: 1n, timestamp: 4, bytes: 6 }, 110);
    const view = new DataView(receiver.build(70_000)!.buffer);
    expect(view.getUint32(26, true)).toBe(0);
    expect(view.getUint16(30, true)).toBe(0xffff);
    expect(view.getUint32(38, true)).toBe(0);
    expect(view.getInt32(46, true)).toBe(0);
  });

  it("authenticates reports, rejects forged/replayed observations, and stops its bounded cadence", async () => {
    vi.useFakeTimers();
    const initiatorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x41));
    const responderIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x42));
    const replies: Uint8Array[] = [];
    let sendBarrier: Promise<void> | undefined;
    const manager = new FspSessionManager({
      identity: responderIdentity,
      random: { bytes: (length) => new Uint8Array(length).fill(0x43) },
      localEpoch: new Uint8Array(8),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      routing: {
        coords: [responderIdentity.nodeAddr],
        coordinatesFor: () => undefined,
        learnReverseRoute() {},
        async sendFspReplyToward(_addr: Uint8Array, frame: Uint8Array) { replies.push(frame); },
        async sendFspToward(_addr: Uint8Array, frame: Parameters<FipsRouting["sendFspToward"]>[1]) {
          replies.push(...(typeof frame === "function" ? frame({} as never) : [frame]));
          await sendBarrier;
        },
      } as never,
      getPeerByNodeAddr: () => undefined,
      emitDatagram() {},
      emitEndpointData() {},
      async handleLinkNegotiation() {},
      emitSession() {},
    });
    const initiator = new FspSession({
      identity: initiatorIdentity,
      role: "initiator",
      remotePubkey: responderIdentity.publicKey,
    });
    const receive = (frame: Uint8Array) => manager.handleFromPeer({} as never, initiatorIdentity.nodeAddr, frame);
    try {
      await receive(initiator.buildSessionSetup(() => new Uint8Array(), initiatorIdentity.nodeAddr, responderIdentity.nodeAddr));
      await receive(initiator.handleSessionAck(replies.shift()!, () => new Uint8Array()));
      manager.start();
      const record = initiator.encryptEndpointData(new Uint8Array(10));
      const forged = new Uint8Array(record);
      forged[4] = 200;
      await expect(receive(forged)).rejects.toThrow();
      await receive(record);
      await expect(receive(record)).rejects.toThrow(/replay/);
      await receive(initiator.encryptKeepalive());
      // Delivery feedback counts authenticated bytes even if the application
      // envelope is malformed; that is separate from a failed AEAD/replay.
      await expect(receive(initiator.encryptMessage(FSP_MSG_DATA, new Uint8Array(3)))).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(999);
      expect(replies).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(replies.length).toBe(1);
      const report = initiator.decryptIncoming(replies.shift()!);
      expect(report.msgType).toBe(FSP_MSG_RECEIVER_REPORT);
      const view = new DataView(report.payload!.buffer, report.payload!.byteOffset);
      expect(view.getBigUint64(2, true)).toBe(2n);
      expect(view.getBigUint64(10, true)).toBe(3n);
      expect(view.getBigUint64(18, true)).toBe(31n); // 3 × 6-byte inner header + 10 + 3 data bytes
      await vi.advanceTimersByTimeAsync(2_000);
      expect(replies).toEqual([]);
      let release!: () => void;
      sendBarrier = new Promise<void>((resolve) => { release = resolve; });
      await receive(initiator.encryptKeepalive());
      await vi.advanceTimersByTimeAsync(1_000);
      await receive(initiator.encryptKeepalive());
      await vi.advanceTimersByTimeAsync(2_000);
      expect(replies.length).toBe(1); // A blocked transport cannot accumulate report batches.
      release();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(replies.length).toBe(2);
      manager.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      manager.stop();
    }
  });
});
