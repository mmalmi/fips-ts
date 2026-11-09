import { describe, expect, it } from "vitest";

import { toHex } from "../src/codec/hex.js";
import { FspSession } from "../src/fsp/session.js";
import { FspReceiverReports } from "../src/fsp/receiverReports.js";
import { identityFromSecretKey } from "../src/identity/index.js";
import { FspSessionManager } from "../src/node/FspSessionManager.js";
import { LearnedRouteTable } from "../src/node/LearnedRouteTable.js";
import type { FipsRouting } from "../src/node/FipsRouting.js";
import type { AdjacentPeer } from "../src/node/PeerState.js";
import { decodeSessionSetup, encodeSessionSetup } from "../src/protocol/session.js";

const random = (length: number) => new Uint8Array(length);
const capability = (kind: number, bits = 1) => Uint8Array.of(
  70, 73, 80, 83, 45, 69, 88, 84, 1, kind, bits & 255, bits >>> 8,
);

async function harness(legacy = false) {
  const [remote, local, firstRelay, secondRelay] = await Promise.all([0x36, 0x75, 0x42, 0x56]
    .map(byte => identityFromSecretKey(new Uint8Array(32).fill(byte))));
  const initiator = new FspSession({ identity: remote, remotePubkey: local.publicKey,
    role: "initiator", localEpoch: new Uint8Array(8).fill(1) });
  const routeTable = new LearnedRouteTable();
  const records: ReturnType<FspSession["decryptIncoming"]>[] = [];
  const application: Uint8Array[] = [];
  const relays = [firstRelay, secondRelay].map(identity => ({ pubkey: identity.publicKey,
    pubkeyHex: toHex(identity.publicKey) }) as AdjacentPeer);
  let nextHop = relays[0];
  let acknowledgement: Uint8Array | undefined;
  let clock = 1000;
  let carrierResolutions = 0;
  let directEnabled = false;
  let directSends = 0;
  const directPeer = { pubkey: remote.publicKey, link: { state: "established" },
    remoteAddr: { transport: "local", addr: "remote" }, transport: { mtu: 1200,
      send: async (_address: unknown, frame: Uint8Array) => {
        directSends++;
        records.push(initiator.decryptIncoming(frame));
      },
    } } as AdjacentPeer;
  const manager = new FspSessionManager({ identity: local, random: { bytes: random },
    localEpoch: new Uint8Array(8).fill(9),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    routing: {
      coords: [local.nodeAddr], hasUsableRoute: () => true, coordinatesFor: () => [remote.nodeAddr],
      learnReverseRoute: (destination: string, peer: AdjacentPeer) => {
        const relay = peer === relays[0] ? firstRelay : secondRelay;
        routeTable.learn(destination, toHex(relay.nodeAddr), ++clock, 300, 4);
      },
      sendFspReplyToward: async (_address: unknown, frame: Uint8Array) => { acknowledgement = frame; },
      sendFspToward: async (_address: unknown, frames: Uint8Array | ((peer: AdjacentPeer) => Uint8Array[])) => {
        carrierResolutions++;
        for (const frame of typeof frames === "function" ? frames(nextHop) : [frames]) {
          records.push(initiator.decryptIncoming(frame));
        }
      },
    } as unknown as FipsRouting,
    getPeerByNodeAddr: () => directEnabled ? directPeer : undefined,
    emitDatagram: event => { application.push(event.payload); }, emitEndpointData() {}, emitSession() {},
    handleLinkNegotiation: async () => {},
  });
  const receive = (frame: Uint8Array) => manager.handleFromPeer(relays[0], remote.nodeAddr, frame);
  const setup = initiator.buildSessionSetup(random, [remote.nodeAddr], [local.nodeAddr]);
  await receive(legacy ? encodeSessionSetup({ ...decodeSessionSetup(setup), flags: 4 }) : setup);
  await receive(initiator.handleSessionAck(acknowledgement!, random));
  const session = (manager as unknown as { sessions: Map<string, {
    routeWarmup?: { peer: AdjacentPeer; remaining: number }; receiverReports?: FspReceiverReports;
  }> }).sessions.get(toHex(remote.nodeAddr))!;
  const routeSnapshot = () => (routeTable as unknown as { routes: Map<string, object[]> })
    .routes.get(toHex(remote.nodeAddr))?.map(route => ({ ...route }));
  return { manager, initiator, remote, records, application, relays, session, receive, routeSnapshot,
    carrierResolutions: () => carrierResolutions,
    enableDirect: () => { directEnabled = true; }, directSends: () => directSends,
    changeCarrier: () => { nextHop = relays[1]; },
    receiveCapability: (kind: number, bits = 1) => receive(initiator.encryptDatagram({
      srcPort: 257, dstPort: 257, payload: capability(kind, bits),
    })),
    sendApplication: () => manager.sendDatagram({ dst: toHex(remote.publicKey),
      srcPort: 41, dstPort: 42, payload: Uint8Array.of(7) }),
  };
}

describe("FSP capability routing neutrality", () => {
  it("does not reinforce learned routes for authenticated capability datagrams", async () => {
    const h = await harness();
    try {
      const before = h.routeSnapshot();
      let packets = 0n;
      for (const [kind, bits] of [[1, 1], [2, 1], [1, 0x8000], [2, 0x8001]]) {
        await h.receiveCapability(kind, bits);
        expect(h.routeSnapshot()).toEqual(before);
        const report = h.session.receiverReports!.build(100)!;
        const view = new DataView(report.buffer, report.byteOffset, report.byteLength);
        expect(view.getBigUint64(10, true)).toBe(++packets);
        expect(view.getBigUint64(18, true)).toBe(packets * 22n);
      }
      const frame = h.initiator.encryptDatagram({ srcPort: 257, dstPort: 257, payload: capability(2) });
      const corrupt = frame.slice(); corrupt[corrupt.length - 1] ^= 1;
      await expect(h.receive(corrupt)).rejects.toThrow();
      await h.receive(frame);
      await expect(h.receive(frame)).rejects.toThrow(/replay/);
      expect(h.routeSnapshot()).toEqual(before);
      await h.receive(h.initiator.encryptDatagram({ srcPort: 41, dstPort: 42, payload: Uint8Array.of(8) }));
      expect(h.routeSnapshot()).not.toEqual(before);
      expect(h.application).toEqual([Uint8Array.of(8)]);
      const afterApplication = h.routeSnapshot();
      await h.receive(h.initiator.encryptKeepalive());
      expect(h.routeSnapshot()).not.toEqual(afterApplication);
    } finally { h.manager.stop(); h.initiator.close(); }
  });

  it("does not initialize or consume route warmup for capability sends", async () => {
    const h = await harness();
    try {
      expect(h.records).toEqual([{ msgType: 0x10,
        data: { srcPort: 257, dstPort: 257, payload: capability(1) } }]);
      expect(h.session.routeWarmup).toBeUndefined();
      expect(h.carrierResolutions()).toBe(1);
      h.records.length = 0;
      await h.sendApplication();
      expect(h.records.map(record => record.msgType)).toEqual([0x14, 0x10]);
      expect(h.session.routeWarmup).toEqual({ peer: h.relays[0], remaining: 4 });
      h.records.length = 0;
      h.changeCarrier();
      for (let i = 0; i < 3; i++) await h.receiveCapability(1);
      expect(h.records).toEqual(Array.from({ length: 3 }, () => ({ msgType: 0x10,
        data: { srcPort: 257, dstPort: 257, payload: capability(2) } })));
      expect(h.session.routeWarmup).toEqual({ peer: h.relays[0], remaining: 4 });
      expect(h.carrierResolutions()).toBe(5);
      h.records.length = 0;
      await h.sendApplication();
      expect(h.records.map(record => record.msgType)).toEqual([0x14, 0x10]);
      expect(h.session.routeWarmup).toEqual({ peer: h.relays[1], remaining: 4 });
    } finally { h.manager.stop(); h.initiator.close(); }
  });

  it("preserves warmup on direct legacy capability sends while direct application data clears it", async () => {
    const h = await harness(true);
    try {
      await h.sendApplication();
      const warmup = h.session.routeWarmup;
      expect(warmup).toEqual({ peer: h.relays[0], remaining: 4 });
      h.records.length = 0;
      h.enableDirect();
      await h.receiveCapability(1);
      expect(h.directSends()).toBe(1);
      expect(h.records).toEqual([{ msgType: 0x10,
        data: { srcPort: 257, dstPort: 257, payload: capability(2) } }]);
      expect(h.session.routeWarmup).toBe(warmup);
      await h.sendApplication();
      expect(h.directSends()).toBe(2);
      expect(h.session.routeWarmup).toBeUndefined();
    } finally { h.manager.stop(); h.initiator.close(); }
  });

  it("keeps public capability datagrams neutral while ordinary port257 data warms routes", async () => {
    const h = await harness();
    try {
      h.records.length = 0;
      await h.manager.sendDatagram({ dst: toHex(h.remote.publicKey), srcPort: 257,
        dstPort: 257, payload: capability(2) });
      expect(h.records).toEqual([{ msgType: 0x10,
        data: { srcPort: 257, dstPort: 257, payload: capability(2) } }]);
      expect(h.session.routeWarmup).toBeUndefined();
      h.records.length = 0;
      await h.manager.sendDatagram({ dst: toHex(h.remote.publicKey), srcPort: 257,
        dstPort: 257, payload: new TextEncoder().encode('{"kind":"reject"}') });
      expect(h.records.map(record => record.msgType)).toEqual([0x14, 0x10]);
      expect(h.session.routeWarmup).toEqual({ peer: h.relays[0], remaining: 4 });
      h.records.length = 0;
      await h.manager.sendDatagram({ dst: toHex(h.remote.publicKey), srcPort: 257,
        dstPort: 257, payload: capability(2).slice(0, 11) });
      expect(h.records.map(record => record.msgType)).toEqual([0x14, 0x10]);
      expect(h.session.routeWarmup?.remaining).toBe(3);
    } finally { h.manager.stop(); h.initiator.close(); }
  });

  it("keeps route learning for non-capability envelopes and other service ports", async () => {
    const h = await harness();
    try {
      const wrongMagic = capability(2); wrongMagic[0] ^= 1;
      const wrongVersion = capability(2); wrongVersion[8] = 2;
      for (const payload of [wrongMagic, wrongVersion, capability(3), capability(2).slice(0, 11),
        new Uint8Array([...capability(2), 0])]) {
        const before = h.routeSnapshot();
        await h.receive(h.initiator.encryptDatagram({ srcPort: 257, dstPort: 257, payload }));
        expect(h.routeSnapshot()).not.toEqual(before);
      }
      for (const [srcPort, dstPort] of [[256, 257], [257, 42]]) {
        const before = h.routeSnapshot();
        await h.receive(h.initiator.encryptDatagram({ srcPort, dstPort, payload: capability(2) }));
        expect(h.routeSnapshot()).not.toEqual(before);
      }
      expect(h.application).toEqual([capability(2)]);
    } finally { h.manager.stop(); h.initiator.close(); }
  });

  it("retains authenticated malformed-data accounting and its prior route-learning behavior", async () => {
    const h = await harness();
    try {
      const before = h.routeSnapshot();
      const malformed = h.initiator.encryptMessage(0x10, Uint8Array.of(1, 2, 3));
      await expect(h.receive(malformed)).rejects.toThrow();
      expect(h.routeSnapshot()).not.toEqual(before);
      const report = h.session.receiverReports!.build(100)!;
      const view = new DataView(report.buffer, report.byteOffset, report.byteLength);
      expect(view.getBigUint64(10, true)).toBe(1n);
      expect(view.getBigUint64(18, true)).toBe(9n);
      const after = h.routeSnapshot();
      await expect(h.receive(malformed)).rejects.toThrow(/replay/);
      expect(h.routeSnapshot()).toEqual(after);
    } finally { h.manager.stop(); h.initiator.close(); }
  });
});
