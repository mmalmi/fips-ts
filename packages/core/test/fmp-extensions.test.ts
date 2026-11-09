import { describe, expect, it, vi } from "vitest";

import { FmpLink, identityFromSecretKey, noopLogger, toHex } from "../src/index.js";
import { FipsRouting } from "../src/node/FipsRouting.js";
import { FmpTransportPacketProcessor } from "../src/node/FmpTransportPacketProcessor.js";
import type { AdjacentPeer } from "../src/node/PeerState.js";
import { transportAddressKey, type Transport } from "../src/transport/types.js";

// Feed the authenticated-link dispatch boundary with independent wire vectors.
// The existing strict-client wire tests exercise the real Noise/FMP carrier.
const magic = new TextEncoder().encode("FIPS-EXT");
function capability(kind: number, capabilities = 2): Uint8Array {
  return new Uint8Array([...magic, 1, kind, capabilities & 0xff, capabilities >>> 8]);
}
function clientOnly(sequence: bigint): Uint8Array {
  const body = new Uint8Array(18);
  body.set(magic); body[8] = 1; body[9] = 3;
  new DataView(body.buffer).setBigUint64(10, sequence, true);
  return body;
}
function legacyRole(sequence: bigint): Uint8Array {
  const body = new Uint8Array(8);
  new DataView(body.buffer).setBigUint64(0, sequence, true);
  return body;
}

async function fixture(strictClient = true) {
  const [identity, remote] = await Promise.all([0x61, 0x62].map(byte =>
    identityFromSecretKey(new Uint8Array(32).fill(byte))));
  const peer = { pubkey: remote.publicKey, pubkeyHex: toHex(remote.publicKey),
    link: { state: "established" } } as AdjacentPeer;
  const sent: Array<{ type: number; body: Uint8Array }> = [];
  const routing = new FipsRouting({
    identity, strictClient, forwarding: !strictClient, routingMode: "tree", transports: [],
    logger: noopLogger, randomBytes: length => new Uint8Array(length),
    getPeers: () => [peer], getPeerByPubkey: () => peer, getPeerByNodeAddr: () => peer,
    sendLinkMessage: async (_peer, type, body) => { sent.push({ type, body: body.slice() }); },
    connectKnownPeer: async () => {}, handleLocalSession: async () => {},
    emitError: () => {}, isStarted: () => true,
  });
  return { identity, remote, routing, peer, sent };
}

describe("FMP extension namespace", () => {
  it("sends a namespaced capability request before any legacy solicitation", async () => {
    const { routing, peer, sent } = await fixture();
    await routing.sendTreeAnnounce(peer);
    expect(sent).toEqual([{ type: 0xe0, body: capability(1) }]);
  });

  it("bounds unanswered legacy solicitations to three at the existing refresh cadence", async () => {
    const { routing, sent } = await fixture();
    for (let i = 0; i < 12; i++) await routing.refreshClientRole();
    expect(sent.filter(frame => frame.type === 0x53)).toHaveLength(3);
    expect(sent.filter(frame => frame.type === 0xe0)).toHaveLength(1);
    expect(sent[0]).toEqual({ type: 0xe0, body: capability(1) });
    expect(sent.every(frame => frame.type !== 0x10 && frame.type !== 0x20)).toBe(true);
  });

  it("does not spend legacy solicitations on topology announcement triggers", async () => {
    const { routing, peer, sent } = await fixture();
    for (let i = 0; i < 6; i++) await routing.sendTreeAnnounce(peer);
    expect(sent).toEqual([{ type: 0xe0, body: capability(1) }]);
    await routing.refreshClientRole();
    expect(sent.filter(frame => frame.type === 0x53)).toHaveLength(1);
  });

  it("does not interpret an upstream-shaped 0x52 body without legacy support", async () => {
    const { routing, peer } = await fixture(false);
    await routing.handleLinkMessage(peer, 0x52, legacyRole(9n));
    expect(peer.clientOnly).toBeUndefined();
    expect(peer.clientSupported).toBeUndefined();
    expect(peer.routingRoleSequence).toBeUndefined();
  });

  it("requires namespaced capability before a namespaced client-role hint", async () => {
    const { routing, peer } = await fixture(false);
    await routing.handleLinkMessage(peer, 0xe0, clientOnly(7n));
    expect(peer.clientOnly).toBeUndefined();
    await routing.handleLinkMessage(peer, 0xe0, capability(2));
    await routing.handleLinkMessage(peer, 0xe0, clientOnly(7n));
    expect(peer.clientOnly).toBe(true);
    expect(peer.routingRoleSequence).toBe(7n);
    await routing.handleLinkMessage(peer, 0xe0, clientOnly(6n));
    expect(peer.routingRoleSequence).toBe(7n);
  });

  it("replies to a capability request but never replies to a response", async () => {
    const { routing, peer, sent } = await fixture(false);
    await routing.handleLinkMessage(peer, 0xe0, capability(1));
    expect(sent).toEqual([{ type: 0xe0, body: capability(2) }]);
    await routing.handleLinkMessage(peer, 0xe0, capability(2));
    expect(sent).toHaveLength(1);
  });

  it("uses namespaced role hints and stops legacy solicitations after negotiation", async () => {
    const { routing, peer, sent } = await fixture();
    await routing.sendTreeAnnounce(peer);
    await routing.handleLinkMessage(peer, 0xe0, capability(2));
    for (let i = 0; i < 4; i++) await routing.refreshClientRole();
    expect(sent.some(frame => frame.type === 0x52 || frame.type === 0x53)).toBe(false);
    const hints = sent.filter(frame => frame.type === 0xe0 && frame.body[9] === 3);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.every(frame => frame.body.length === 18)).toBe(true);
  });

  it("retains legacy support and can upgrade it without a namespace downgrade", async () => {
    const { routing, peer, sent } = await fixture();
    await routing.sendTreeAnnounce(peer);
    await routing.handleLinkMessage(peer, 0x53, new Uint8Array());
    expect(sent.some(frame => frame.type === 0x52)).toBe(true);
    await routing.handleLinkMessage(peer, 0x52, legacyRole(4n));
    expect(peer.clientOnly).toBe(true);
    await routing.handleLinkMessage(peer, 0xe0, capability(2));
    const upgradedAt = sent.length;
    await routing.handleLinkMessage(peer, 0x53, new Uint8Array());
    await routing.handleLinkMessage(peer, 0x52, legacyRole(99n));
    await routing.refreshClientRole();
    expect(peer.routingRoleSequence).toBe(4n);
    expect(sent.slice(upgradedAt).some(frame => frame.type === 0x52 || frame.type === 0x53)).toBe(false);
  });

  it("does not infer support from unsupported capability bits or fall back after namespace response", async () => {
    const { routing, peer, sent } = await fixture();
    await routing.sendTreeAnnounce(peer);
    await routing.handleLinkMessage(peer, 0xe0, capability(2, 0x8000));
    await routing.handleLinkMessage(peer, 0xe0, clientOnly(1n));
    for (let i = 0; i < 5; i++) await routing.refreshClientRole();
    expect(peer.clientOnly).toBeUndefined();
    expect(sent).toEqual([{ type: 0xe0, body: capability(1) }]);
  });

  it("negotiates the known client-role bit while ignoring unknown capability bits", async () => {
    const { routing, peer, sent } = await fixture();
    await routing.handleLinkMessage(peer, 0xe0, capability(2, 0x8002));
    await routing.handleLinkMessage(peer, 0xe0, clientOnly(1n));
    expect(peer.clientOnly).toBe(true);
    expect(peer.extensionCapabilities).toBe(2);
    expect(sent).toEqual([{ type: 0xe0, body: clientOnly(1n) }]);
  });

  it("ignores malformed and unsupported envelopes without creating capability state", async () => {
    const { routing, peer, sent } = await fixture(false);
    const wrongMagic = capability(1); wrongMagic[0] ^= 1;
    const wrongVersion = capability(1); wrongVersion[8] = 2;
    for (const body of [wrongMagic, wrongVersion, capability(9), capability(1).slice(0, 11),
      new Uint8Array([...capability(1), 0]), new Uint8Array([...magic, 1, 4, 1, 1, 0])]) {
      await routing.handleLinkMessage(peer, 0xe0, body);
    }
    await routing.handleLinkMessage(peer, 0x53, new Uint8Array([0]));
    await routing.handleLinkMessage(peer, 0x54, new Uint8Array([1, 1, 0]));
    expect(peer.clientSupported).toBeUndefined();
    expect(peer.clientOnly).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("resets namespace negotiation and legacy budget when the node stops", async () => {
    const { routing, peer, sent } = await fixture();
    await routing.sendTreeAnnounce(peer);
    await routing.handleLinkMessage(peer, 0xe0, capability(2));
    routing.stop(); sent.length = 0;
    for (let i = 0; i < 8; i++) await routing.refreshClientRole();
    expect(sent[0]).toEqual({ type: 0xe0, body: capability(1) });
    expect(sent.filter(frame => frame.type === 0x53)).toHaveLength(3);
    expect(peer.clientSupported).toBeUndefined();
  });
});

describe("FMP namespace lifecycle on authenticated links", () => {
  it.each([false, true])("resets namespace state only when the remote process epoch changes (%s)", async changedEpoch => {
    const { identity, remote, routing } = await fixture();
    const schedule = vi.spyOn(routing, "scheduleTreeAnnounce").mockImplementation(() => {});
    const localEpoch = new Uint8Array(8).fill(1);
    const oldEpoch = new Uint8Array(8).fill(2);
    const nextEpoch = new Uint8Array(8).fill(changedEpoch ? 3 : 2);
    const transport: Transport = {
      type: "namespace_lifecycle", mtu: 1400,
      start: async () => {}, stop: async () => {}, connect: async () => {}, send: async () => {},
    };
    const oldLink = new FmpLink({ identity, remotePubkey: remote.publicKey,
      role: "initiator", sessionIdx: 1, localEpoch });
    const oldRemote = new FmpLink({ identity: remote, role: "responder", sessionIdx: 2, localEpoch: oldEpoch });
    oldLink.handleMsg2(oldRemote.handleMsg1(oldLink.buildMsg1(() => new Uint8Array(32)).packet,
      () => new Uint8Array(32)).reply!);
    const nextLink = new FmpLink({ identity, remotePubkey: remote.publicKey,
      role: "initiator", sessionIdx: 3, localEpoch });
    const nextRemote = new FmpLink({ identity: remote, role: "responder", sessionIdx: 4, localEpoch: nextEpoch });
    const reply = nextRemote.handleMsg1(nextLink.buildMsg1(() => new Uint8Array(32)).packet,
      () => new Uint8Array(32)).reply!;
    const address = (addr: string) => ({ transport: transport.type, addr });
    const oldPeer: AdjacentPeer = { pubkey: remote.publicKey, pubkeyHex: toHex(remote.publicKey),
      remoteAddr: address("old"), transport, link: oldLink };
    const peer: AdjacentPeer = { ...oldPeer, remoteAddr: address("next"), link: nextLink,
      extensionNamespace: "namespaced", extensionCapabilities: 2,
      extensionRequestSent: true, legacySupportProbes: 3,
      clientSupported: true, clientOnly: true, routingRoleSequence: 40n,
      outgoingHandshake: { resolve: () => {}, reject: () => {} } };
    const peers = new Map([oldPeer, peer].map(item => [transportAddressKey(item.remoteAddr), item]));
    const errors: Error[] = [];
    let restarts = 0;
    const processor = new FmpTransportPacketProcessor({ identity, startupEpoch: localEpoch,
      nextSessionIdx: () => 5, randomBytes: length => new Uint8Array(length), logger: noopLogger,
      peers, peersByPubkey: new Map([[peer.pubkeyHex, oldPeer]]),
      peersByNodeAddr: new Map([[toHex(remote.nodeAddr), oldPeer]]), routing,
      sessionManager: { closePeerSessions: () => {} } as never,
      emitError: error => { errors.push(error); }, emitPeer: () => {}, removePeerPath: () => {},
      handlePeerRestart: () => { restarts++; },
    });
    try {
      processor.process(transport, { transportType: transport.type, remoteAddr: peer.remoteAddr,
        data: reply, receivedAtMs: 0 });
      expect(errors).toEqual([]);
      expect(peer.link.state).toBe("established");
      expect(restarts).toBe(changedEpoch ? 1 : 0);
      expect([peer.extensionNamespace, peer.extensionCapabilities,
        peer.extensionRequestSent, peer.legacySupportProbes,
        peer.clientSupported, peer.clientOnly, peer.routingRoleSequence]).toEqual(changedEpoch
          ? [undefined, undefined, undefined, undefined, undefined, undefined, undefined]
          : ["namespaced", 2, true, 3, true, true, 40n]);
      if (changedEpoch) {
        const deliver = (body: Uint8Array) => processor.process(transport, {
          transportType: transport.type, remoteAddr: peer.remoteAddr,
          data: nextRemote.encryptOutgoing(body, 0xe0), receivedAtMs: 0,
        });
        deliver(clientOnly(1n));
        expect(peer.routingRoleSequence).toBeUndefined();
        deliver(capability(2));
        deliver(clientOnly(1n));
        expect(peer.clientOnly).toBe(true);
        expect(peer.routingRoleSequence).toBe(1n);
        expect(errors).toEqual([]);
      }
    } finally {
      processor.clear(); routing.stop(); schedule.mockRestore();
      for (const link of [oldLink, oldRemote, nextLink, nextRemote]) link.close();
    }
  });

  it.each(["namespaced", "legacy"] as const)("preserves %s role state across authenticated pending-responder promotion", async namespace => {
    const { identity, remote, routing } = await fixture();
    // Announcements are outside this receive-state case and would add timers.
    const schedule = vi.spyOn(routing, "scheduleTreeAnnounce").mockImplementation(() => {});
    const localEpoch = new Uint8Array(8).fill(1);
    const remoteEpoch = new Uint8Array(8).fill(2);
    const replies: Uint8Array[] = [];
    const transport: Transport = {
      type: "namespace_promotion", mtu: 1400,
      start: async () => {}, stop: async () => {}, connect: async () => {},
      send: async (_address, packet) => { replies.push(packet); },
    };
    const oldLink = new FmpLink({ identity, remotePubkey: remote.publicKey,
      role: "initiator", sessionIdx: 11, localEpoch });
    const oldRemote = new FmpLink({ identity: remote, role: "responder", sessionIdx: 12, localEpoch: remoteEpoch });
    oldLink.handleMsg2(oldRemote.handleMsg1(oldLink.buildMsg1(() => new Uint8Array(32)).packet,
      () => new Uint8Array(32)).reply!);
    const remoteAddr = { transport: transport.type, addr: "peer" };
    const peer: AdjacentPeer = { pubkey: remote.publicKey, pubkeyHex: toHex(remote.publicKey),
      remoteAddr, transport, link: oldLink, extensionNamespace: namespace,
      extensionCapabilities: namespace === "namespaced" ? 2 : undefined,
      extensionRequestSent: true, legacySupportProbes: 3,
      clientSupported: true, clientOnly: true, routingRoleSequence: 10n };
    const errors: Error[] = [];
    const processor = new FmpTransportPacketProcessor({ identity, startupEpoch: localEpoch,
      nextSessionIdx: () => 14, randomBytes: length => new Uint8Array(length), logger: noopLogger,
      peers: new Map([[transportAddressKey(remoteAddr), peer]]),
      peersByPubkey: new Map([[peer.pubkeyHex, peer]]),
      peersByNodeAddr: new Map([[toHex(remote.nodeAddr), peer]]), routing,
      sessionManager: { closePeerSessions: () => {} } as never,
      emitError: error => { errors.push(error); }, emitPeer: () => {}, removePeerPath: () => {},
      handlePeerRestart: () => { throw new Error("same process was treated as restarted"); },
    });
    const nextRemote = new FmpLink({ identity: remote, remotePubkey: identity.publicKey,
      role: "initiator", sessionIdx: 13, localEpoch: remoteEpoch });
    const deliver = (data: Uint8Array) => processor.process(transport,
      { transportType: transport.type, remoteAddr, data, receivedAtMs: 0 });
    let promoted: FmpLink | undefined;
    try {
      deliver(nextRemote.buildMsg1(() => new Uint8Array(32)).packet);
      promoted = peer.pendingResponderLink;
      expect(promoted?.state).toBe("established");
      expect(peer.link).toBe(oldLink);
      expect(replies).toHaveLength(1);
      nextRemote.handleMsg2(replies[0]!);
      const roleFrame = (sequence: bigint) => nextRemote.encryptOutgoing(
        namespace === "namespaced" ? clientOnly(sequence) : legacyRole(sequence),
        namespace === "namespaced" ? 0xe0 : 0x52);
      deliver(roleFrame(9n));
      expect(peer.link).toBe(promoted);
      expect(peer.pendingResponderLink).toBeUndefined();
      expect([peer.clientSupported, peer.clientOnly, peer.routingRoleSequence]).toEqual([true, true, 10n]);
      expect([peer.extensionNamespace, peer.extensionCapabilities,
        peer.extensionRequestSent, peer.legacySupportProbes]).toEqual([
          namespace, namespace === "namespaced" ? 2 : undefined, true, 3]);
      deliver(roleFrame(11n));
      expect(peer.routingRoleSequence).toBe(11n);
      expect(errors).toEqual([]);
    } finally {
      processor.clear(); routing.stop(); schedule.mockRestore();
      for (const link of [oldLink, oldRemote, nextRemote, promoted]) link?.close();
    }
  });
});
