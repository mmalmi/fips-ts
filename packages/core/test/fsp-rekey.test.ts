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
    const internal = node as any;
    internal.sessionManager.sessions.set(sourceKey, session);
    let routedReply: Uint8Array | undefined;
    internal.routing.sendFspToward = async (_addr: Uint8Array, reply: Uint8Array) => {
      routedReply = new Uint8Array(reply);
    };
    internal.routing.sendFspReplyToward = async (_addr: Uint8Array, reply: Uint8Array) => {
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
    await internal.sessionManager.handleFromPeer({}, initiatorIdentity.nodeAddr, rekeySetup);
    const rekeyAck = routedReply!;
    routedReply = undefined;
    await internal.sessionManager.handleFromPeer(
      {},
      initiatorIdentity.nodeAddr,
      rekeyInitiator.handleSessionAck(rekeyAck, () => new Uint8Array(0)),
    );

    const promotedResponder = session.fsp;
    expect(promotedResponder).not.toBe(oldResponder);
    expect(session.pendingResponderFsp).toBeUndefined();
    expect(session.currentKBit).toBe(true);
    expect(session.previousFsp?.fsp).toBe(oldResponder);

    const immediateReply = session.fsp.encryptEndpointData(
      new TextEncoder().encode("reply-immediately-after-msg3"),
      FSP_FLAG_DIRECT_TRANSPORT | FSP_FLAG_K,
    );
    expect(new TextDecoder().decode(rekeyInitiator.decryptIncoming(immediateReply).endpointData)).toBe(
      "reply-immediately-after-msg3",
    );

    await internal.sessionManager.handleFromPeer(
      {},
      initiatorIdentity.nodeAddr,
      oldInitiator.encryptEndpointData(
        new TextEncoder().encode("old-before-cutover"),
        FSP_FLAG_DIRECT_TRANSPORT,
      ),
    );
    expect(session.fsp).toBe(promotedResponder);

    await internal.sessionManager.handleFromPeer(
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

    await internal.sessionManager.handleFromPeer(
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

  it("resets K to zero when the same remote identity restarts with a new epoch", async () => {
    const initiatorIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x41));
    const responderIdentity = await identityFromSecretKey(new Uint8Array(32).fill(0x83));
    const node = new FipsNode({ identity: responderIdentity, transports: [] });
    const oldInitiator = new FspSession({
      identity: initiatorIdentity,
      role: "initiator",
      remotePubkey: responderIdentity.publicKey,
      localEpoch: new Uint8Array(8).fill(1),
    });
    const oldResponder = new FspSession({
      identity: responderIdentity,
      role: "responder",
      localEpoch: new Uint8Array(8).fill(9),
    });
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
      currentKBit: true,
      previousFsp: {
        fsp: oldResponder,
        kBit: false,
        expiresAtMs: Date.now() + 45_000,
      },
    };
    const internal = node as any;
    internal.sessionManager.sessions.set(sourceKey, session);
    let routedReply: Uint8Array | undefined;
    internal.routing.sendFspReplyToward = async (_addr: Uint8Array, reply: Uint8Array) => {
      routedReply = new Uint8Array(reply);
    };

    const restartedInitiator = new FspSession({
      identity: initiatorIdentity,
      role: "initiator",
      remotePubkey: responderIdentity.publicKey,
      localEpoch: new Uint8Array(8).fill(2),
    });
    const restartSetup = restartedInitiator.buildSessionSetup(
      () => new Uint8Array(0),
      initiatorIdentity.nodeAddr,
      responderIdentity.nodeAddr,
    );
    await internal.sessionManager.handleFromPeer({}, initiatorIdentity.nodeAddr, restartSetup);
    await internal.sessionManager.handleFromPeer(
      {},
      initiatorIdentity.nodeAddr,
      restartedInitiator.handleSessionAck(routedReply!, () => new Uint8Array(0)),
    );

    expect(session.fsp).not.toBe(oldResponder);
    expect(session.pendingResponderFsp).toBeUndefined();
    expect(session.previousFsp).toBeUndefined();
    expect(session.currentKBit).toBe(false);
    const reply = session.fsp.encryptEndpointData(
      new TextEncoder().encode("reply-after-restart"),
      FSP_FLAG_DIRECT_TRANSPORT,
    );
    expect(new TextDecoder().decode(restartedInitiator.decryptIncoming(reply).endpointData)).toBe(
      "reply-after-restart",
    );
  });
});
