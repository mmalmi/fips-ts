import { describe, expect, it } from "vitest";

import {
  buildTreeAnnounce, encodeFspEstablished, encodeSessionDatagram, encodeTreeAnnounce,
  FSP_FLAG_CP, identityFromSecretKey, LinkMessageType, nodeAddrToHex, noopLogger, toHex,
} from "../src/index.js";
import { FipsRouting } from "../src/node/FipsRouting.js";
import type { AdjacentPeer } from "../src/node/PeerState.js";

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
});
