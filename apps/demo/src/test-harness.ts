/**
 * Test harness exposed to Playwright. Lets tests drive a pair of FipsNodes
 * inside the demo page over the real WebRtcTransport, with the local Nostr
 * relay URL injected via the global `__fipsTestRelayUrl`.
 */

import { FipsNode, generateIdentity, toHex } from "@fips/core";
import { MemoryHub, MemoryTransport } from "@fips/transport-memory";
import { WebRtcTransport } from "@fips/transport-webrtc";
import { FipsHashtreeStore } from "@fips/hashtree-adapter";
import { sha256 } from "@noble/hashes/sha256";

class MemHashtreeStore {
  private readonly m = new Map<string, Uint8Array>();
  async get(h: Uint8Array): Promise<Uint8Array | null> {
    return this.m.get(toHex(h)) ?? null;
  }
  async put(h: Uint8Array, d: Uint8Array): Promise<boolean> {
    const k = toHex(h);
    const fresh = !this.m.has(k);
    this.m.set(k, d);
    return fresh;
  }
}

interface NodePair {
  a: FipsNode;
  b: FipsNode;
  aPub: string;
  bPub: string;
}

interface ThreeNodes {
  a: FipsNode;
  b: FipsNode;
  c: FipsNode;
  aPub: string;
  bPub: string;
  cPub: string;
}

declare global {
  interface Window {
    __fipsHarness: typeof harness;
    __fipsTestRelayUrl?: string;
  }
}

async function makeWebRtcPair(relayUrl: string): Promise<NodePair> {
  const logger = {
    debug: (...a: unknown[]) => console.log("[webrtc]", ...a),
    info: (...a: unknown[]) => console.log("[webrtc:info]", ...a),
    warn: (...a: unknown[]) => console.warn("[webrtc:warn]", ...a),
    error: (...a: unknown[]) => console.error("[webrtc:err]", ...a),
  };
  const aId = await generateIdentity();
  const bId = await generateIdentity();
  console.log("[harness] A pub", toHex(aId.publicKey));
  console.log("[harness] B pub", toHex(bId.publicKey));
  const a = new FipsNode({
    identity: aId,
    logger,
    transports: [
      new WebRtcTransport({ relays: [relayUrl], advertiseOnNostr: true, logger }),
    ],
  });
  const b = new FipsNode({
    identity: bId,
    logger,
    transports: [
      new WebRtcTransport({ relays: [relayUrl], advertiseOnNostr: true, logger }),
    ],
  });
  a.on("error", (e) => console.warn("[harness] A error", e));
  b.on("error", (e) => console.warn("[harness] B error", e));
  a.on("peer", (e) => console.log("[harness] A peer", e));
  b.on("peer", (e) => console.log("[harness] B peer", e));
  b.registerService(9000, async ({ payload, reply }) => {
    console.log("[harness] B got datagram, length", payload.length);
    await reply(payload);
  });
  await a.start();
  await b.start();
  console.log("[harness] both started, dialing A→B");
  await a.connect({ transport: "webrtc", addr: toHex(bId.publicKey) });
  console.log("[harness] connected, datachannel ready");
  return { a, b, aPub: toHex(aId.publicKey), bPub: toHex(bId.publicKey) };
}

async function memoryThreeNodes(): Promise<ThreeNodes> {
  const hub = new MemoryHub();
  const aId = await generateIdentity();
  const bId = await generateIdentity();
  const cId = await generateIdentity();
  const a = new FipsNode({ identity: aId, transports: [new MemoryTransport({ hub })] });
  const b = new FipsNode({ identity: bId, transports: [new MemoryTransport({ hub })], forwarding: true });
  const c = new FipsNode({ identity: cId, transports: [new MemoryTransport({ hub })] });
  c.registerService(9000, async ({ payload, reply }) => {
    await reply(payload);
  });
  await a.start();
  await b.start();
  await c.start();
  await a.connect({ transport: "memory", addr: toHex(bId.publicKey) });
  await b.connect({ transport: "memory", addr: toHex(cId.publicKey) });
  return { a, b, c, aPub: toHex(aId.publicKey), bPub: toHex(bId.publicKey), cPub: toHex(cId.publicKey) };
}

async function memoryHashtreePair(): Promise<{
  aPub: string;
  cFetched: string | null;
  aTeardown: () => Promise<void>;
}> {
  const hub = new MemoryHub();
  const aId = await generateIdentity();
  const cId = await generateIdentity();
  const aNode = new FipsNode({ identity: aId, transports: [new MemoryTransport({ hub })] });
  const cNode = new FipsNode({ identity: cId, transports: [new MemoryTransport({ hub })] });
  const aStore = new MemHashtreeStore();
  const blob = new TextEncoder().encode("hashtree-over-fips-smoke");
  const hash = sha256(blob);
  await aStore.put(hash, blob);
  new FipsHashtreeStore({ node: aNode, localStore: aStore, peers: [] });
  const cAdapter = new FipsHashtreeStore({
    node: cNode,
    localStore: new MemHashtreeStore(),
    peers: [toHex(aId.publicKey)],
    requestTimeoutMs: 5_000,
  });
  await aNode.start();
  await cNode.start();
  await cNode.connect({ transport: "memory", addr: toHex(aId.publicKey) });
  const fetched = await cAdapter.get(hash);
  return {
    aPub: toHex(aId.publicKey),
    cFetched: fetched ? new TextDecoder().decode(fetched) : null,
    aTeardown: async () => {
      await aNode.stop();
      await cNode.stop();
    },
  };
}

async function echoOverPair(pair: NodePair, payload: string, port = 9000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 20_000);
    const off = pair.a.on("datagram", (evt) => {
      const dg = evt as { dstPort: number; payload: Uint8Array };
      if (dg.dstPort === port) {
        clearTimeout(timer);
        off();
        resolve(new TextDecoder().decode(dg.payload));
      }
    });
    void pair.a.sendDatagram({
      dst: pair.bPub,
      srcPort: port,
      dstPort: port,
      payload: new TextEncoder().encode(payload),
    });
  });
}

async function echoOverChain(three: ThreeNodes, payload: string, port = 9000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 20_000);
    const off = three.a.on("datagram", (evt) => {
      const dg = evt as { src: string; dstPort: number; payload: Uint8Array };
      if (dg.src === three.cPub && dg.dstPort === port) {
        clearTimeout(timer);
        off();
        resolve(new TextDecoder().decode(dg.payload));
      }
    });
    void three.a.sendDatagram({
      dst: three.cPub,
      srcPort: port,
      dstPort: port,
      payload: new TextEncoder().encode(payload),
    });
  });
}

async function makeWebRtcChain(relayUrl: string): Promise<ThreeNodes> {
  const logger = {
    debug: (..._a: unknown[]) => {},
    info: (...a: unknown[]) => console.log("[webrtc:info]", ...a),
    warn: (...a: unknown[]) => console.warn("[webrtc:warn]", ...a),
    error: (...a: unknown[]) => console.error("[webrtc:err]", ...a),
  };
  const aId = await generateIdentity();
  const bId = await generateIdentity();
  const cId = await generateIdentity();
  const a = new FipsNode({
    identity: aId,
    logger,
    transports: [new WebRtcTransport({ relays: [relayUrl], advertiseOnNostr: true, logger })],
  });
  const b = new FipsNode({
    identity: bId,
    logger,
    forwarding: true,
    transports: [new WebRtcTransport({ relays: [relayUrl], advertiseOnNostr: true, logger })],
  });
  const c = new FipsNode({
    identity: cId,
    logger,
    transports: [new WebRtcTransport({ relays: [relayUrl], advertiseOnNostr: true, logger })],
  });
  c.registerService(9000, async ({ payload, reply }) => {
    await reply(payload);
  });
  await a.start();
  await b.start();
  await c.start();
  // A<->B and B<->C, but NOT A<->C.
  await a.connect({ transport: "webrtc", addr: toHex(bId.publicKey) });
  await b.connect({ transport: "webrtc", addr: toHex(cId.publicKey) });
  return { a, b, c, aPub: toHex(aId.publicKey), bPub: toHex(bId.publicKey), cPub: toHex(cId.publicKey) };
}

async function webRtcReconnect(relayUrl: string): Promise<{ first: string; second: string }> {
  const logger = {
    debug: (..._a: unknown[]) => {},
    info: (...a: unknown[]) => console.log("[webrtc:info]", ...a),
    warn: (...a: unknown[]) => console.warn("[webrtc:warn]", ...a),
    error: (...a: unknown[]) => console.error("[webrtc:err]", ...a),
  };
  const aId = await generateIdentity();
  const bId = await generateIdentity();

  async function dial(): Promise<NodePair> {
    const a = new FipsNode({
      identity: aId,
      logger,
      transports: [new WebRtcTransport({ relays: [relayUrl], advertiseOnNostr: true, logger })],
    });
    const b = new FipsNode({
      identity: bId,
      logger,
      transports: [new WebRtcTransport({ relays: [relayUrl], advertiseOnNostr: true, logger })],
    });
    b.registerService(9000, async ({ payload, reply }) => {
      await reply(payload);
    });
    await a.start();
    await b.start();
    await a.connect({ transport: "webrtc", addr: toHex(bId.publicKey) });
    return { a, b, aPub: toHex(aId.publicKey), bPub: toHex(bId.publicKey) };
  }

  const pair1 = await dial();
  const first = await echoOverPair(pair1, "before-reconnect");
  await pair1.a.stop();
  await pair1.b.stop();

  const pair2 = await dial();
  const second = await echoOverPair(pair2, "after-reconnect");
  await pair2.a.stop();
  await pair2.b.stop();
  return { first, second };
}

async function reconnectMemoryPair(): Promise<{ first: string; second: string }> {
  const hub = new MemoryHub();
  const aId = await generateIdentity();
  const bId = await generateIdentity();

  const startPair = async () => {
    const a = new FipsNode({ identity: aId, transports: [new MemoryTransport({ hub })] });
    const b = new FipsNode({ identity: bId, transports: [new MemoryTransport({ hub })] });
    b.registerService(9000, async ({ payload, reply }) => {
      await reply(payload);
    });
    await a.start();
    await b.start();
    await a.connect({ transport: "memory", addr: toHex(bId.publicKey) });
    return { a, b };
  };

  const echo = (pair: { a: FipsNode; b: FipsNode }, payload: string) =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5_000);
      const off = pair.a.on("datagram", (evt) => {
        const dg = evt as { dstPort: number; payload: Uint8Array };
        if (dg.dstPort === 9000) {
          clearTimeout(timer);
          off();
          resolve(new TextDecoder().decode(dg.payload));
        }
      });
      void pair.a.sendDatagram({
        dst: toHex(bId.publicKey),
        srcPort: 9000,
        dstPort: 9000,
        payload: new TextEncoder().encode(payload),
      });
    });

  const pair1 = await startPair();
  const first = await echo(pair1, "before");
  await pair1.a.stop();
  await pair1.b.stop();

  const pair2 = await startPair();
  const second = await echo(pair2, "after");
  await pair2.a.stop();
  await pair2.b.stop();
  return { first, second };
}

export const harness = {
  makeWebRtcPair,
  makeWebRtcChain,
  webRtcReconnect,
  memoryThreeNodes,
  memoryHashtreePair,
  reconnectMemoryPair,
  echoOverPair,
  echoOverChain,
};
