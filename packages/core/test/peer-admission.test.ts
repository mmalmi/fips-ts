import { afterEach, expect, it, vi } from "vitest";
import { FipsNode, FmpLink, generateIdentity, toHex, type DiscoveredPeer, type Transport, type TransportAddress, type TransportContext } from "../src/index.js";
import { MemoryHub, MemoryTransport } from "../../transport-memory/src/MemoryTransport.js";
import { FspSession } from "../src/fsp/session.js";

class PausedTransport extends MemoryTransport {
  release?: () => void;
  private reject?: (error: Error) => void;
  private paused?: Promise<void>;
  pauseConnect = false;
  pauseSend = false;
  discover?: () => AsyncIterable<DiscoveredPeer>;
  finishDiscovery?: () => void;
  async pause() {
    this.paused ??= new Promise<void>((resolve, reject) => { this.release = resolve; this.reject = reject; })
      .finally(() => { this.paused = undefined; this.release = this.reject = undefined; });
    await this.paused;
  }
  override async connect(addr: TransportAddress) {
    if (this.pauseConnect) await this.pause();
    await super.connect(addr);
  }
  override async send(addr: TransportAddress, packet: Uint8Array) {
    if (this.pauseSend) await this.pause();
    await super.send(addr, packet);
  }
  override async stop() {
    this.finishDiscovery?.();
    this.finishDiscovery = undefined;
    this.reject?.(new Error("transport stopped"));
    this.release = this.reject = undefined;
    this.pauseConnect = this.pauseSend = false;
    await super.stop();
  }
}

const nodes: FipsNode[] = [];
afterEach(async () => { await Promise.all(nodes.splice(0).map(node => node.stop())); });
async function fixture() {
  const hub = new MemoryHub();
  const peers = await Promise.all([0, 1, 2].map(async index => {
    const identity = await generateIdentity();
    const transport = new PausedTransport({ hub });
    const node = new FipsNode({ identity, transports: [transport], strictClient: index === 0,
      forwarding: index !== 0, routingMode: "reply_learned" });
    nodes.push(node);
    await node.start();
    return { node, transport, key: toHex(identity.publicKey), identity };
  }));
  return peers;
}
function address(key: string) { return { transport: "memory", addr: key }; }

it.each(["connect", "send"])("revokes a paused %s and keeps the same reader/service usable", async phase => {
  const [reader, sibling, provider] = await fixture();
  const received: number[] = [];
  const siblingPackets: number[] = [];
  reader.node.registerService(9000, ({ payload }) => { received.push(payload[0]); });
  sibling.node.registerService(9001, ({ payload }) => { siblingPackets.push(payload[0]); });
  provider.node.registerService(9001, ({ payload, reply }) => reply(payload));
  await reader.node.connect(address(provider.key));
  await reader.node.sendDatagram({ dst: provider.key, srcPort: 9000, dstPort: 9001, payload: new Uint8Array([3]) });
  await vi.waitFor(() => expect(received).toEqual([3]));
  if (phase === "send") {
    await reader.node.connect(address(sibling.key));
    await reader.node.sendDatagram({ dst: sibling.key, srcPort: 9000, dstPort: 9001, payload: new Uint8Array([1]) });
    await vi.waitFor(() => expect(siblingPackets).toEqual([1]));
    reader.transport.pauseSend = true;
  } else reader.transport.pauseConnect = true;
  const pending = (phase === "connect" ? reader.node.connect(address(sibling.key))
    : reader.node.sendDatagram({ dst: sibling.key, dstPort: 9001, payload: new Uint8Array([2]) }))
    .then(() => "unexpected success", error => String(error));
  await vi.waitFor(() => expect(reader.transport.release).toBeTypeOf("function"));
  // Compressed parity and x-only spellings must refer to the same identity.
  const afterRevocation = vi.spyOn(reader.transport, "send");
  await reader.node.setBlockedPeerPubkeys([sibling.key.slice(2)]);
  expect(afterRevocation.mock.calls.some(([addr]) => addr.addr === sibling.key)).toBe(false);
  expect(await pending).not.toBe("unexpected success");
  await expect(reader.node.connect(address(sibling.key))).rejects.toThrow(/blocked|denied/i);
  expect(siblingPackets).toEqual(phase === "send" ? [1] : []);
  const stop = vi.spyOn(reader.transport, "stop");
  await reader.node.setBlockedPeerPubkeys([`03${sibling.key.slice(2)}`, sibling.key]);
  expect(stop).not.toHaveBeenCalled();
  await reader.node.connect(address(provider.key));
  await reader.node.sendDatagram({ dst: provider.key, srcPort: 9000, dstPort: 9001, payload: new Uint8Array([7]) });
  await vi.waitFor(() => expect(received).toEqual([3, 7]));
});

it("rejects initial blocked identities before transport discovery or a direct connection", async () => {
  const identity = await generateIdentity();
  const blocked = await generateIdentity();
  const transport = new MemoryTransport({ hub: new MemoryHub() });
  const connect = vi.spyOn(transport, "connect");
  const node = new FipsNode({ identity, transports: [transport], strictClient: true,
    blockedPeerPubkeys: [toHex(blocked.xOnlyPubkey)] });
  nodes.push(node);
  await node.start();
  await expect(node.connect(address(toHex(blocked.publicKey)))).rejects.toThrow(/blocked|denied/i);
  expect(connect).not.toHaveBeenCalled();
});

it("revokes an asynchronous discovery and rejects its cached replay after restart", async () => {
  const [reader, sibling, provider] = await fixture();
  await reader.node.stop();
  reader.transport.discover = async function* () {
    const stopped = new Promise<void>(resolve => { reader.transport.finishDiscovery = resolve; });
    yield { remoteAddr: address(sibling.key), publicKey: sibling.identity.publicKey };
    await stopped;
  };
  reader.transport.pauseConnect = true;
  const connect = vi.spyOn(reader.transport, "connect");
  await reader.node.start();
  await vi.waitFor(() => expect(reader.transport.release).toBeTypeOf("function"));
  await reader.node.setBlockedPeerPubkeys([sibling.key]);
  expect(connect).toHaveBeenCalledOnce();
  await reader.node.connect(address(provider.key));
  expect(connect).toHaveBeenCalledTimes(2);
});

it("does not acknowledge a revocation when a transport failed to close", async () => {
  const [reader, sibling] = await fixture();
  const stop = vi.spyOn(reader.transport, "stop").mockRejectedValueOnce(new Error("closure failed"));
  await expect(reader.node.setBlockedPeerPubkeys([sibling.key])).rejects.toThrow(/closure failed/);
  expect(stop).toHaveBeenCalledOnce();
  await expect(reader.node.connect(address(sibling.key))).rejects.toThrow(/blocked|denied|stopped/i);
  // A rejected barrier still allows normal disposal to retry the failed close.
  await reader.node.stop();
  expect(stop).toHaveBeenCalledTimes(2);
});

it("lets disposal win a race with the reader's policy reset", async () => {
  const [reader, sibling] = await fixture();
  const originalStop = reader.transport.stop.bind(reader.transport);
  let release!: () => void;
  const closing = new Promise<void>(resolve => { release = resolve; });
  const start = vi.spyOn(reader.transport, "start");
  const stop = vi.spyOn(reader.transport, "stop").mockImplementationOnce(async () => {
    await originalStop();
    await closing;
  });
  try {
    const update = reader.node.setBlockedPeerPubkeys([sibling.key]);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    const disposed = reader.node.stop();
    release();
    await Promise.all([update, disposed]);
    expect(start).not.toHaveBeenCalled();
    await reader.node.setBlockedPeerPubkeys([]);
    expect(start).not.toHaveBeenCalled();
  } finally { release(); }
});

it("checks the Noise-authenticated identity at an unknown WebSocket URL", async () => {
  const [local, forbidden, permitted] = await Promise.all([0, 1, 2].map(() => generateIdentity()));
  let context!: TransportContext;
  const replies: Uint8Array[] = [];
  const transport: Transport = {
    type: "websocket", mtu: 1400,
    start: async ctx => { context = ctx; }, stop: async () => {}, connect: async () => {},
    send: async (_addr, data) => { replies.push(data); },
  };
  const node = new FipsNode({ identity: local, transports: [transport], strictClient: true,
    blockedPeerPubkeys: [toHex(forbidden.publicKey)] });
  nodes.push(node);
  await node.start();
  for (const identity of [forbidden, permitted]) {
    const initiator = new FmpLink({ identity, role: "initiator", remotePubkey: local.publicKey,
      sessionIdx: 71, localEpoch: new Uint8Array(8) });
    const packet = initiator.buildMsg1(() => new Uint8Array(32)).packet;
    context.onPacket({ transportType: "websocket", remoteAddr: { transport: "websocket", addr: "wss://bootstrap.invalid/fips" },
      data: packet, receivedAtMs: Date.now() });
    if (identity === forbidden) expect(replies).toHaveLength(0);
    else {
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
      initiator.handleMsg2(replies[0]);
      expect(initiator.state).toBe("established");
    }
  }
});

it("discards a routed Noise session whose authenticated key is blocked", async () => {
  const [local, forbidden, claimed] = await Promise.all([0, 1, 2].map(() => generateIdentity()));
  const reader = new FipsNode({ identity: local, transports: [], strictClient: true,
    blockedPeerPubkeys: [toHex(forbidden.publicKey)] });
  const internal = reader as any;
  const replies: Uint8Array[] = [];
  vi.spyOn(internal.routing, "sendFspReplyToward").mockImplementation(async (_target: any, frame: any) => { replies.push(frame); });
  const initiator = new FspSession({ identity: forbidden, role: "initiator", remotePubkey: local.publicKey });
  // XK does not reveal the initiator's authenticated key until its last flight.
  const setup = initiator.buildSessionSetup(() => new Uint8Array(), [claimed.nodeAddr], [local.nodeAddr]);
  await internal.sessionManager.handleFromPeer({}, claimed.nodeAddr, setup);
  expect(replies).toHaveLength(1);
  const finish = initiator.handleSessionAck(replies[0], () => new Uint8Array());
  await expect(internal.sessionManager.handleFromPeer({}, claimed.nodeAddr, finish)).rejects.toThrow(/blocked/);
  expect(internal.sessionManager.sessions.size).toBe(0);
});
