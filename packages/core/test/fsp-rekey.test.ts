import { describe, expect, it } from "vitest";

import {
  FSP_FLAG_DIRECT_TRANSPORT,
  FSP_FLAG_K,
  FipsNode,
  FspSession,
  identityFromSecretKey,
  nodeAddrToHex,
  toHex,
} from "../src/index.js";

describe("FipsNode FSP rekey epochs", () => {
  it("promotes an authenticated K-bit epoch and drains delayed old traffic", async () => {
    const initiatorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x31));
    const responderIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x73));
    const node = new FipsNode({ identity: responderIdentity, transports: [] });
    const oldInitiator = new FspSession({
      identity: initiatorIdentity,
      role: "initiator",
      remotePubkey: responderIdentity.publicKey,
    });
    const oldResponder = new FspSession({ identity: responderIdentity, role: "responder" });
    const oldSetup = oldInitiator.buildSessionSetup(
      () => new Uint8Array(0),
      initiatorIdentity.nodeAddr,
      responderIdentity.nodeAddr,
    );
    const oldAck = oldResponder.handleSessionSetup(
      oldSetup,
      () => new Uint8Array(0),
      responderIdentity.nodeAddr,
    );
    oldResponder.handleSessionMsg3(oldInitiator.handleSessionAck(oldAck, () => new Uint8Array(0)));

    const sourceKey = nodeAddrToHex(initiatorIdentity.nodeAddr);
    const session = {
      remoteNodeAddr: initiatorIdentity.nodeAddr,
      remotePubkey: initiatorIdentity.publicKey,
      remotePubkeyHex: toHex(initiatorIdentity.publicKey),
      fsp: oldResponder,
      currentKBit: false,
    };
    (node as any).sessions.set(sourceKey, session);
    let routedReply: Uint8Array | undefined;
    (node as any).sendFspToward = async (_addr: Uint8Array, reply: Uint8Array) => {
      routedReply = new Uint8Array(reply);
    };
    const received: string[] = [];
    node.on("endpointData", (event) => {
      received.push(new TextDecoder().decode((event as { payload: Uint8Array }).payload));
    });

    const rekeyInitiator = new FspSession({
      identity: initiatorIdentity,
      role: "initiator",
      remotePubkey: responderIdentity.publicKey,
    });
    const rekeySetup = rekeyInitiator.buildSessionSetup(
      () => new Uint8Array(0),
      initiatorIdentity.nodeAddr,
      responderIdentity.nodeAddr,
    );
    await (node as any).handleFspFromPeer({}, initiatorIdentity.nodeAddr, rekeySetup);
    const rekeyAck = routedReply!;
    routedReply = undefined;
    await (node as any).handleFspFromPeer(
      {},
      initiatorIdentity.nodeAddr,
      rekeyInitiator.handleSessionAck(rekeyAck, () => new Uint8Array(0)),
    );

    expect(session.fsp).toBe(oldResponder);
    expect(session.pendingResponderFsp?.state).toBe("established");
    await (node as any).handleFspFromPeer(
      {},
      initiatorIdentity.nodeAddr,
      oldInitiator.encryptEndpointData(
        new TextEncoder().encode("old-before-cutover"),
        FSP_FLAG_DIRECT_TRANSPORT,
      ),
    );
    expect(session.fsp).toBe(oldResponder);

    const promotedResponder = session.pendingResponderFsp;
    await (node as any).handleFspFromPeer(
      {},
      initiatorIdentity.nodeAddr,
      rekeyInitiator.encryptEndpointData(
        new TextEncoder().encode("new-promotes"),
        FSP_FLAG_DIRECT_TRANSPORT | FSP_FLAG_K,
      ),
    );
    expect(session.currentKBit).toBe(true);
    expect(session.fsp).toBe(promotedResponder);
    expect(session.previousFsp?.fsp).toBe(oldResponder);

    await (node as any).handleFspFromPeer(
      {},
      initiatorIdentity.nodeAddr,
      oldInitiator.encryptEndpointData(
        new TextEncoder().encode("old-during-drain"),
        FSP_FLAG_DIRECT_TRANSPORT,
      ),
    );
    expect(received).toEqual(["old-before-cutover", "new-promotes", "old-during-drain"]);

    const reply = session.fsp.encryptEndpointData(
      new TextEncoder().encode("reply-on-new-epoch"),
      FSP_FLAG_DIRECT_TRANSPORT | (session.currentKBit ? FSP_FLAG_K : 0),
    );
    expect(new TextDecoder().decode(rekeyInitiator.decryptIncoming(reply).endpointData)).toBe(
      "reply-on-new-epoch",
    );
  });
});
