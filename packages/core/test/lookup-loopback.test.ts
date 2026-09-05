import { describe, expect, it, vi } from "vitest";

import {
  encodeLookupRequestPayload,
  identityFromSecretKey,
  LinkMessageType,
  nodeAddrToHex,
  noopLogger,
  toHex,
} from "../src/index.js";
import { FipsRouting } from "../src/node/FipsRouting.js";
import type { OriginLookupRegistry } from "../src/node/OriginLookupRegistry.js";
import type { AdjacentPeer } from "../src/node/PeerState.js";

describe("origin lookup loopback", () => {
  it.each([
    { ownRequest: true, ownTarget: true, forgedOrigin: false, forwarded: false },
    { ownRequest: true, ownTarget: true, forgedOrigin: true, forwarded: false },
    { ownRequest: false, ownTarget: true, forgedOrigin: false, forwarded: true },
    { ownRequest: true, ownTarget: false, forgedOrigin: false, forwarded: true },
  ])("matches the pending ID and target, independently of origin: %j", async (scenario) => {
    const [local, incoming, outgoing] = await Promise.all(
      [0x31, 0x32, 0x33].map((value) => identityFromSecretKey(new Uint8Array(32).fill(value))),
    );
    const peers = [incoming, outgoing].map((identity) => ({
      pubkey: identity.publicKey,
      pubkeyHex: toHex(identity.publicKey),
      transport: { mtu: 1_200 },
      link: { state: "established" },
    } as AdjacentPeer));
    const sendLinkMessage = vi.fn(async () => {});
    const routing = new FipsRouting({
      identity: local,
      forwarding: true,
      routingMode: "reply_learned",
      transports: [],
      logger: noopLogger,
      randomBytes: (length) => new Uint8Array(length),
      getPeers: () => peers,
      getPeerByPubkey: () => undefined,
      getPeerByNodeAddr: () => undefined,
      sendLinkMessage,
      connectKnownPeer: async () => {},
      handleLocalSession: async () => {},
      emitError: () => {},
      isStarted: () => true,
    });
    const internal = routing as unknown as {
      originLookups: OriginLookupRegistry;
      lookupReversePaths: Map<string, unknown>;
    };
    const target = new Uint8Array(16).fill(0x44);
    const pending = internal.originLookups.create({
      targetHex: nodeAddrToHex(target),
      randomBytes: () => new Uint8Array(8).fill(0x55),
      timeoutMs: 5_000,
    });
    try {
      await routing.handleLinkMessage(peers[0]!, LinkMessageType.LookupRequest,
        encodeLookupRequestPayload({
          requestId: pending.requestId + (scenario.ownRequest ? 0n : 1n),
          target: scenario.ownTarget ? target : new Uint8Array(16).fill(0x66),
          origin: scenario.forgedOrigin ? incoming.nodeAddr : local.nodeAddr,
          originCoords: [local.nodeAddr],
          ttl: 8,
          minMtu: 0,
        }));
      expect(sendLinkMessage).toHaveBeenCalledTimes(scenario.forwarded ? 1 : 0);
      expect(internal.lookupReversePaths.size).toBe(scenario.forwarded ? 1 : 0);
      expect(internal.originLookups.findRequest(pending.requestId)).toBe(pending);
    } finally {
      internal.originLookups.complete(pending);
      routing.stop();
    }
  });
});
