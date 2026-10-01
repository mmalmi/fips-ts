import {
  FipsNode,
  identityFromSecretKey,
  nodeAddrToHex,
  deriveNodeAddr,
  fromHex,
  toHex,
  type FspSession,
  type LinkNegotiationMessage,
} from "@fips/core";
import { WebSocketTransport } from "../../../packages/transport-websocket/src/index.js";
import { WebRtcTransport } from "../../../packages/transport-webrtc/src/index.js";

interface SessionSnapshot {
  fsp: FspSession;
  currentKBit: boolean;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

// Match the existing browser harness's observation bound; no protocol timer is changed.
async function observed<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), 20_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Real browser RTC and real FMP/FSP; only one authenticated offer is held. */
export async function startLateCrossedOfferPeer(seedUrl: string, relayUrl: string, scalar: number) {
  const secret = new Uint8Array(32);
  secret[31] = scalar;
  const identity = await identityFromSecretKey(secret);
  const pcs: RTCPeerConnection[] = [];
  class ObservedPeerConnection extends RTCPeerConnection {
    constructor(config?: RTCConfiguration) { super(config); pcs.push(this); }
  }
  const rtc = new WebRtcTransport({
    relays: [relayUrl], advertiseOnNostr: true, acceptConnections: true,
    rtcPeerConnection: ObservedPeerConnection,
  });
  const websocket = new WebSocketTransport({ seedUrls: [seedUrl] });
  const node = new FipsNode({ identity, transports: [websocket, rtc] });
  const errors: string[] = [];
  const closedSessions: unknown[] = [];
  const seedConnected = deferred<void>();
  const seedDisconnected = deferred<void>();
  node.on("error", (event) => {
    const error = event as { err: unknown; where: string };
    errors.push(`${error.where}: ${String(error.err)}`);
  });
  node.on("session", (event) => {
    if ((event as { state: string }).state === "closed") closedSessions.push(event);
  });
  node.on("peer", (event) => {
    const peer = event as { state: string; remoteAddr: { transport: string } };
    if (peer.state === "connected" && peer.remoteAddr.transport === "websocket") {
      seedConnected.resolve();
    }
    if (peer.state === "disconnected" && peer.remoteAddr.transport === "websocket") {
      seedDisconnected.resolve();
    }
  });
  node.registerService(9000, async ({ payload, reply }) => reply(payload));

  const heldReady = deferred<void>();
  let holdOffer = false;
  let held: { key: string; message: LinkNegotiationMessage } | undefined;
  let losingDial: Promise<string> | undefined;
  const deliver = rtc.handleLinkNegotiation.bind(rtc);
  rtc.handleLinkNegotiation = async (key, message) => {
    if (holdOffer && !held && message.kind === "offer") {
      held = { key, message: structuredClone(message) };
      heldReady.resolve();
      return;
    }
    await deliver(key, message);
  };
  let baseline: { session: SessionSnapshot; pc: RTCPeerConnection; kBit: boolean; counter: bigint } | undefined;
  const getSession = (remote: string): SessionSnapshot | undefined => {
    const manager = Reflect.get(node, "sessionManager");
    return Reflect.get(manager, "sessions").get(nodeAddrToHex(deriveNodeAddr(fromHex(remote))));
  };
  const counter = (session: SessionSnapshot): bigint => Reflect.get(session.fsp, "txCounter");
  const currentPc = (): RTCPeerConnection | undefined => {
    const connections = [...Reflect.get(rtc, "conns").values()] as { pc: RTCPeerConnection }[];
    if (connections.length !== 1) throw new Error(`expected one RTC carrier, got ${connections.length}`);
    return connections[0]?.pc;
  };
  const peers = () => [...Reflect.get(node, "peers").values()] as {
    remoteAddr: { transport: string }; link: { state: string };
  }[];
  try {
    await node.start();
  } catch (error) {
    await node.stop();
    throw error;
  }

  return {
    publicKey: toHex(identity.publicKey),
    async waitForSeed() { await observed(seedConnected.promise, "seed FMP establishment"); },
    holdNextOffer() { holdOffer = true; },
    async waitForHeldOffer() {
      await observed(heldReady.promise, "authenticated crossed offer");
      return { key: held!.key, negotiationId: held!.message.negotiationId, kind: held!.message.kind };
    },
    beginLosingDial(remote: string) {
      losingDial = rtc.connect({ transport: "webrtc", addr: remote })
        .then(() => "connected", (error: Error) => error.message);
    },
    async losingDialOutcome() {
      if (!losingDial) throw new Error("losing dial was not started");
      return { result: await observed(losingDial, "crossed dial cancellation"), firstPcState: pcs[0]?.connectionState };
    },
    async connect(remote: string) { await node.connect({ transport: "webrtc", addr: remote }); },
    async waitForSeedDisconnect() { await observed(seedDisconnected.promise, "seed disconnection"); },
    async echo(remote: string, payload: string) {
      const reply = deferred<string>();
      const off = node.on("datagram", (event) => {
        const datagram = event as { src: string; srcPort: number; dstPort: number; payload: Uint8Array };
        const text = new TextDecoder().decode(datagram.payload);
        if (datagram.src === remote && datagram.srcPort === 9000 && datagram.dstPort === 9001 && text === payload) {
          reply.resolve(text);
        }
      });
      try {
        return await observed((async () => {
          // The response port is unregistered, so an echo cannot trigger another echo.
          await node.sendDatagram({ dst: remote, srcPort: 9001, dstPort: 9000, payload: new TextEncoder().encode(payload) });
          return await reply.promise;
        })(), "RTC echo");
      } finally { off(); }
    },
    capture(remote: string) {
      const session = getSession(remote);
      const pc = currentPc();
      if (!session || session.fsp.state !== "established" || !pc || pc.connectionState !== "connected") {
        throw new Error("RTC/FSP baseline is not established");
      }
      baseline = { session, pc, kBit: session.currentKBit, counter: counter(session) };
      return peers().map((peer) => [peer.remoteAddr.transport, peer.link.state]);
    },
    async releaseHeldOffer() {
      if (!held) throw new Error("no authenticated offer is held");
      const exact = held;
      holdOffer = false;
      held = undefined;
      await deliver(exact.key, exact.message);
      return exact.message.negotiationId;
    },
    status(remote: string) {
      if (!baseline) throw new Error("baseline was not captured");
      const session = getSession(remote);
      return {
        sameSession: session === baseline.session,
        established: session?.fsp.state === "established",
        sameKBit: session?.currentKBit === baseline.kBit,
        counterAdvanced: session ? counter(session) > baseline.counter : false,
        sameCarrier: currentPc() === baseline.pc,
        originalPcState: baseline.pc.connectionState,
        peers: peers().map((peer) => [peer.remoteAddr.transport, peer.link.state]),
        errors: [...errors], closedSessions: closedSessions.length,
      };
    },
    async stop() {
      rtc.handleLinkNegotiation = deliver;
      await node.stop();
      await losingDial;
      return pcs.every((pc) => pc.connectionState === "closed");
    },
  };
}

export type LateCrossedOfferPeer = Awaited<ReturnType<typeof startLateCrossedOfferPeer>>;
