import { afterEach, describe, expect, it, vi } from "vitest";

import { toHex } from "../src/codec/hex.js";
import { FspSession } from "../src/fsp/session.js";
import { identityFromSecretKey } from "../src/identity/index.js";
import { encodeNpub } from "../src/identity/nip19.js";
import { FspSessionManager } from "../src/node/FspSessionManager.js";
import type { FipsRouting } from "../src/node/FipsRouting.js";
import { FipsNode } from "../src/node/FipsNode.js";
import { encodeSessionDatagram, LinkMessageType } from "../src/protocol/link.js";

const NOW = 1_000_000;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const [sender, local, relay] = await Promise.all([0x31, 0x72, 0x51].map(value =>
    identityFromSecretKey(new Uint8Array(32).fill(value))));
  const replies: Uint8Array[] = [];
  const endpoints: Uint8Array[] = [];
  const negotiations: unknown[] = [];
  let blocked = false, nonce = 0;
  const peer = { pubkey: relay.publicKey, pubkeyHex: toHex(relay.publicKey) } as never;
  const manager = new FspSessionManager({
    identity: local, random: { bytes: size => new Uint8Array(size).fill(++nonce) },
    localEpoch: new Uint8Array(8), strictClient: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    assertNodeAllowed: () => { if (blocked) throw new Error("endpoint blocked"); },
    assertPeerAllowed: () => { if (blocked) throw new Error("peer blocked"); },
    routing: {
      coords: [local.nodeAddr], learnReverseRoute() {}, coordinatesFor: () => undefined,
      resolveIdentity: async () => { throw new Error("unresolved test destination"); },
      sendFspReplyToward: async (_address: Uint8Array, frame: Uint8Array) => { replies.push(frame); },
      sendFspToward: async (_address: Uint8Array, frame: Parameters<FipsRouting["sendFspToward"]>[1]) => {
        replies.push(...(typeof frame === "function" ? frame(peer) : [frame]));
      },
    } as never,
    getPeerByNodeAddr: () => undefined,
    emitDatagram() {}, emitEndpointData: event => { endpoints.push(event.payload); },
    handleLinkNegotiation: async (identity, message) => { negotiations.push({ identity, message }); },
    emitSession() {},
  });
  const initiator = new FspSession({ identity: sender, remotePubkey: local.publicKey, role: "initiator" });
  const receive = (packet: Uint8Array) => manager.handleFromPeer(peer, sender.nodeAddr, packet);
  await receive(initiator.buildSessionSetup(() => new Uint8Array(), sender.nodeAddr, local.nodeAddr));
  await receive(initiator.handleSessionAck(replies.shift()!, () => new Uint8Array()));
  const offer = {
    type: "offer", sessionId: "session", issuedAt: NOW, expiresAt: NOW + 120_000,
    nonce: "offer-nonce", senderNpub: encodeNpub(sender.xOnlyPubkey),
    recipientNpub: encodeNpub(local.xOnlyPubkey), reflexiveAddress: null,
    localAddresses: [], stunServer: null,
  };
  const send = (payload: Uint8Array, type = 0x16) => receive(initiator.encryptMessage(type, payload));
  const answer = () => {
    expect(replies).toHaveLength(1);
    const record = initiator.decryptIncoming(replies.shift()!);
    expect(record.msgType).toBe(0x17);
    expect(record.payload!.length).toBeLessThanOrEqual(1024);
    return JSON.parse(new TextDecoder().decode(record.payload));
  };
  return { manager, initiator, sender, local, relay, offer, replies, endpoints, negotiations,
    receiveFrom: (packet: Uint8Array, source: Uint8Array) => manager.handleFromPeer(peer, source, packet),
    receive, send, answer, block: () => { blocked = true; } };
}

describe("unsupported session traversal", () => {
  it("answers an authenticated routed offer without starting discovery or changing application dispatch", async () => {
    const f = await fixture();
    try {
      await f.send(encode(f.offer));
      const answer = f.answer();
      expect(answer).toEqual({
        type: "answer", sessionId: f.offer.sessionId, issuedAt: NOW, expiresAt: NOW + 120_000,
        nonce: expect.any(String), senderNpub: f.offer.recipientNpub,
        recipientNpub: f.offer.senderNpub, inReplyTo: f.offer.nonce,
        accepted: false, reason: "traversal-unsupported", reflexiveAddress: null,
        localAddresses: [], stunServer: null, punch: null, offerReceivedAt: NOW,
      });
      expect(answer.nonce).not.toBe(f.offer.nonce);
      // A newly encrypted retry can recover a lost rejection; no permanent suppression.
      await f.send(encode(f.offer));
      expect(f.answer().nonce).not.toBe(answer.nonce);
      await f.send(encode(answer), 0x17);
      expect(f.replies).toEqual([]);
      const payload = new Uint8Array([1, 2, 3]);
      await f.receive(f.initiator.encryptEndpointData(payload));
      expect(f.endpoints).toEqual([payload]);
      const message = { version: 1, negotiationId: "webrtc", linkType: "webrtc", kind: "reject",
        createdAtMs: NOW, expiresAtMs: NOW + 60_000, payload: {} };
      await f.receive(f.initiator.encryptDatagram({ srcPort: 257, dstPort: 257, payload: encode(message) }));
      expect(f.negotiations).toEqual([{ identity: toHex(f.sender.publicKey), message }]);
      expect(f.replies).toEqual([]);
    } finally { f.manager.stop(); }
  });

  it("silently discards malformed, oversized, misbound and stale offers", async () => {
    const f = await fixture();
    try {
      const invalid: Record<string, unknown>[] = [
        { type: "answer" }, { sessionId: "" }, { nonce: "" },
        ...["sessionId", "nonce"].flatMap(field => ["a".repeat(129), "line\nbreak", "é", "a b", 7]
          .map(value => ({ [field]: value }))),
        { senderNpub: f.offer.recipientNpub }, { recipientNpub: f.offer.senderNpub },
        { issuedAt: NOW - 180_001, expiresAt: NOW + 120_000 },
        { issuedAt: NOW + 60_001, expiresAt: NOW + 180_000 },
        { issuedAt: NOW - 120_000, expiresAt: NOW - 60_000 },
        { expiresAt: NOW }, { expiresAt: NOW - 1 }, { expiresAt: "future" },
        { issuedAt: -1 }, { issuedAt: NOW + 0.5 }, { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
        { localAddresses: undefined }, { localAddresses: null },
        { localAddresses: [{ protocol: "udp", ip: "127.0.0.1", port: 65536 }] },
        { reflexiveAddress: { protocol: "udp", ip: 7, port: 80 } }, { stunServer: 7 },
      ];
      for (const patch of invalid) {
        await f.send(encode({ ...f.offer, ...patch }));
        expect(f.replies, JSON.stringify(patch)).toEqual([]);
      }
      for (const body of [new TextEncoder().encode("{"), encode(null), encode([]),
        new TextEncoder().encode(JSON.stringify(f.offer).padEnd(4097))]) {
        await f.send(body);
        expect(f.replies).toEqual([]);
      }
      await f.send(encode(f.offer));
      expect(f.answer().accepted).toBe(false);
    } finally { f.manager.stop(); }
  });

  it("accepts native freshness boundaries and bounds maximally escaped identifiers", async () => {
    const f = await fixture();
    try {
      for (const patch of [
        { issuedAt: NOW + 60_000, expiresAt: NOW + 180_000 },
        { issuedAt: NOW - 179_999, expiresAt: NOW + 120_000 },
        { issuedAt: NOW - 120_000, expiresAt: NOW - 59_999 },
        { sessionId: '"'.repeat(128), nonce: "\\".repeat(128) },
        { localAddresses: [{ protocol: "udp", ip: "127.0.0.1", port: 9 }] },
      ]) {
        const offer = { ...f.offer, ...patch };
        await f.send(encode(offer));
        expect(f.answer()).toMatchObject({ sessionId: offer.sessionId, inReplyTo: offer.nonce, accepted: false });
      }
      await f.send(new TextEncoder().encode(JSON.stringify(f.offer).padEnd(4096)));
      expect(f.answer().accepted).toBe(false);
    } finally { f.manager.stop(); }
  });

  it("keeps authentication, ciphertext replay and destination admission ahead of replies", async () => {
    const f = await fixture();
    try {
      const packet = f.initiator.encryptMessage(0x16, encode(f.offer));
      const corrupted = packet.slice();
      corrupted[corrupted.length - 1] ^= 1;
      await expect(f.receive(corrupted)).rejects.toThrow();
      expect(f.replies).toEqual([]);
      await f.receive(packet);
      f.answer();
      await expect(f.receive(packet)).rejects.toThrow(/replay/);
      expect(f.replies).toEqual([]);
      f.block();
      await expect(f.send(encode(f.offer))).rejects.toThrow(/blocked/);
      expect(f.replies).toEqual([]);
    } finally { f.manager.stop(); }
  });

  it("does not answer without an established session or with a mismatched authenticated source", async () => {
    const f = await fixture();
    try {
      const impostor = new FspSession({ identity: f.sender, remotePubkey: f.local.publicKey, role: "initiator" });
      await f.receiveFrom(impostor.buildSessionSetup(() => new Uint8Array(),
        f.relay.nodeAddr, f.local.nodeAddr), f.relay.nodeAddr);
      const msg3 = impostor.handleSessionAck(f.replies.shift()!, () => new Uint8Array());
      await expect(f.receiveFrom(msg3, f.relay.nodeAddr)).rejects.toThrow(/authenticated key.*source/);
      await f.receiveFrom(impostor.encryptMessage(0x16, encode(f.offer)), f.relay.nodeAddr);
      expect(f.replies).toEqual([]);
      // The rejected source must not disturb the independently admitted session.
      await f.send(encode(f.offer));
      f.answer();
      f.manager.closePeerSessions(toHex(f.sender.publicKey));
      await f.send(encode(f.offer));
      expect(f.replies).toEqual([]);
    } finally { f.manager.stop(); }
  });

  it("forwards transit offers as opaque ciphertext without interpreting them", async () => {
    const f = await fixture();
    const relay = new FipsNode({ identity: f.relay, transports: [], forwarding: true });
    const routing = (relay as unknown as { routing: Pick<FipsRouting, "handleLinkMessage"> & {
      sendSessionDatagram: (datagram: unknown, previousHop: unknown) => Promise<void>;
    } }).routing;
    const forward = vi.spyOn(routing, "sendSessionDatagram").mockResolvedValue();
    try {
      const datagram = { ttl: 5, pathMtu: 1200, srcAddr: f.sender.nodeAddr, destAddr: f.local.nodeAddr,
        payload: f.initiator.encryptMessage(0x16, encode(f.offer)) };
      const previousHop = {} as never;
      await routing.handleLinkMessage(previousHop, LinkMessageType.SessionDatagram,
        encodeSessionDatagram(datagram).subarray(1));
      expect(forward).toHaveBeenCalledExactlyOnceWith({ ...datagram, ttl: 4 }, previousHop);
      expect(f.replies).toEqual([]);
    } finally { f.manager.stop(); await relay.stop(); }
  });
});
