import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FipsNode, FmpLink, identityFromSecretKey, toHex,
  type FipsIdentity, type Transport, type TransportAddress, type TransportContext,
} from "../src/index.js";
import { FspSession } from "../src/fsp/session.js";
import { decodeSessionAck } from "../src/protocol/session.js";
import { encodeTreeAnnounce } from "../src/protocol/tree.js";
import { TreeState } from "../src/node/TreeState.js";

// The carrier is local, but both directions use real Noise/FMP wire records.
class WirePeer implements Transport {
  readonly type = "wire";
  readonly mtu = 1400;
  readonly frames: Array<{ msgType: number; payload: Uint8Array }> = [];
  context?: TransportContext;
  private link: FmpLink;
  constructor(readonly identity: FipsIdentity, readonly modern: boolean | "namespaced") {
    this.link = this.newLink();
  }
  private newLink() {
    return new FmpLink({ identity: this.identity, role: "responder", sessionIdx: 51, localEpoch: new Uint8Array(8) });
  }
  async start(context: TransportContext) { this.context = context; this.link = this.newLink(); }
  async stop() { this.context = undefined; this.link.close(); }
  async connect() {}
  async send(address: TransportAddress, packet: Uint8Array) {
    if (packet[0] === 1) {
      const reply = this.link.handleMsg1(packet, () => new Uint8Array(32)).reply!;
      queueMicrotask(() => this.deliver(address, reply));
      return;
    }
    const frame = this.link.decryptIncoming(packet);
    this.frames.push(frame);
    if (this.modern === true && frame.msgType === 0x53) {
      queueMicrotask(() => this.announce(0x53, new Uint8Array()));
    }
    if (this.modern === "namespaced" && frame.msgType === 0xe0 && frame.payload[9] === 1) {
      const response = new Uint8Array([...new TextEncoder().encode("FIPS-EXT"), 1, 2, 2, 0]);
      queueMicrotask(() => this.announce(0xe0, response));
    }
  }
  announce(type: number, payload: Uint8Array) {
    this.deliver({ transport: this.type, addr: toHex(this.identity.publicKey) },
      this.link.encryptOutgoing(payload, type));
  }
  private deliver(remoteAddr: TransportAddress, data: Uint8Array) {
    this.context?.onPacket({ transportType: this.type, remoteAddr, data, receivedAtMs: Date.now() });
  }
}

const nodes: FipsNode[] = [];
afterEach(async () => { await Promise.all(nodes.splice(0).map(node => node.stop())); });
async function identities() {
  const ids = await Promise.all([1, 2, 3, 4].map(n => {
    const secret = new Uint8Array(32); secret[31] = n;
    return identityFromSecretKey(secret);
  }));
  return ids.sort((a, b) => toHex(a.nodeAddr).localeCompare(toHex(b.nodeAddr)));
}

describe("strict clients on authenticated wire", () => {
  it.each([false, true, "namespaced"] as const)("never publishes ancestry to a modern=%s peer, including after restart", async modern => {
    const [contact, own, seed, anonymous] = await identities();
    for (const identity of [own, anonymous]) {
      const transport = new WirePeer(seed, modern);
      const node = new FipsNode({ identity, transports: [transport], strictClient: true,
        heartbeatIntervalMs: 25 });
      nodes.push(node);
      for (let restart = 0; restart < 2; restart++) {
        transport.frames.length = 0;
        await node.start();
        await node.connect({ transport: transport.type, addr: toHex(seed.publicKey) });
        const inherited = new TreeState(seed);
        const privateAncestor = identity === anonymous ? own : contact;
        inherited.updatePeer(privateAncestor.nodeAddr, new TreeState(privateAncestor).announce());
        transport.announce(0x10, encodeTreeAnnounce(inherited.announce()).subarray(1));
        await vi.waitFor(() => expect((node as any).routing.treeState.coords).toContainEqual(privateAncestor.nodeAddr));
        expect(transport.frames.filter(f => f.msgType === 0x10 || f.msgType === 0x20)).toEqual([]);
        if (modern === "namespaced") {
          await vi.waitFor(() => expect(transport.frames.some(f => f.msgType === 0xe0 && f.payload[9] === 3)).toBe(true));
          expect(transport.frames.some(f => f.msgType === 0x53)).toBe(false);
          for (const frame of transport.frames.filter(f => f.msgType === 0xe0 && f.payload[9] === 3)) {
            expect(frame.payload).toHaveLength(18);
          }
        } else {
          await vi.waitFor(() => expect(transport.frames.some(f => f.msgType === 0x53)).toBe(true));
          if (modern) await vi.waitFor(() => expect(transport.frames.some(f => f.msgType === 0x52)).toBe(true));
          else await vi.waitFor(() => expect(transport.frames.filter(f => f.msgType === 0x53).length).toBeGreaterThan(1));
        }
        const firstCapability = transport.frames.find(f => [0xe0, 0x52, 0x53].includes(f.msgType));
        expect(firstCapability?.msgType).toBe(0xe0);
        expect(firstCapability?.payload).toEqual(new Uint8Array([...new TextEncoder().encode("FIPS-EXT"), 1, 1, 2, 0]));
        expect(transport.frames.filter(f => f.msgType === 0x10 || f.msgType === 0x20)).toEqual([]);
        expect(transport.frames.some(f => f.msgType === 0x52)).toBe(modern === true);
        for (const frame of transport.frames.filter(f => f.msgType === 0x52)) expect(frame.payload).toHaveLength(8);
        await node.stop();
      }
    }
  });

  it("leaves ordinary router tree and filter publication enabled", async () => {
    const [identity, remote] = await identities();
    const transport = new WirePeer(remote, false);
    const node = new FipsNode({ identity, transports: [transport], forwarding: true });
    nodes.push(node);
    await node.start();
    await node.connect({ transport: transport.type, addr: toHex(remote.publicKey) });
    await vi.waitFor(() => expect(transport.frames.some(f => f.msgType === 0x10)).toBe(true));
    await vi.waitFor(() => expect(transport.frames.some(f => f.msgType === 0x20)).toBe(true));
    expect(transport.frames.some(f => f.msgType === 0x52 || f.msgType === 0x53)).toBe(false);
  });

  it("does not echo inherited sender coordinates in an actual FSP ACK", async () => {
    const [contact, own, remote] = await identities();
    const initiator = new FspSession({ identity: remote, role: "initiator", remotePubkey: own.publicKey });
    const responder = new FspSession({ identity: own, role: "responder", strictClient: true });
    const setup = initiator.buildSessionSetup(() => new Uint8Array(), [remote.nodeAddr, contact.nodeAddr], [own.nodeAddr]);
    const ack = responder.handleSessionSetup(setup, () => new Uint8Array(), [own.nodeAddr]);
    expect(decodeSessionAck(ack).destCoords).toEqual([remote.nodeAddr]);
    responder.handleSessionMsg3(initiator.handleSessionAck(ack, () => new Uint8Array()));
    expect(responder.state).toBe("established");
  });
});
