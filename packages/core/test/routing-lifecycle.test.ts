import { describe, expect, it } from "vitest";

import {
  buildTreeAnnounce, encodeTreeAnnounce, identityFromSecretKey,
  LinkMessageType, nodeAddrToHex, noopLogger, toHex,
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
});
