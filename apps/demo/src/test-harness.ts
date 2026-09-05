/**
 * Test harness exposed to Playwright. Lets tests drive a pair of FipsNodes
 * inside the demo page over the real WebRtcTransport, with local WSS seed and
 * Nostr advert relay URLs injected through the test globals below.
 */

import {
  IndexedDbIdentityStore,
  IndexedDbRecentPeersStore,
} from "@fips/browser";
import {
  FipsNode,
  encodeNpub,
  generateIdentity,
  observeAuthenticatedPeer,
  toHex,
} from "@fips/core";
import { MemoryHub, MemoryTransport } from "@fips/transport-memory";
import {
  NostrRelayClient,
  WebRtcTransport,
} from "@fips/transport-webrtc";
import { webSocketSeedTransport, webRtcTransports, waitForPeerState } from "./test-transports.js";

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

interface PersistentWebRtcPeer {
  node: FipsNode;
  pubkey: string;
  connectedPeers: Set<string>;
  errors: string[];
}

let persistentWebRtcPeer: PersistentWebRtcPeer | undefined;

declare global {
  interface Window {
    __fipsHarness: typeof harness;
    __fipsTestRelayUrl?: string;
    __fipsTestWebSocketSeedUrl?: string;
    __closeFipsTestWebSocketSeed?: () => Promise<void>;
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
    transports: webRtcTransports({ relays: [relayUrl], advertiseOnNostr: true, logger }),
  });
  const b = new FipsNode({
    identity: bId,
    logger,
    transports: webRtcTransports({ relays: [relayUrl], advertiseOnNostr: true, logger }),
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

async function autoConnectWebRtcPair(relayUrl: string): Promise<NodePair> {
  const aId = await generateIdentity();
  const bId = await generateIdentity();
  const a = new FipsNode({
    identity: aId,
    transports: webRtcTransports({
        relays: [relayUrl],
        advertiseOnNostr: true,
        autoConnect: true,
      }),
  });
  const b = new FipsNode({
    identity: bId,
    transports: webRtcTransports({
        relays: [relayUrl],
        advertiseOnNostr: true,
        autoConnect: true,
      }),
  });
  b.registerService(9000, async ({ payload, reply }) => {
    await reply(payload);
  });

  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("advert FMP connect timeout")), 20_000);
    const off = a.on("peer", (event) => {
      const peer = event as { remotePubkey: string; state: string };
      if (peer.remotePubkey !== toHex(bId.publicKey) || peer.state !== "connected") return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });

  await a.start();
  await b.start();
  await connected;
  return { a, b, aPub: toHex(aId.publicKey), bPub: toHex(bId.publicKey) };
}

async function autoConnectWebRtcReconnect(relayUrl: string): Promise<{ first: string; second: string }> {
  const discoveryApp = "fips-auto-reconnect-e2e";
  const firstIdentity = await generateIdentity();
  const secondIdentity = await generateIdentity();
  // Only the lower x-only identity auto-dials when both peers accept connections.
  const [aId, bId] = toHex(firstIdentity.xOnlyPubkey) < toHex(secondIdentity.xOnlyPubkey)
    ? [firstIdentity, secondIdentity]
    : [secondIdentity, firstIdentity];
  const aTransport = new WebRtcTransport({
    relays: [relayUrl],
    advertiseOnNostr: true,
    autoConnect: true,
    maxConnections: 1,
    discoveryApp,
  });
  const bTransport = new WebRtcTransport({
    relays: [relayUrl],
    advertiseOnNostr: true,
    autoConnect: false,
    maxConnections: 1,
    discoveryApp,
  });
  const a = new FipsNode({ identity: aId, transports: [webSocketSeedTransport(), aTransport] });
  const b = new FipsNode({ identity: bId, transports: [webSocketSeedTransport(), bTransport] });
  const pair = { a, b, aPub: toHex(aId.publicKey), bPub: toHex(bId.publicKey) };
  b.registerService(9000, async ({ payload, reply }) => {
    await reply(payload);
  });

  await a.start();
  await b.start();
  try {
    await waitForPeerState(a, pair.bPub, "connected");
    const first = await echoOverPair(pair, "before-auto-reconnect");
    await new Promise((resolve) => {
      setTimeout(resolve, 2_000);
    });
    const disconnected = waitForPeerState(a, pair.bPub, "disconnected");
    await aTransport.close({ transport: "webrtc", addr: pair.bPub });
    await disconnected;
    await waitForPeerState(a, pair.bPub, "connected");
    const second = await echoOverPair(pair, "after-auto-reconnect");
    return { first, second };
  } finally {
    await a.stop();
    await b.stop();
  }
}

async function autoConnectWebRtcPeerRestart(
  initialRelayUrl: string,
  replacementRelayUrl: string,
  listenerAcceptsIncoming: boolean,
): Promise<{ first: string; second: string }> {
  const discoveryApp = `fips-peer-restart-${crypto.randomUUID()}`;
  const firstIdentity = await generateIdentity();
  const secondIdentity = await generateIdentity();
  const [lowerIdentity, higherIdentity] =
    toHex(firstIdentity.publicKey) < toHex(secondIdentity.publicKey)
      ? [firstIdentity, secondIdentity]
      : [secondIdentity, firstIdentity];
  const [aId, bId] = listenerAcceptsIncoming
    ? [higherIdentity, lowerIdentity]
    : [lowerIdentity, higherIdentity];
  const options = {
    advertiseOnNostr: true,
    autoConnect: true,
    maxConnections: 1,
    discoveryApp,
  };
  const a = new FipsNode({
    identity: aId,
    transports: webRtcTransports({
      ...options,
      relays: [...new Set([initialRelayUrl, replacementRelayUrl])],
    }),
  });
  const originalRelay = new NostrRelayClient({ url: initialRelayUrl });
  const createB = (relayUrl: string, relayClients?: NostrRelayClient[]) => {
    const node = new FipsNode({
      identity: bId,
      transports: webRtcTransports({
        ...options,
        relays: [relayUrl],
        relayClients,
      }),
    });
    node.registerService(9000, async ({ payload, reply }) => reply(payload));
    return node;
  };
  const originalB = createB(initialRelayUrl, [originalRelay]);
  let replacementB: FipsNode | undefined;
  const aPub = toHex(aId.publicKey);
  const bPub = toHex(bId.publicKey);

  await a.start();
  const initiallyConnected = waitForPeerState(a, bPub, "connected");
  await originalB.start();
  await initiallyConnected;
  try {
    const first = await echoOverPair({ a, b: originalB, aPub, bPub }, "before-peer-restart");
    await originalB.stop();
    originalRelay.close();
    replacementB = createB(replacementRelayUrl);
    const replacementConnected = waitForPeerState(replacementB, aPub, "connected");
    await replacementB.start();
    await replacementConnected;
    const second = await echoOverPair({ a, b: replacementB, aPub, bPub }, "after-peer-restart");
    return { first, second };
  } finally {
    await replacementB?.stop();
    await originalB.stop();
    await a.stop();
  }
}

async function autoConnectWebRtcPeerRestartWithRelayReplay(
  relayUrl: string,
): Promise<{ first: string; second: string }> {
  return autoConnectWebRtcPeerRestart(relayUrl, relayUrl, false);
}

async function connectThroughStaleAdvertBacklog(relayUrl: string): Promise<{
  first: string;
  second: string;
}> {
  const discoveryApp = `fips-stale-backlog-${crypto.randomUUID()}`;
  const stalePeerCount = 8;
  for (let index = 0; index < stalePeerCount; index++) {
    const identity = await generateIdentity();
    const node = new FipsNode({
      identity,
      transports: webRtcTransports({
        relays: [relayUrl],
        advertiseOnNostr: true,
        discoveryApp,
      }),
    });
    await node.start();
    await node.stop();
  }

  let resolveBacklog!: () => void;
  const backlogStarted = new Promise<void>((resolve) => {
    resolveBacklog = resolve;
  });
  const pendingStalePeers = new Set<string>();
  const listenerId = await generateIdentity();
  const listenerLogger = {
    debug: (...args: unknown[]) => {
      if (args[0] !== "webrtc connect start" || typeof args[1] !== "string") return;
      pendingStalePeers.add(args[1]);
      if (pendingStalePeers.size >= 4) resolveBacklog();
    },
    info: (..._args: unknown[]) => undefined,
    warn: (..._args: unknown[]) => undefined,
    error: (..._args: unknown[]) => undefined,
  };
  const listener = new FipsNode({
    identity: listenerId,
    logger: listenerLogger,
    transports: webRtcTransports({
      relays: [relayUrl],
      advertiseOnNostr: true,
      autoConnect: true,
      connectTimeoutMs: 8_000,
      discoveryApp,
      maxConnections: 8,
      logger: listenerLogger,
    }),
  });
  listener.registerService(9000, async ({ payload, reply }) => reply(payload));
  await listener.start();

  const backlogTimer = setTimeout(() => resolveBacklog(), 5_000);
  await backlogStarted;
  clearTimeout(backlogTimer);

  const liveId = await generateIdentity();
  const createLiveNode = () => new FipsNode({
    identity: liveId,
    transports: webRtcTransports({
      relays: [relayUrl],
      advertiseOnNostr: true,
      autoConnect: false,
      connectTimeoutMs: 8_000,
      discoveryApp,
      maxConnections: 8,
    }),
  });
  let live = createLiveNode();
  await live.start();
  try {
    await live.connect({ transport: "webrtc", addr: toHex(listenerId.publicKey) });
    const first = await echoOverPair({
      a: live,
      b: listener,
      aPub: toHex(liveId.publicKey),
      bPub: toHex(listenerId.publicKey),
    }, "live-peer-through-stale-backlog");
    await live.stop();
    live = createLiveNode();
    await live.start();
    await live.connect({ transport: "webrtc", addr: toHex(listenerId.publicKey) });
    const second = await echoOverPair({
      a: live,
      b: listener,
      aPub: toHex(liveId.publicKey),
      bPub: toHex(listenerId.publicKey),
    }, "reconnected-peer-through-stale-backlog");
    return { first, second };
  } finally {
    await live.stop();
    await listener.stop();
  }
}


async function duplicateWebRtcConnect(relayUrl: string): Promise<string> {
  const logger = {
    debug: (...a: unknown[]) => console.log("[webrtc-duplicate]", ...a),
    info: (...a: unknown[]) => console.log("[webrtc-duplicate:info]", ...a),
    warn: (...a: unknown[]) => console.warn("[webrtc-duplicate:warn]", ...a),
    error: (...a: unknown[]) => console.error("[webrtc-duplicate:err]", ...a),
  };
  const aId = await generateIdentity();
  const bId = await generateIdentity();
  const a = new FipsNode({
    identity: aId,
    logger,
    transports: webRtcTransports({ relays: [relayUrl], advertiseOnNostr: true, logger }),
  });
  const b = new FipsNode({
    identity: bId,
    logger,
    transports: webRtcTransports({ relays: [relayUrl], advertiseOnNostr: true, logger }),
  });
  b.registerService(9000, async ({ payload, reply }) => {
    await reply(payload);
  });
  await a.start();
  await b.start();
  try {
    const addr = { transport: "webrtc" as const, addr: toHex(bId.publicKey) };
    const first = a.connect(addr);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    const second = a.connect(addr);
    await Promise.all([first, second]);
    return await echoOverPair({ a, b, aPub: toHex(aId.publicKey), bPub: toHex(bId.publicKey) }, "duplicate-connect");
  } finally {
    await a.stop();
    await b.stop();
  }
}

async function memoryThreeNodes(): Promise<ThreeNodes> {
  const hub = new MemoryHub();
  const aId = await generateIdentity();
  const bId = await generateIdentity();
  const cId = await generateIdentity();
  const a = new FipsNode({
    identity: aId,
    transports: [new MemoryTransport({ hub })],
    defaultRoute: toHex(bId.publicKey),
  });
  const b = new FipsNode({ identity: bId, transports: [new MemoryTransport({ hub })], forwarding: true });
  const c = new FipsNode({
    identity: cId,
    transports: [new MemoryTransport({ hub })],
    defaultRoute: toHex(bId.publicKey),
  });
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

async function echoOverPair(pair: NodePair, payload: string, port = 9000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for echo: ${payload}`)), 20_000);
    const off = pair.a.on("datagram", (evt) => {
      const dg = evt as { dstPort: number; payload: Uint8Array };
      const reply = new TextDecoder().decode(dg.payload);
      if (dg.dstPort === port && reply === payload) {
        clearTimeout(timer);
        off();
        resolve(reply);
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
    const timer = setTimeout(() => { off(); reject(new Error("chain echo timeout")); }, 20_000);
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
    }).catch((error) => { clearTimeout(timer); off(); reject(error); });
  });
}

async function makeWebRtcChain(relayUrl: string): Promise<ThreeNodes & { forwardedDatagrams(): number }> {
  const diagnostics: string[] = [];
  const record = (...args: unknown[]) => {
    diagnostics.push(args.map(String).join(" "));
    if (diagnostics.length > 20) diagnostics.shift();
  };
  const logger = { debug: record, info: record, warn: record, error: record };
  const aId = await generateIdentity();
  const bId = await generateIdentity();
  const cId = await generateIdentity();
  let forwardedDatagrams = 0;
  const a = new FipsNode({
    identity: aId,
    logger,
    defaultRoute: toHex(bId.publicKey),
    transports: webRtcTransports({ relays: [relayUrl], advertiseOnNostr: true, logger }),
  });
  const b = new FipsNode({
    identity: bId,
    logger: { ...logger, debug: (...args) => {
      if (args[0] === "session datagram forwarded") forwardedDatagrams++;
      record(...args);
    } },
    forwarding: true,
    routingMode: "reply_learned",
    transports: webRtcTransports({ relays: [relayUrl], advertiseOnNostr: true, logger }),
  });
  const c = new FipsNode({
    identity: cId,
    logger,
    defaultRoute: toHex(bId.publicKey),
    transports: webRtcTransports({ relays: [relayUrl], advertiseOnNostr: true, logger }),
  });
  c.registerService(9000, async ({ payload, reply }) => {
    await reply(payload);
  });
  try {
    await a.start();
    await b.start();
    await c.start();
    await a.connect({ transport: "webrtc", addr: toHex(bId.publicKey) });
    await b.connect({ transport: "webrtc", addr: toHex(cId.publicKey) });
    if (!window.__closeFipsTestWebSocketSeed) throw new Error("chain bootstrap closer is required");
    await Promise.all([
      ...[a, b, c].map((node) => waitForPeerState(node, undefined, "disconnected", "websocket")),
      window.__closeFipsTestWebSocketSeed(),
    ]);
    forwardedDatagrams = 0;
    return { a, b, c, aPub: toHex(aId.publicKey), bPub: toHex(bId.publicKey), cPub: toHex(cId.publicKey),
      forwardedDatagrams: () => forwardedDatagrams };
  } catch (error) {
    await Promise.all([a.stop(), b.stop(), c.stop()]);
    throw new Error(`${String(error)}\n${diagnostics.join("\n")}`);
  }
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
      transports: webRtcTransports({ relays: [relayUrl], advertiseOnNostr: true, logger }),
    });
    const b = new FipsNode({
      identity: bId,
      logger,
      transports: webRtcTransports({ relays: [relayUrl], advertiseOnNostr: true, logger }),
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

async function echoWithRustWebRtcPeer(
  rustPubkeyHex: string,
  payload: string,
  rounds = 1,
): Promise<string> {
  const logger = {
    debug: (...a: unknown[]) => console.log("[rust-webrtc]", ...a),
    info: (...a: unknown[]) => console.log("[rust-webrtc:info]", ...a),
    warn: (...a: unknown[]) => console.warn("[rust-webrtc:warn]", ...a),
    error: (...a: unknown[]) => console.error("[rust-webrtc:err]", ...a),
  };
  const identity = await generateIdentity();
  const hub = new MemoryHub();
  const forwarderIdentity = await generateIdentity();
  const forwarder = rounds > 1 ? new FipsNode({
    identity: forwarderIdentity,
    forwarding: true,
    routingMode: "reply_learned",
    transports: [webSocketSeedTransport(), new MemoryTransport({ hub })],
  }) : undefined;
  const node = new FipsNode({
    identity,
    logger,
    transports: [new MemoryTransport({ hub }), ...webRtcTransports({
        relays: [],
        advertiseOnNostr: false,
        acceptConnections: true,
        autoConnect: false,
        stunServers: [],
        connectTimeoutMs: 20_000,
        iceGatherTimeoutMs: 1_500,
        logger,
      })],
  });

  node.on("error", (event) => {
    const error = event as { err: unknown; where: string };
    console.warn("[rust-webrtc] node error", error.where, String(error.err));
  });
  node.on("peer", (e) => console.log("[rust-webrtc] peer", e));
  node.on("session", (e) => console.log("[rust-webrtc] session", e));

  const echo = (expected: string, sender = node) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("rust echo timeout"));
    }, 20_000);
    const off = sender.on("endpointData", (evt) => {
      const msg = evt as { src: string; payload: Uint8Array };
      if (msg.src !== rustPubkeyHex) return;
      if (new TextDecoder().decode(msg.payload) !== expected) return;
      clearTimeout(timer);
      off();
      resolve();
    });
    void sender.sendEndpointData({
      dst: rustPubkeyHex,
      payload: new TextEncoder().encode(expected),
    }).catch((err) => {
      clearTimeout(timer);
      off();
      reject(err);
    });
  });

  await node.start();
  try {
    if (forwarder) {
      // Give Rust an independent fallback route so erroneous delivery-failure
      // recovery is exercised, even while this WebRTC path keeps working.
      const ready = waitForPeerState(forwarder, rustPubkeyHex, "connected", "websocket");
      await forwarder.start();
      await ready;
      await forwarder.connect({ transport: "memory", addr: toHex(identity.publicKey) });
      const routedIdentity = await generateIdentity();
      const routed = new FipsNode({
        identity: routedIdentity, transports: [new MemoryTransport({ hub })], routingMode: "reply_learned",
      });
      await routed.start();
      try {
        await forwarder.connect({ transport: "memory", addr: toHex(routedIdentity.publicKey) });
        await echo(`${payload}:routed-coordinates`, routed);
      } finally {
        await routed.stop();
      }
    }
    await node.connect({ transport: "webrtc", addr: rustPubkeyHex });
    for (let round = 0; round < rounds; round++) {
      if (round > 0) await new Promise((resolve) => { setTimeout(resolve, 400); });
      const expected = `${payload}:${round}`;
      await echo(expected);
    }
    return payload;
  } finally {
    await Promise.all([node.stop(), forwarder?.stop()]);
  }
}

async function concurrentIdentityStoreCreate(dbName: string): Promise<{
  first: string;
  second: string;
  persisted: string;
}> {
  const firstStore = new IndexedDbIdentityStore(dbName);
  const secondStore = new IndexedDbIdentityStore(dbName);
  const [first, second] = await Promise.all([
    firstStore.getOrCreateIdentity(),
    secondStore.getOrCreateIdentity(),
  ]);
  const persisted = await new IndexedDbIdentityStore(dbName).getOrCreateIdentity();
  return {
    first: toHex(first.publicKey),
    second: toHex(second.publicKey),
    persisted: toHex(persisted.publicKey),
  };
}

async function recentPeersStoreRoundTrip(dbName: string): Promise<{
  persistedPeerCount: number;
  persistedEndpoint: string | undefined;
  otherScopePeerCount: number;
  otherIdentityPeerCount: number;
  clearedPeerCount: number;
}> {
  const store = new IndexedDbRecentPeersStore(dbName);
  const localIdentity = await generateIdentity();
  const otherIdentity = await generateIdentity();
  const remoteIdentity = await generateIdentity();
  const localNpub = encodeNpub(localIdentity.xOnlyPubkey);
  const otherLocalNpub = encodeNpub(otherIdentity.xOnlyPubkey);
  const remoteNpub = encodeNpub(remoteIdentity.xOnlyPubkey);
  const scope = "e2e-scope";
  const recent = observeAuthenticatedPeer(
    await store.load(localNpub, scope),
    remoteNpub,
    1_000,
    "192.0.2.1:32112",
  );
  await store.save(recent);

  const persisted = await new IndexedDbRecentPeersStore(dbName).load(localNpub, scope);
  const otherScope = await store.load(localNpub, "other-scope");
  const otherIdentityCache = await store.load(otherLocalNpub, scope);
  await store.clear(localNpub, scope);
  const cleared = await store.load(localNpub, scope);
  return {
    persistedPeerCount: Object.keys(persisted.peers).length,
    persistedEndpoint: persisted.peers[remoteNpub]?.endpoints[0]?.addr,
    otherScopePeerCount: Object.keys(otherScope.peers).length,
    otherIdentityPeerCount: Object.keys(otherIdentityCache.peers).length,
    clearedPeerCount: Object.keys(cleared.peers).length,
  };
}

async function startPersistentWebRtcPeer(
  relayUrl: string,
  identityStoreName: string,
  discoveryApp: string,
): Promise<string> {
  await persistentWebRtcPeer?.node.stop();
  const identity = await new IndexedDbIdentityStore(identityStoreName).getOrCreateIdentity();
  const pubkey = toHex(identity.publicKey);
  const connectedPeers = new Set<string>();
  const errors: string[] = [];
  const node = new FipsNode({
    identity,
    transports: webRtcTransports({
      relays: [relayUrl],
      advertiseOnNostr: true,
      autoConnect: false,
      discoveryApp,
    }),
  });
  node.on("peer", (event) => {
    const peer = event as { remotePubkey: string; state: string };
    if (peer.state === "connected") connectedPeers.add(peer.remotePubkey);
    if (peer.state === "disconnected") connectedPeers.delete(peer.remotePubkey);
  });
  node.on("error", (event) => {
    const error = event as { err: unknown; where: string };
    errors.push(`${error.where}: ${String(error.err)}`);
  });
  node.registerService(9000, async ({ payload, reply }) => reply(payload));
  persistentWebRtcPeer = { node, pubkey, connectedPeers, errors };
  await node.start();
  return pubkey;
}

async function connectPersistentWebRtcPeer(remotePubkey: string): Promise<void> {
  if (!persistentWebRtcPeer) throw new Error("persistent WebRTC peer is not started");
  await persistentWebRtcPeer.node.connect({ transport: "webrtc", addr: remotePubkey });
  persistentWebRtcPeer.connectedPeers.add(remotePubkey);
}

async function waitForPersistentWebRtcPeer(remotePubkey: string): Promise<void> {
  if (!persistentWebRtcPeer) throw new Error("persistent WebRTC peer is not started");
  if (persistentWebRtcPeer.connectedPeers.has(remotePubkey)) return;
  await waitForPeerState(persistentWebRtcPeer.node, remotePubkey, "connected");
  persistentWebRtcPeer.connectedPeers.add(remotePubkey);
}

async function echoPersistentWebRtcPeer(remotePubkey: string, payload: string): Promise<string> {
  if (!persistentWebRtcPeer) throw new Error("persistent WebRTC peer is not started");
  return echoOverPair({
    a: persistentWebRtcPeer.node,
    b: persistentWebRtcPeer.node,
    aPub: persistentWebRtcPeer.pubkey,
    bPub: remotePubkey,
  }, payload);
}

function persistentWebRtcPeerErrors(): string[] {
  return [...(persistentWebRtcPeer?.errors ?? [])];
}

async function stopPersistentWebRtcPeer(): Promise<void> {
  const peer = persistentWebRtcPeer;
  persistentWebRtcPeer = undefined;
  await peer?.node.stop();
}

export const harness = {
  makeWebRtcPair,
  autoConnectWebRtcPair,
  autoConnectWebRtcReconnect,
  autoConnectWebRtcPeerRestart,
  autoConnectWebRtcPeerRestartWithRelayReplay,
  connectThroughStaleAdvertBacklog,
  duplicateWebRtcConnect,
  makeWebRtcChain,
  webRtcReconnect,
  memoryThreeNodes,
  reconnectMemoryPair,
  echoOverPair,
  echoOverChain,
  echoWithRustWebRtcPeer,
  concurrentIdentityStoreCreate,
  recentPeersStoreRoundTrip,
  startPersistentWebRtcPeer,
  connectPersistentWebRtcPeer,
  waitForPersistentWebRtcPeer,
  echoPersistentWebRtcPeer,
  persistentWebRtcPeerErrors,
  stopPersistentWebRtcPeer,
};
