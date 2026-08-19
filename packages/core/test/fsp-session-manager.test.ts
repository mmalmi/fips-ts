import { describe, expect, it } from "vitest";

import { FSP_FLAG_DIRECT_TRANSPORT } from "../src/fsp/wire.js";
import { FspSession } from "../src/fsp/session.js";
import { identityFromSecretKey } from "../src/identity/index.js";
import { FspSessionManager } from "../src/node/FspSessionManager.js";

describe("FspSessionManager", () => {
  it("delivers a direct record that arrives before the routed final handshake", async () => {
    const initiatorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x31));
    const responderIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x72));
    const sentReplies: Uint8Array[] = [];
    const delivered: Uint8Array[] = [];
    const routing = {
      coords: [responderIdentity.nodeAddr],
      learnReverseRoute: () => {},
      sendFspReplyToward: async (
        _remoteNodeAddr: Uint8Array,
        frame: Uint8Array,
      ) => {
        sentReplies.push(new Uint8Array(frame));
      },
    };
    const manager = new FspSessionManager({
      identity: responderIdentity,
      random: { bytes: (length: number) => new Uint8Array(length).fill(0x44) },
      localEpoch: new Uint8Array(8).fill(0x55),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      routing: routing as never,
      getPeerByNodeAddr: () => undefined,
      emitDatagram: () => {},
      emitEndpointData: () => {},
      handleLinkNegotiation: async () => {},
      emitSession: () => {},
    });
    manager.registerService(4_242, ({ payload }) => {
      delivered.push(new Uint8Array(payload));
    });
    const peer = {
      pubkey: initiatorIdentity.publicKey,
      pubkeyHex: "",
      remoteAddr: { transport: "memory", addr: "initiator" },
    } as never;
    const initiator = new FspSession({
      identity: initiatorIdentity,
      role: "initiator",
      remotePubkey: responderIdentity.publicKey,
      localEpoch: new Uint8Array(8).fill(0x66),
    });

    const setup = initiator.buildSessionSetup(
      (length) => new Uint8Array(length),
      initiatorIdentity.nodeAddr,
      responderIdentity.nodeAddr,
    );
    await manager.handleFromPeer(peer, initiatorIdentity.nodeAddr, setup);
    const msg3 = initiator.handleSessionAck(
      sentReplies[0]!,
      (length) => new Uint8Array(length),
    );
    const payload = new TextEncoder().encode("first pubsub record");
    const earlyRecord = initiator.encryptDatagram({
      srcPort: 5_000,
      dstPort: 4_242,
      payload,
    }, FSP_FLAG_DIRECT_TRANSPORT);

    await expect(
      manager.handleFromPeer(peer, initiatorIdentity.nodeAddr, earlyRecord),
    ).resolves.toBeUndefined();
    expect(delivered).toEqual([]);

    await manager.handleFromPeer(peer, initiatorIdentity.nodeAddr, msg3);
    expect(delivered).toEqual([payload]);
  });
});
