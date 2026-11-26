import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BloomFilter, buildTreeAnnounce, decodeLookupRequest, encodeFspEstablished,
  encodeLookupRequestPayload, encodeSessionDatagram, encodeTreeAnnounce,
  FSP_FLAG_CP, identityFromSecretKey, LinkMessageType, nodeAddrToHex, noopLogger, toHex,
} from "../src/index.js";
import { FipsRouting } from "../src/node/FipsRouting.js";
import type { AdjacentPeer } from "../src/node/PeerState.js";

afterEach(() => vi.useRealTimers());

describe("routing lifecycle", () => {
  it("forgets the old tree and accepts a restarted peer's fresh announcements", async () => {
    const identities = await Promise.all([0x51, 0x52, 0x53].map((byte) =>
      identityFromSecretKey(new Uint8Array(32).fill(byte))));
    identities.sort((a, b) => nodeAddrToHex(a.nodeAddr).localeCompare(nodeAddrToHex(b.nodeAddr)));
    const [root, remote, local] = identities;
    const peer = { pubkey: remote.publicKey, pubkeyHex: toHex(remote.publicKey),
      link: { state: "established" } } as AdjacentPeer;
    const routing = new FipsRouting({
      identity: local, forwarding: true, routingMode: "tree", transports: [],
      logger: noopLogger, randomBytes: (length) => new Uint8Array(length),
      getPeers: () => [peer], getPeerByPubkey: () => peer, getPeerByNodeAddr: () => peer,
      sendLinkMessage: async () => {}, connectKnownPeer: async () => {},
      handleLocalSession: async () => {}, emitError: () => {}, isStarted: () => true,
    });
    const announce = async (sequence: bigint, rooted: boolean) => {
      const ancestry = [{ nodeAddr: remote.nodeAddr, sequence, timestamp: 1n }];
      if (rooted) ancestry.push({ nodeAddr: root.nodeAddr, sequence: 1n, timestamp: 1n });
      const message = buildTreeAnnounce(remote, rooted ? root.nodeAddr : remote.nodeAddr,
        sequence, 1n, ancestry);
      await routing.handleLinkMessage(peer, LinkMessageType.TreeAnnounce,
        encodeTreeAnnounce(message).subarray(1));
    };
    await announce(10n, true);
    expect(routing.coords).toEqual([local.nodeAddr, remote.nodeAddr, root.nodeAddr]);
    routing.stop();
    expect(routing.coords).toEqual([local.nodeAddr]);
    await announce(1n, false);
    expect(routing.coords).toEqual([local.nodeAddr, remote.nodeAddr]);
  });

  it("bounds the learned coordinate cache under transient sender churn", async () => {
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x54));
    const remote = await identityFromSecretKey(new Uint8Array(32).fill(0x55));
    const peer = { pubkey: remote.publicKey, pubkeyHex: toHex(remote.publicKey),
      link: { state: "established" } } as AdjacentPeer;
    const routing = new FipsRouting({
      identity: local, forwarding: false, routingMode: "tree", transports: [],
      logger: noopLogger, randomBytes: (length) => new Uint8Array(length),
      getPeers: () => [peer], getPeerByPubkey: () => peer, getPeerByNodeAddr: () => peer,
      sendLinkMessage: async () => {}, connectKnownPeer: async () => {},
      handleLocalSession: async () => {}, emitError: () => {}, isStarted: () => true,
    });
    for (let i = 0; i < 4_200; i += 1) {
      const src = new Uint8Array(16);
      src[0] = i & 0xff;
      src[1] = (i >>> 8) & 0xff;
      const fsp = encodeFspEstablished({
        flags: FSP_FLAG_CP, counter: 0n, payloadLen: 0,
        srcCoords: [src], destCoords: [local.nodeAddr], ciphertext: new Uint8Array(16),
      });
      const payload = encodeSessionDatagram({
        ttl: 8, pathMtu: 1280, srcAddr: src, destAddr: local.nodeAddr, payload: fsp,
      }).subarray(1);
      await routing.handleLinkMessage(peer, LinkMessageType.SessionDatagram, payload);
    }
    const cache = Reflect.get(routing, "coordCache") as Map<string, unknown>;
    expect(cache.size).toBe(4_096);
    const newest = new Uint8Array(16);
    newest[0] = 4_199 & 0xff;
    newest[1] = (4_199 >>> 8) & 0xff;
    expect(routing.coordinatesFor(nodeAddrToHex(newest))).toBeDefined();
    expect(routing.coordinatesFor(nodeAddrToHex(new Uint8Array(16)))).toBeUndefined();
    routing.stop();
  });

  it("routes tree-mode FSP replies toward cached tree coordinates instead of bouncing into a child dead-end", async () => {
    const identities = await Promise.all([0x61, 0x62, 0x63, 0x64].map((byte) =>
      identityFromSecretKey(new Uint8Array(32).fill(byte))));
    identities.sort((a, b) => nodeAddrToHex(a.nodeAddr).localeCompare(nodeAddrToHex(b.nodeAddr)));
    const [root, responder, child, initiator] = identities;
    const peerOf = (id: typeof root) => ({
      pubkey: id.publicKey, pubkeyHex: toHex(id.publicKey),
      remoteAddr: { transport: "memory", addr: toHex(id.publicKey) },
      transport: { mtu: 1400 }, link: { state: "established" },
    }) as AdjacentPeer;
    const rootPeer = peerOf(root);
    const childPeer = peerOf(child);
    const byNode = new Map([[nodeAddrToHex(root.nodeAddr), rootPeer], [nodeAddrToHex(child.nodeAddr), childPeer]]);
    const sentTo: string[] = [];
    const routing = new FipsRouting({
      identity: responder, forwarding: true, routingMode: "tree", transports: [],
      logger: noopLogger, randomBytes: (length) => new Uint8Array(length),
      getPeers: () => byNode.values(), getPeerByPubkey: () => undefined,
      getPeerByNodeAddr: (hex) => byNode.get(hex),
      sendLinkMessage: async (peer) => { sentTo.push(peer.pubkeyHex); },
      connectKnownPeer: async () => {}, handleLocalSession: async () => {},
      emitError: () => {}, isStarted: () => true,
    });
    // responder is depth 1 under root; child is depth 2 under responder; initiator is on another branch under root.
    await routing.handleLinkMessage(rootPeer, LinkMessageType.TreeAnnounce,
      encodeTreeAnnounce(buildTreeAnnounce(root, root.nodeAddr, 1n, 1n,
        [{ nodeAddr: root.nodeAddr, sequence: 1n, timestamp: 1n }])).subarray(1));
    await routing.handleLinkMessage(childPeer, LinkMessageType.TreeAnnounce,
      encodeTreeAnnounce(buildTreeAnnounce(child, responder.nodeAddr, 1n, 1n, [
        { nodeAddr: child.nodeAddr, sequence: 1n, timestamp: 1n },
        { nodeAddr: responder.nodeAddr, sequence: 1n, timestamp: 1n },
        { nodeAddr: root.nodeAddr, sequence: 1n, timestamp: 1n },
      ])).subarray(1));
    const fsp = encodeFspEstablished({
      flags: FSP_FLAG_CP, counter: 0n, payloadLen: 0,
      srcCoords: [initiator.nodeAddr, root.nodeAddr], destCoords: [responder.nodeAddr, root.nodeAddr],
      ciphertext: new Uint8Array(16),
    });
    await routing.handleLinkMessage(childPeer, LinkMessageType.SessionDatagram, encodeSessionDatagram({
      ttl: 8, pathMtu: 1280, srcAddr: initiator.nodeAddr, destAddr: responder.nodeAddr, payload: fsp,
    }).subarray(1));
    sentTo.length = 0;
    await routing.sendFspReplyToward(initiator.nodeAddr, new Uint8Array([0x02]), childPeer);
    expect(sentTo).toEqual([rootPeer.pubkeyHex]);
    routing.stop();
  });

  it("guides lookups by inbound Bloom filters, prefers tree peers in reply_learned, skips clientOnly peers, and uses TTL 64", async () => {
    vi.useFakeTimers();
    const ids = await Promise.all([0x71, 0x72, 0x73, 0x74, 0x75, 0x76].map((byte) =>
      identityFromSecretKey(new Uint8Array(32).fill(byte))));
    ids.sort((a, b) => nodeAddrToHex(a.nodeAddr).localeCompare(nodeAddrToHex(b.nodeAddr)));
    const [root, local, matchChild, missChild, shortcut, target] = ids;
    const mkPeer = (id: typeof root, opts?: Partial<AdjacentPeer>) => ({
      pubkey: id.publicKey, pubkeyHex: toHex(id.publicKey),
      remoteAddr: { transport: "memory", addr: toHex(id.publicKey) },
      transport: { mtu: 1400 }, link: { state: "established" }, ...opts,
    }) as AdjacentPeer;
    const rootPeer = mkPeer(root, { inboundFilter: BloomFilter.empty() });
    const matchFilter = BloomFilter.empty();
    matchFilter.insertBytes(target.nodeAddr);
    const matchPeer = mkPeer(matchChild, { inboundFilter: matchFilter });
    const missPeer = mkPeer(missChild, { inboundFilter: BloomFilter.empty() });
    const shortcutFilter = BloomFilter.empty();
    shortcutFilter.insertBytes(target.nodeAddr);
    const shortcutPeer = mkPeer(shortcut, { inboundFilter: shortcutFilter });
    const clientPeer = mkPeer(await identityFromSecretKey(new Uint8Array(32).fill(0x77)), {
      clientOnly: true, inboundFilter: matchFilter,
    });
    const peers = [rootPeer, matchPeer, missPeer, shortcutPeer, clientPeer];
    const sent: Array<{ peer: AdjacentPeer; type: number; payload: Uint8Array }> = [];
    let randSeq = 0;
    const routing = new FipsRouting({
      identity: local, forwarding: true, routingMode: "reply_learned", transports: [],
      logger: noopLogger, randomBytes: (len) => new Uint8Array(len).fill(++randSeq),
      getPeers: () => peers, getPeerByPubkey: () => undefined, getPeerByNodeAddr: () => undefined,
      sendLinkMessage: async (peer, type, payload) => { sent.push({ peer, type, payload: payload.slice() }); },
      connectKnownPeer: async () => {}, handleLocalSession: async () => {},
      emitError: () => {}, isStarted: () => true,
    });
    try {
      // Establish tree: root -> local -> {matchChild, missChild}; shortcut is non-tree.
      const e = (id: typeof root) => ({ nodeAddr: id.nodeAddr, sequence: 1n, timestamp: 1n });
      await routing.handleLinkMessage(rootPeer, LinkMessageType.TreeAnnounce,
        encodeTreeAnnounce(buildTreeAnnounce(root, root.nodeAddr, 1n, 1n, [e(root)])).subarray(1));
      for (const [peer, id] of [[matchPeer, matchChild], [missPeer, missChild]] as const) {
        await routing.handleLinkMessage(peer, LinkMessageType.TreeAnnounce,
          encodeTreeAnnounce(buildTreeAnnounce(id, local.nodeAddr, 1n, 1n, [e(id), e(local), e(root)])).subarray(1));
      }
      sent.length = 0;

      // Normal transit lookup (minMtu=0) from rootPeer forwards ONLY to matchPeer.
      await routing.handleLinkMessage(rootPeer, LinkMessageType.LookupRequest, encodeLookupRequestPayload({
        requestId: 99n, target: target.nodeAddr, origin: root.nodeAddr,
        originCoords: [root.nodeAddr], ttl: 64, minMtu: 0,
      }));
      expect(sent.filter((s) => s.type === LinkMessageType.LookupRequest).map((s) => s.peer)).toEqual([matchPeer]);

      // Size-qualified MTU detour lookup (minMtu>0) still explores non-tree wide shortcuts while skipping clientOnly peers.
      sent.length = 0;
      const otherTarget = new Uint8Array(16).fill(0x99);
      await routing.handleLinkMessage(rootPeer, LinkMessageType.LookupRequest, encodeLookupRequestPayload({
        requestId: 100n, target: otherTarget, origin: root.nodeAddr,
        originCoords: [root.nodeAddr], ttl: 64, minMtu: 1200,
      }));
      const mtuPeers = sent.filter((s) => s.type === LinkMessageType.LookupRequest).map((s) => s.peer);
      expect(mtuPeers).toContain(shortcutPeer);
      expect(mtuPeers).not.toContain(clientPeer);

      // Origin lookup uses TTL 64, queries only matchPeer on first two attempts, then widens on attempt 3.
      sent.length = 0;
      const lookup = routing.ensureFirstContactRoute(target.nodeAddr, nodeAddrToHex(target.nodeAddr), target.publicKey)
        .catch(() => "stopped");
      await vi.advanceTimersByTimeAsync(0);
      const req0 = sent.filter((s) => s.type === LinkMessageType.LookupRequest);
      expect(req0.map((s) => s.peer)).toEqual([matchPeer]);
      expect(decodeLookupRequest(req0[0]!.payload).ttl).toBe(64);
      sent.length = 0;
      await vi.advanceTimersByTimeAsync(250);
      expect(sent.filter((s) => s.type === LinkMessageType.LookupRequest).map((s) => s.peer)).toEqual([matchPeer]);
      sent.length = 0;
      await vi.advanceTimersByTimeAsync(500);
      const req2Peers = sent.filter((s) => s.type === LinkMessageType.LookupRequest).map((s) => s.peer);
      expect(req2Peers).toContain(shortcutPeer);
      expect(req2Peers).not.toContain(clientPeer);
      routing.stop();
      expect(await lookup).toBe("stopped");
    } finally {
      routing.stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
