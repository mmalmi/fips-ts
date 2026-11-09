import { afterEach, describe, expect, it, vi } from "vitest";

import { toHex } from "../src/codec/hex.js";
import { FspSession } from "../src/fsp/session.js";
import { FSP_FLAG_K, peekFspPhase } from "../src/fsp/wire.js";
import { identityFromSecretKey } from "../src/identity/index.js";
import { encodeLinkNegotiationMessage } from "../src/linkNegotiation.js";
import { FspSessionManager } from "../src/node/FspSessionManager.js";
import type { FipsRouting } from "../src/node/FipsRouting.js";
import type { AdjacentPeer } from "../src/node/PeerState.js";
import {
  decodeSessionAck, decodeSessionSetup, encodeSessionAck, encodeSessionSetup,
} from "../src/protocol/session.js";

const random = (length: number) => new Uint8Array(length);
const capability = (kind: number, bits = 1) => Uint8Array.of(
  70, 73, 80, 83, 45, 69, 88, 84, 1, kind, bits & 255, bits >>> 8,
);
const zeroSetup = (frame: Uint8Array) => encodeSessionSetup({ ...decodeSessionSetup(frame), flags: 0 });
const zeroAck = (frame: Uint8Array) => encodeSessionAck({ ...decodeSessionAck(frame), flags: 0 });

afterEach(() => vi.useRealTimers());

async function identities() {
  return Promise.all([
    identityFromSecretKey(new Uint8Array(32).fill(0x32)),
    identityFromSecretKey(new Uint8Array(32).fill(0x74)),
  ]);
}

async function responderHarness() {
  const [remote, local] = await identities();
  let initiator: FspSession;
  let acknowledgement: Uint8Array;
  let beforeNextWrapped: (() => Promise<void>) | undefined;
  const records: Array<{ direct: boolean; data: ReturnType<FspSession["decryptIncoming"]> }> = [];
  const negotiations: unknown[] = [];
  const peer = {
    pubkey: remote.publicKey,
    nodeAddr: remote.nodeAddr,
    link: { state: "established" },
    transport: {
      mtu: 1200,
      send: async (_addr: unknown, packet: Uint8Array) => {
        records.push({ direct: true, data: initiator.decryptIncoming(packet) });
      },
    },
    remoteAddr: "synthetic-peer",
  } as unknown as AdjacentPeer;
  const manager = new FspSessionManager({
    identity: local, random: { bytes: random }, localEpoch: new Uint8Array(8).fill(9),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    routing: {
      coords: [local.nodeAddr], hasUsableRoute: () => true,
      coordinatesFor: () => [remote.nodeAddr], learnReverseRoute: () => {},
      sendFspReplyToward: async (_addr: Uint8Array, packet: Uint8Array) => { acknowledgement = packet; },
      sendFspToward: async (_addr: Uint8Array, value: Uint8Array | ((next: AdjacentPeer) => Uint8Array[])) => {
        const before = beforeNextWrapped;
        beforeNextWrapped = undefined;
        if (before) await before();
        const packets = typeof value === "function" ? value(peer) : [value];
        for (const packet of packets) records.push({ direct: false, data: initiator.decryptIncoming(packet) });
      },
    } as unknown as FipsRouting,
    getPeerByNodeAddr: () => peer,
    emitDatagram: () => {}, emitEndpointData: () => {}, emitSession: () => {},
    handleLinkNegotiation: async (_key, message) => { negotiations.push(message); },
  });
  async function handshake(
    epoch = 1, legacy = false, claimedSource = remote.nodeAddr,
    beforeMsg3?: (initiator: FspSession) => Promise<void>,
  ) {
    initiator = new FspSession({
      identity: remote, role: "initiator", remotePubkey: local.publicKey,
      localEpoch: new Uint8Array(8).fill(epoch),
    });
    const setup = initiator.buildSessionSetup(random, [remote.nodeAddr], [local.nodeAddr]);
    await manager.handleFromPeer(peer, claimedSource, encodeSessionSetup({
      ...decodeSessionSetup(setup), flags: legacy ? 4 : 0,
    }));
    const msg3 = initiator.handleSessionAck(zeroAck(acknowledgement!), random);
    if (beforeMsg3) await beforeMsg3(initiator);
    await manager.handleFromPeer(peer, claimedSource, msg3);
    return msg3;
  }
  async function receive(payload: Uint8Array, k = false, srcPort = 257) {
    const frame = initiator.encryptDatagram({ srcPort, dstPort: 257, payload }, k ? FSP_FLAG_K : 0);
    return manager.handleFromPeer(peer, remote.nodeAddr, frame);
  }
  const sendApp = () => manager.sendDatagram({ dst: toHex(remote.publicKey), dstPort: 42, payload: Uint8Array.of(7) });
  return { manager, peer, remote, records, negotiations, handshake, receive, sendApp,
    beforeNextWrapped: (before: () => Promise<void>) => { beforeNextWrapped = before; },
    currentInitiator: () => initiator };
}

async function initiatorHarness(writeMsg3: () => Promise<void>) {
  const [local, remote] = await identities();
  let responder: FspSession;
  let afterNextWrapped: (() => Promise<void>) | undefined;
  let setupAttempts = 0;
  const events: string[] = [];
  const received: ReturnType<FspSession["decryptIncoming"]>[] = [];
  const peer = { nodeAddr: remote.nodeAddr, pubkey: remote.publicKey } as AdjacentPeer;
  const manager = new FspSessionManager({
    identity: local, random: { bytes: random }, localEpoch: new Uint8Array(8),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    routing: {
      coords: [local.nodeAddr], hasUsableRoute: () => true, coordinatesFor: () => [remote.nodeAddr],
      sendFspToward: async (_addr: Uint8Array, value: Uint8Array | ((next: AdjacentPeer) => Uint8Array[])) => {
        if (typeof value === "function") {
          for (const packet of value(peer)) received.push(responder.decryptIncoming(packet));
          const after = afterNextWrapped;
          afterNextWrapped = undefined;
          if (after) await after();
        } else if (peekFspPhase(value) === 1) {
          setupAttempts++;
          responder = new FspSession({ identity: remote, role: "responder" });
          const ack = responder.handleSessionSetup(zeroSetup(value), random, [remote.nodeAddr]);
          await manager.handleFromPeer(peer, remote.nodeAddr, zeroAck(ack));
        } else if (peekFspPhase(value) === 3) {
          await writeMsg3();
          responder.handleSessionMsg3(value);
        }
      },
    } as unknown as FipsRouting,
    getPeerByNodeAddr: () => undefined, emitDatagram: () => {}, emitEndpointData: () => {},
    emitSession: event => { events.push(event.state); }, handleLinkNegotiation: async () => {},
  });
  return { manager, received, events,
    setupAttempts: () => setupAttempts,
    afterNextWrapped: (after: () => Promise<void>) => { afterNextWrapped = after; },
    send: () => manager.sendDatagram({
    dst: toHex(remote.publicKey), dstPort: 42, payload: Uint8Array.of(7),
  }) };
}

describe("FSP authenticated extension negotiation", () => {
  it("writes zero body flags for every fresh and replacement Setup/Ack", async () => {
    const [a, b] = await identities();
    for (const epoch of [1, 1, 2]) {
      const initiator = new FspSession({ identity: a, role: "initiator", remotePubkey: b.publicKey, localEpoch: new Uint8Array(8).fill(epoch) });
      const responder = new FspSession({ identity: b, role: "responder" });
      const setup = initiator.buildSessionSetup(random, [a.nodeAddr], [b.nodeAddr]);
      const ack = responder.handleSessionSetup(zeroSetup(setup), random, [b.nodeAddr]);
      expect([decodeSessionSetup(setup).flags, decodeSessionAck(ack).flags]).toEqual([0, 0]);
      responder.handleSessionMsg3(initiator.handleSessionAck(ack, random));
    }
  });

  it("defers legacy Setup support until authenticated Msg3", async () => {
    const [a, b] = await identities();
    const initiator = new FspSession({ identity: a, role: "initiator", remotePubkey: b.publicKey });
    const responder = new FspSession({ identity: b, role: "responder" });
    const setup = encodeSessionSetup({ ...decodeSessionSetup(initiator.buildSessionSetup(random, [a.nodeAddr], [b.nodeAddr])), flags: 4 });
    const ack = responder.handleSessionSetup(setup, random, [b.nodeAddr]);
    expect(responder.remoteSupportsDirectFspTransport).toBe(false);
    responder.handleSessionMsg3(initiator.handleSessionAck(zeroAck(ack), random));
    expect(responder.remoteSupportsDirectFspTransport).toBe(true);
  });

  it("does not trust a legacy flag when Msg3 authentication fails", async () => {
    const [a, b] = await identities();
    const initiator = new FspSession({ identity: a, role: "initiator", remotePubkey: b.publicKey });
    const responder = new FspSession({ identity: b, role: "responder" });
    const setup = encodeSessionSetup({ ...decodeSessionSetup(initiator.buildSessionSetup(random, [a.nodeAddr], [b.nodeAddr])), flags: 4 });
    const ack = responder.handleSessionSetup(setup, random, [b.nodeAddr]);
    const msg3 = initiator.handleSessionAck(zeroAck(ack), random);
    msg3[msg3.length - 1] ^= 1;
    expect(() => responder.handleSessionMsg3(msg3)).toThrow();
    expect(responder.remoteSupportsDirectFspTransport).toBe(false);
  });

  it("learns legacy Ack support only after valid Msg2 authentication", async () => {
    const [a, b] = await identities();
    for (const corrupt of [false, true]) {
      const initiator = new FspSession({ identity: a, role: "initiator", remotePubkey: b.publicKey });
      const responder = new FspSession({ identity: b, role: "responder" });
      const setup = zeroSetup(initiator.buildSessionSetup(random, [a.nodeAddr], [b.nodeAddr]));
      const ack = encodeSessionAck({ ...decodeSessionAck(responder.handleSessionSetup(setup, random, [b.nodeAddr])), flags: 4 });
      expect(initiator.remoteSupportsDirectFspTransport).toBe(false);
      if (corrupt) {
        ack[ack.length - 1] ^= 1;
        expect(() => initiator.handleSessionAck(ack, random)).toThrow();
        expect(initiator.remoteSupportsDirectFspTransport).toBe(false);
      } else {
        responder.handleSessionMsg3(initiator.handleSessionAck(ack, random));
        expect(initiator.remoteSupportsDirectFspTransport).toBe(true);
      }
    }
  });

  it("sends one standard-wrapped request after authenticated Msg3 and ignores duplicate Msg3", async () => {
    const h = await responderHarness();
    try {
      const msg3 = await h.handshake();
      expect(h.records.map(record => ({ direct: record.direct, data: record.data.data }))).toEqual([
        { direct: false, data: { srcPort: 257, dstPort: 257, payload: capability(1) } },
      ]);
      await h.manager.handleFromPeer(h.peer, h.remote.nodeAddr, msg3);
      expect(h.records).toHaveLength(1);
      await h.sendApp();
      expect(h.records.at(-1)?.direct).toBe(false);
    } finally { h.manager.stop(); }
  });

  it("sends the initiator request only after Msg3 is actually sent", async () => {
    let releaseMsg3!: () => void;
    let msg3Started!: () => void;
    const msg3Pending = new Promise<void>(resolve => { releaseMsg3 = resolve; });
    const msg3Reached = new Promise<void>(resolve => { msg3Started = resolve; });
    const h = await initiatorHarness(async () => { msg3Started(); await msg3Pending; });
    const sending = h.send();
    try {
      await msg3Reached;
      expect(h.received).toHaveLength(0);
      releaseMsg3();
      await sending;
      expect(h.received.map(result => result.data?.dstPort)).toEqual([257, 42]);
      expect(h.received[0].data?.payload).toEqual(capability(1));
    } finally { releaseMsg3(); h.manager.stop(); }
  });

  it("sends no capability request when the actual Msg3 transport write rejects", async () => {
    const h = await initiatorHarness(async () => { throw new Error("synthetic Msg3 write failure"); });
    try {
      await expect(h.send()).rejects.toThrow("synthetic Msg3 write failure");
      expect(h.received).toHaveLength(0);
    } finally { h.manager.stop(); }
  });

  it("ignores a late Msg3 write after setup timeout or stop without replacing the original outcome", async () => {
    vi.useFakeTimers();
    for (const stop of [false, true]) {
      let releaseWrite!: () => void;
      const pendingWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
      const h = await initiatorHarness(() => pendingWrite);
      const sending = h.send().then(() => "sent", error => String(error));
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(h.events).toEqual(["establishing"]);
        if (stop) h.manager.stop();
        else await vi.advanceTimersByTimeAsync(15_000);
        expect(h.events).toEqual(["establishing", "closed"]);
        expect(h.received).toHaveLength(0);
        releaseWrite();
        expect(await sending).toContain(stop ? "FSP session manager stopped" : "FSP handshake timeout");
        expect(h.events).toEqual(["establishing", "closed"]);
        expect(h.received).toHaveLength(0);
        expect(h.setupAttempts()).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        releaseWrite();
        await sending;
        h.manager.stop();
      }
    }
  });

  it("completes setup while the optional capability write outlives the old deadline and rejects", async () => {
    vi.useFakeTimers();
    const h = await initiatorHarness(async () => {});
    let rejectWrite!: (error: Error) => void;
    const pendingWrite = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    void pendingWrite.catch(() => {});
    h.afterNextWrapped(() => pendingWrite);
    let completed = false;
    let failure: unknown;
    const sending = h.send().then(() => { completed = true; }, error => { failure = error; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(completed).toBe(true);
      expect(failure).toBeUndefined();
      expect(h.received.map(record => record.data?.dstPort)).toEqual([257, 42]);
      expect(h.received[0].data?.payload).toEqual(capability(1));
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(16_000);
      await h.send();
      expect(h.setupAttempts()).toBe(1);
      rejectWrite(new Error("synthetic optional capability write failure"));
      await vi.advanceTimersByTimeAsync(0);
      await h.send();
      expect(h.setupAttempts()).toBe(1);
      expect(h.received.map(record => record.data?.dstPort)).toEqual([257, 42, 42, 42]);
      h.manager.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      rejectWrite(new Error("synthetic cleanup"));
      await sending;
      h.manager.stop();
    }
  });

  it("drains queued authenticated data while an optional capability write waits through stop", async () => {
    vi.useFakeTimers();
    const h = await responderHarness();
    let rejectWrite!: (error: Error) => void;
    const pendingWrite = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    void pendingWrite.catch(() => {});
    let writing = false;
    h.beforeNextWrapped(async () => { writing = true; await pendingWrite; });
    const delivered: Uint8Array[] = [];
    const payload = Uint8Array.of(11, 22, 33);
    h.manager.registerService(42, ({ payload }) => { delivered.push(payload); });
    let completed = false;
    const establishing = h.handshake(1, false, h.remote.nodeAddr, async initiator => {
      await h.manager.handleFromPeer(h.peer, h.remote.nodeAddr,
        initiator.encryptDatagram({ srcPort: 41, dstPort: 42, payload }));
      expect(delivered).toHaveLength(0);
    }).then(() => { completed = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(writing).toBe(true);
      expect(completed).toBe(true);
      expect(delivered).toEqual([payload]);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(delivered).toEqual([payload]);
      h.manager.stop();
      rejectWrite(new Error("synthetic optional write rejected after stop"));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.records).toHaveLength(0);
      expect(delivered).toEqual([payload]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      rejectWrite(new Error("synthetic cleanup"));
      await establishing;
      h.manager.stop();
    }
  });

  it("responds standard-wrapped before enabling direct and never answers a response", async () => {
    const h = await responderHarness();
    try {
      await h.handshake();
      h.records.length = 0;
      const outcome = await h.receive(capability(1)).then(() => "accepted", error => String(error));
      expect(outcome).toBe("accepted");
      expect(h.records.map(record => [record.direct, record.data.data?.payload])).toEqual([[false, capability(2)]]);
      await h.sendApp();
      expect(h.records.at(-1)?.direct).toBe(true);
      h.records.length = 0;
      await h.receive(capability(2));
      expect(h.records).toHaveLength(0);
    } finally { h.manager.stop(); }
  });

  it("keeps direct disabled while the first response is pending or rejected", async () => {
    for (const reject of [false, true]) {
      const h = await responderHarness();
      let release!: () => void;
      let fail!: (error: Error) => void;
      let entered!: () => void;
      const pending = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      try {
        await h.handshake();
        h.records.length = 0;
        h.beforeNextWrapped(async () => { entered(); await pending; });
        const receiving = h.receive(capability(1)).then(() => "sent", () => "failed");
        await started;
        // A concurrently received response cannot bypass our first response's
        // successful standard-carrier write requirement.
        await h.receive(capability(2));
        await h.sendApp();
        expect(h.records.at(-1)?.direct).toBe(false);
        if (reject) fail(new Error("synthetic response write failure"));
        else release();
        expect(await receiving).toBe(reject ? "failed" : "sent");
        await h.sendApp();
        expect(h.records.at(-1)?.direct).toBe(!reject);
      } finally { release(); h.manager.stop(); }
    }
  });

  it("enables the known DIRECT bit while ignoring additional unknown bits", async () => {
    const h = await responderHarness();
    try {
      await h.handshake();
      await h.receive(capability(2, 0x8001));
      await h.sendApp();
      expect(h.records.at(-1)?.direct).toBe(true);
    } finally { h.manager.stop(); }
  });

  it("rejects tampered and replayed capabilities without a response or capability change", async () => {
    const h = await responderHarness();
    try {
      await h.handshake();
      h.records.length = 0;
      const frame = h.currentInitiator().encryptDatagram({ srcPort: 257, dstPort: 257, payload: capability(1) });
      const tampered = new Uint8Array(frame);
      tampered[tampered.length - 1] ^= 1;
      await expect(h.manager.handleFromPeer(h.peer, h.remote.nodeAddr, tampered)).rejects.toThrow();
      expect(h.records).toHaveLength(0);
      await h.sendApp();
      expect(h.records.at(-1)?.direct).toBe(false);
      h.records.length = 0;
      await h.manager.handleFromPeer(h.peer, h.remote.nodeAddr, frame);
      expect(h.records).toHaveLength(1);
      expect(h.records[0].data.data?.payload).toEqual(capability(2));
      await expect(h.manager.handleFromPeer(h.peer, h.remote.nodeAddr, frame)).rejects.toThrow();
      expect(h.records).toHaveLength(1);
      await h.sendApp();
      expect(h.records.at(-1)?.direct).toBe(true);
    } finally { h.manager.stop(); }
  });

  it("sends no capabilities when authenticated identity differs from the claimed source", async () => {
    const h = await responderHarness();
    try {
      const wrongSource = new Uint8Array(h.remote.nodeAddr);
      wrongSource[0] ^= 1;
      await expect(h.handshake(1, false, wrongSource)).rejects.toThrow("authenticated key does not match");
      expect(h.records).toHaveLength(0);
    } finally { h.manager.stop(); }
  });

  it("ignores unknown capability bits and preserves the JSON negotiation service", async () => {
    const h = await responderHarness();
    try {
      await h.handshake();
      const outcome = await h.receive(capability(2, 0x8000)).then(() => "accepted", error => String(error));
      expect(outcome).toBe("accepted");
      await h.sendApp();
      expect(h.records.at(-1)?.direct).toBe(false);
      const message = { version: 1 as const, negotiationId: "synthetic", linkType: "webrtc", kind: "reject" as const, createdAtMs: 1, expiresAtMs: 2, payload: {} };
      await h.receive(encodeLinkNegotiationMessage(message));
      expect(h.negotiations).toEqual([message]);
    } finally { h.manager.stop(); }
  });

  it("ignores malformed binary control without JSON fallback or direct enablement", async () => {
    const h = await responderHarness();
    try {
      await h.handshake();
      const badVersion = capability(1); badVersion[8] = 2;
      const badMagic = capability(1); badMagic[3] = 0;
      for (const payload of [capability(1).subarray(0, 7), capability(1).subarray(0, 11), capability(3), badVersion, badMagic]) {
        const outcome = await h.receive(payload).then(() => "ignored", error => String(error));
        expect(outcome).toBe("ignored");
      }
      await h.receive(capability(1), false, 258);
      expect(h.negotiations).toEqual([]);
      await h.sendApp();
      expect(h.records.at(-1)?.direct).toBe(false);
    } finally { h.manager.stop(); }
  });

  it("rejects binary controls after a corrupted opening brace while preserving UTF-8 JSON", async () => {
    const h = await responderHarness();
    try {
      await h.handshake();
      h.records.length = 0;
      const corrupt = capability(1); corrupt[0] = 0x7b;
      await expect(h.receive(corrupt)).resolves.toBeUndefined();
      expect(h.records).toHaveLength(0);
      expect(h.negotiations).toHaveLength(0);
      await h.sendApp();
      expect(h.records.at(-1)?.direct).toBe(false);
      const message = { version: 1 as const, negotiationId: "synthetic-unicode", linkType: "webrtc", kind: "reject" as const, createdAtMs: 1, expiresAtMs: 2, payload: { reason: "雪\n\u0001" } };
      const json = new TextEncoder().encode(` \t\r\n${JSON.stringify(message)}\n`);
      await h.receive(json);
      expect(h.negotiations).toEqual([message]);
    } finally { h.manager.stop(); }
  });

  it("retains negotiated direct support across same-process rekey, then clears it on restart", async () => {
    const h = await responderHarness();
    try {
      await h.handshake(1);
      const outcome = await h.receive(capability(2)).then(() => "accepted", error => String(error));
      expect(outcome).toBe("accepted");
      await h.sendApp();
      expect(h.records.at(-1)?.direct).toBe(true);
      h.records.length = 0;
      await h.handshake(1);
      expect(h.records).toHaveLength(0);
      await h.sendApp();
      expect(h.records.at(-1)?.direct).toBe(true);
      h.records.length = 0;
      await h.handshake(2);
      expect(h.records.map(record => [record.direct, record.data.data?.payload])).toEqual([[false, capability(1)]]);
      await h.sendApp();
      expect(h.records.at(-1)?.direct).toBe(false);
    } finally { h.manager.stop(); }
  });

  it("allows authenticated legacy peers to keep direct transport", async () => {
    const h = await responderHarness();
    try {
      await h.handshake(1, true);
      await h.sendApp();
      expect(h.records.at(-1)?.direct).toBe(true);
    } finally { h.manager.stop(); }
  });
});
