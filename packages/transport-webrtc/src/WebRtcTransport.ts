import {
  fromHex,
  deriveNodeAddr,
  nodeAddrToHex,
  toHex,
  type DiscoveredPeer,
  type Logger,
  type NodeAddr,
  type Transport,
  type TransportAddress,
  type TransportContext,
  noopLogger,
} from "@fips/core";

import { NostrRelayClient } from "./NostrRelayClient.js";
import {
  DEFAULT_FIPS_ADVERT_TTL_MS,
  FIPS_ADVERT_D_TAG,
  NostrWebRtcSignaling,
} from "./NostrWebRtcSignaling.js";
import type { NostrEvent } from "./NostrRelayClient.js";
import { WebRtcConnection } from "./WebRtcConnection.js";
import {
  validateWebRtcSignal,
  type WebRtcSignal,
} from "./WebRtcSignal.js";

export interface WebRtcTransportConfig {
  relays: string[];
  relayClients?: NostrRelayClient[];
  stunServers?: string[];
  advertiseOnNostr?: boolean;
  acceptConnections?: boolean;
  autoConnect?: boolean;
  discoveryApp?: string;
  advertTtlMs?: number;

  mtu?: number;
  maxConnections?: number;
  connectTimeoutMs?: number;
  relayConnectTimeoutMs?: number;
  iceGatherTimeoutMs?: number;

  dataChannelLabel?: string;
  ordered?: boolean;
  maxRetransmits?: number | null;

  webSocket?: typeof WebSocket;
  rtcPeerConnection?: typeof RTCPeerConnection;

  debug?: boolean;
  logger?: Logger;
}

interface PendingDial {
  sessionId: string;
  remotePubkeyHex: string;
  remoteXOnlyHex: string;
  phase: string;
  pc: RTCPeerConnection;
  dataChannel: RTCDataChannel;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CachedAdvert {
  peer: DiscoveredPeer;
  createdAtSeconds: number;
  expiresAtMs: number;
}

interface WebRtcAdvert {
  endpoints: Array<{ transport: string; addr: string }>;
  signalRelays: string[];
}

interface AdvertWaiter {
  resolve: (peer: DiscoveredPeer | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const MAX_ADVERT_CACHE_ENTRIES = 256;
const ADVERT_RESOLUTION_TIMEOUT_MS = 5_000;

function randomId(): string {
  const a = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(a);
  } else {
    for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  }
  return toHex(a);
}

export class WebRtcTransport implements Transport {
  readonly type = "webrtc";
  readonly mtu: number;
  private ctx?: TransportContext;
  private readonly cfg: Required<
    Pick<
      WebRtcTransportConfig,
      | "advertiseOnNostr"
      | "acceptConnections"
      | "autoConnect"
      | "mtu"
      | "maxConnections"
      | "connectTimeoutMs"
      | "relayConnectTimeoutMs"
      | "iceGatherTimeoutMs"
      | "dataChannelLabel"
      | "ordered"
    >
  > &
    WebRtcTransportConfig;
  private readonly logger: Logger;
  private readonly RTCPC: typeof RTCPeerConnection;
  private signaling?: NostrWebRtcSignaling;
  private relayClients: NostrRelayClient[] = [];
  private ownsRelayClients = false;
  private readonly conns = new Map<string, WebRtcConnection>(); // by pubkeyHex
  private readonly pendingDials = new Map<string, PendingDial>(); // by sessionId
  private readonly pendingConnects = new Map<string, Promise<void>>(); // by pubkeyHex
  private readonly autoConnectPeers = new Set<string>(); // by pubkeyHex
  private readonly knownSessionIds = new Set<string>();
  private readonly seenSessionIds = new Set<string>();
  private readonly advertCache = new Map<string, CachedAdvert>(); // by NodeAddr hex
  private readonly peerSignalRelays = new Map<string, string[]>(); // by compressed pubkey hex
  private readonly advertWaiters = new Map<string, Set<AdvertWaiter>>(); // by NodeAddr hex
  private discoveryStream?: AsyncEventStream<DiscoveredPeer>;
  private advertCleanup?: () => void;

  constructor(config: WebRtcTransportConfig) {
    this.cfg = {
      advertiseOnNostr: false,
      acceptConnections: true,
      autoConnect: false,
      mtu: 1200,
      maxConnections: 32,
      connectTimeoutMs: 30_000,
      relayConnectTimeoutMs: 5_000,
      iceGatherTimeoutMs: 10_000,
      dataChannelLabel: "fips",
      ordered: true,
      ...config,
    };
    this.mtu = this.cfg.mtu;
    this.logger = config.logger ?? noopLogger;
    this.RTCPC =
      config.rtcPeerConnection ??
      ((globalThis as { RTCPeerConnection?: typeof RTCPeerConnection })
        .RTCPeerConnection as typeof RTCPeerConnection);
    if (!this.RTCPC) {
      throw new Error("RTCPeerConnection not available in this environment");
    }
  }

  async start(ctx: TransportContext): Promise<void> {
    this.ctx = ctx;
    this.discoveryStream = new AsyncEventStream<DiscoveredPeer>();
    const sharedRelayClients = this.cfg.relayClients;
    if (sharedRelayClients !== undefined) {
      const configuredUrls = this.cfg.relays.map((url) => new URL(url).toString());
      const sharedUrls = sharedRelayClients.map((client) => new URL(client.url).toString());
      if (
        sharedUrls.length === 0
        || sharedUrls.length !== configuredUrls.length
        || sharedUrls.some((url, index) => url !== configuredUrls[index])
      ) {
        throw new Error("shared relay clients must match configured relays in order");
      }
      this.relayClients = sharedRelayClients;
      this.ownsRelayClients = false;
    } else {
      this.relayClients = this.cfg.relays.map(
        (u) => new NostrRelayClient({
          url: u,
          webSocket: this.cfg.webSocket,
          connectTimeoutMs: this.cfg.relayConnectTimeoutMs,
          logger: this.logger,
        }),
      );
      this.ownsRelayClients = true;
    }
    this.signaling = new NostrWebRtcSignaling({
      identity: ctx.localIdentity,
      relays: this.relayClients,
      relayFactory: (url) => new NostrRelayClient({
        url,
        webSocket: this.cfg.webSocket,
        connectTimeoutMs: this.cfg.relayConnectTimeoutMs,
        logger: this.logger,
      }),
      discoveryApp: this.cfg.discoveryApp,
      advertTtlMs: this.cfg.advertTtlMs,
      logger: this.logger,
      onSignal: (signal, senderXOnly, sourceRelayUrl) =>
        this.handleIncomingSignal(signal, senderXOnly, sourceRelayUrl).catch((err) => {
          this.logger.warn("handleIncomingSignal", err);
        }),
    });
    await this.signaling.start();

    this.advertCleanup = await this.signaling.subscribeAdverts((event, advert) => {
      this.handleAdvert(event, advert).catch((err) => {
        this.logger.warn("handleAdvert", err);
      });
    });

    if (this.cfg.advertiseOnNostr) {
      await this.signaling.publishAdvert({
        identifier: FIPS_ADVERT_D_TAG,
        version: 1,
        endpoints: [{ transport: "webrtc", addr: toHex(ctx.localIdentity.publicKey) }],
        signalRelays: this.cfg.relays,
        stunServers: this.cfg.stunServers ?? [],
      });
    }
  }

  async stop(): Promise<void> {
    this.advertCleanup?.();
    this.advertCleanup = undefined;
    this.signaling?.stop();
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
    this.autoConnectPeers.clear();
    if (this.ownsRelayClients) {
      for (const r of this.relayClients) r.close();
    }
    this.relayClients = [];
    this.ownsRelayClients = false;
    for (const dial of this.pendingDials.values()) {
      clearTimeout(dial.timer);
      dial.reject(new Error("transport stopped"));
    }
    this.pendingDials.clear();
    this.pendingConnects.clear();
    this.knownSessionIds.clear();
    this.seenSessionIds.clear();
    this.advertCache.clear();
    this.peerSignalRelays.clear();
    for (const [nodeAddrHex, waiters] of this.advertWaiters) {
      for (const waiter of [...waiters]) {
        this.settleAdvertWaiter(nodeAddrHex, waiter, undefined);
      }
    }
    this.advertWaiters.clear();
    this.discoveryStream?.close();
    this.discoveryStream = undefined;
    this.signaling = undefined;
    this.ctx = undefined;
  }

  private async handleAdvert(
    event: NostrEvent,
    advert: WebRtcAdvert,
  ): Promise<void> {
    const signalRelays = normalizeSignalRelays(advert.signalRelays);
    if (signalRelays.length === 0) return;
    const localPubkeyHex = this.ctx ? toHex(this.ctx.localIdentity.publicKey) : "";
    for (const endpoint of advert.endpoints) {
      if (endpoint.transport !== "webrtc" || !/^(02|03)[0-9a-fA-F]{64}$/.test(endpoint.addr)) {
        continue;
      }
      const remotePubkeyHex = endpoint.addr.toLowerCase();
      if (remotePubkeyHex.slice(2) !== event.pubkey.toLowerCase()) continue;
      if (remotePubkeyHex === localPubkeyHex) continue;
      const peer: DiscoveredPeer = {
        remoteAddr: { transport: this.type, addr: remotePubkeyHex },
        publicKey: fromHex(remotePubkeyHex),
        meta: { source: "nostr-advert", signalRelays: [...signalRelays] },
      };
      const nodeAddrHex = nodeAddrToHex(deriveNodeAddr(peer.publicKey!));
      const cached = this.cacheAdvert(nodeAddrHex, peer, event);
      if (!cached) continue;
      this.peerSignalRelays.set(remotePubkeyHex, [...signalRelays]);
      const requested = this.resolveAdvertWaiters(nodeAddrHex, cached);
      if (!this.cfg.autoConnect || requested) continue;
      if (this.conns.has(remotePubkeyHex)) continue;
      if (this.autoConnectPeers.has(remotePubkeyHex)) continue;
      if (this.conns.size + this.pendingDials.size + this.autoConnectPeers.size >= this.cfg.maxConnections) {
        return;
      }

      const shouldDelay = localPubkeyHex.length === 66
        && localPubkeyHex.slice(2) > remotePubkeyHex.slice(2);
      this.autoConnectPeers.add(remotePubkeyHex);
      if (shouldDelay) {
        await new Promise((resolve) => {
          setTimeout(resolve, 1200);
        });
      }
      if (!this.ctx || this.conns.has(remotePubkeyHex)) {
        this.autoConnectPeers.delete(remotePubkeyHex);
        continue;
      }
      this.discoveryStream?.push(cloneDiscoveredPeer(cached));
    }
  }

  async resolve(nodeAddr: NodeAddr, signal?: AbortSignal): Promise<DiscoveredPeer | undefined> {
    const nodeAddrHex = nodeAddrToHex(nodeAddr);
    const cached = this.getCachedAdvert(nodeAddrHex);
    if (cached) {
      this.autoConnectPeers.delete(cached.remoteAddr.addr);
      return cached;
    }
    if (!this.ctx || signal?.aborted) return undefined;

    return new Promise<DiscoveredPeer | undefined>((resolve) => {
      const waiter: AdvertWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.settleAdvertWaiter(nodeAddrHex, waiter, undefined);
        }, ADVERT_RESOLUTION_TIMEOUT_MS),
        signal,
      };
      if (signal) {
        waiter.onAbort = () => this.settleAdvertWaiter(nodeAddrHex, waiter, undefined);
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      let waiters = this.advertWaiters.get(nodeAddrHex);
      if (!waiters) {
        waiters = new Set();
        this.advertWaiters.set(nodeAddrHex, waiters);
      }
      waiters.add(waiter);
    });
  }

  private cacheAdvert(
    nodeAddrHex: string,
    peer: DiscoveredPeer,
    event: NostrEvent,
  ): DiscoveredPeer | undefined {
    const nowMs = Date.now();
    this.pruneAdvertCache(nowMs);
    const expiresAtMs = advertExpiryMs(
      event,
      this.cfg.advertTtlMs ?? DEFAULT_FIPS_ADVERT_TTL_MS,
      nowMs,
    );
    if (expiresAtMs === undefined || expiresAtMs <= nowMs) return undefined;

    const existing = this.advertCache.get(nodeAddrHex);
    if (existing && existing.createdAtSeconds > event.created_at) {
      return cloneDiscoveredPeer(existing.peer);
    }
    if (existing) this.advertCache.delete(nodeAddrHex);
    while (this.advertCache.size >= MAX_ADVERT_CACHE_ENTRIES) {
      const oldest = this.advertCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.advertCache.delete(oldest);
    }
    this.advertCache.set(nodeAddrHex, {
      peer: cloneDiscoveredPeer(peer),
      createdAtSeconds: event.created_at,
      expiresAtMs,
    });
    return cloneDiscoveredPeer(peer);
  }

  private getCachedAdvert(nodeAddrHex: string): DiscoveredPeer | undefined {
    const cached = this.advertCache.get(nodeAddrHex);
    if (!cached) return undefined;
    if (cached.expiresAtMs <= Date.now()) {
      this.advertCache.delete(nodeAddrHex);
      return undefined;
    }
    this.advertCache.delete(nodeAddrHex);
    this.advertCache.set(nodeAddrHex, cached);
    return cloneDiscoveredPeer(cached.peer);
  }

  private pruneAdvertCache(nowMs: number): void {
    for (const [nodeAddrHex, cached] of this.advertCache) {
      if (cached.expiresAtMs <= nowMs) this.advertCache.delete(nodeAddrHex);
    }
  }

  private resolveAdvertWaiters(nodeAddrHex: string, peer: DiscoveredPeer): boolean {
    const waiters = this.advertWaiters.get(nodeAddrHex);
    if (!waiters || waiters.size === 0) return false;
    this.autoConnectPeers.delete(peer.remoteAddr.addr);
    for (const waiter of [...waiters]) {
      this.settleAdvertWaiter(nodeAddrHex, waiter, cloneDiscoveredPeer(peer));
    }
    return true;
  }

  private settleAdvertWaiter(
    nodeAddrHex: string,
    waiter: AdvertWaiter,
    peer: DiscoveredPeer | undefined,
  ): void {
    const waiters = this.advertWaiters.get(nodeAddrHex);
    if (!waiters?.delete(waiter)) return;
    if (waiters.size === 0) this.advertWaiters.delete(nodeAddrHex);
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    waiter.resolve(peer);
  }

  discover(): AsyncIterable<DiscoveredPeer> {
    return this.discoveryStream ?? emptyAsyncIterable();
  }

  async connect(addr: TransportAddress): Promise<void> {
    if (addr.transport !== "webrtc") throw new Error("wrong transport");
    if (addr.addr.length !== 66) {
      throw new Error("WebRTC addr must be 33-byte compressed pubkey hex");
    }
    const remotePubkeyHex = addr.addr;
    if (this.conns.has(remotePubkeyHex)) return;
    const pendingConnect = this.pendingConnects.get(remotePubkeyHex);
    if (pendingConnect) {
      await pendingConnect;
      return;
    }
    const remoteXOnlyHex = remotePubkeyHex.slice(2); // strip 02/03 parity
    const signalRelays = this.peerSignalRelays.get(remotePubkeyHex) ?? this.cfg.relays;
    const sessionId = randomId();
    this.knownSessionIds.add(sessionId);
    this.logger.debug("webrtc connect start", remotePubkeyHex, sessionId);

    const pc = new this.RTCPC({
      iceServers: (this.cfg.stunServers ?? []).map((u) => ({ urls: u })),
    });
    const dataChannelOptions: RTCDataChannelInit = {
      ordered: this.cfg.ordered,
    };
    if (this.cfg.maxRetransmits !== undefined && this.cfg.maxRetransmits !== null) {
      dataChannelOptions.maxRetransmits = this.cfg.maxRetransmits;
    }
    const dataChannel = pc.createDataChannel(this.cfg.dataChannelLabel, dataChannelOptions);

    const connectPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDials.delete(sessionId);
        const detail = [
          `phase=${dial.phase}`,
          `connection=${pc.connectionState}`,
          `ice=${pc.iceConnectionState}`,
          `signaling=${pc.signalingState}`,
          `local=${pc.localDescription ? "set" : "missing"}`,
          `remote=${pc.remoteDescription ? "set" : "missing"}`,
        ].join(",");
        pc.close();
        reject(new Error(`WebRTC connect timeout (${detail})`));
      }, this.cfg.connectTimeoutMs);

      const dial: PendingDial = {
        sessionId,
        remotePubkeyHex,
        remoteXOnlyHex,
        phase: "starting",
        pc,
        dataChannel,
        resolve,
        reject,
        timer,
      };
      this.pendingDials.set(sessionId, dial);

      this.startInitiatorHandshake(dial, addr, signalRelays).catch((err) => {
        clearTimeout(timer);
        this.pendingDials.delete(sessionId);
        pc.close();
        reject(err);
      });
    });
    this.pendingConnects.set(remotePubkeyHex, connectPromise);
    try {
      await connectPromise;
    } finally {
      if (this.pendingConnects.get(remotePubkeyHex) === connectPromise) {
        this.pendingConnects.delete(remotePubkeyHex);
      }
      if (!this.conns.has(remotePubkeyHex)) {
        this.autoConnectPeers.delete(remotePubkeyHex);
      }
    }
  }

  async send(addr: TransportAddress, packet: Uint8Array): Promise<void> {
    const conn = this.conns.get(addr.addr);
    if (!conn) throw new Error(`no webrtc connection to ${addr.addr}`);
    if (packet.length > this.mtu) {
      throw new Error(`packet ${packet.length} exceeds MTU ${this.mtu}`);
    }
    conn.send(packet);
  }

  async close(addr: TransportAddress): Promise<void> {
    const conn = this.conns.get(addr.addr);
    if (conn) {
      conn.close();
      this.conns.delete(addr.addr);
    }
  }

  private async startInitiatorHandshake(
    dial: PendingDial,
    addr: TransportAddress,
    signalRelays: string[],
  ): Promise<void> {
    dial.phase = "creating-offer";
    const offer = await dial.pc.createOffer();
    dial.phase = "gathering-ice";
    await dial.pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(dial.pc, this.cfg.iceGatherTimeoutMs);
    const localPubkeyHex = toHex(this.ctx!.localIdentity.publicKey);
    const signal: WebRtcSignal = {
      protocol: "fips-webrtc-v1",
      version: 1,
      sessionId: dial.sessionId,
      kind: "offer",
      sender: localPubkeyHex,
      recipient: dial.remotePubkeyHex,
      sdp: dial.pc.localDescription!.sdp,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };
    dial.phase = "publishing-offer";
    await this.signaling!.sendSignal(dial.remoteXOnlyHex, signal, signalRelays);
    dial.phase = "awaiting-answer";
    this.logger.debug("webrtc offer sent", dial.remotePubkeyHex, dial.sessionId);
    // Wire connection state to dialer promise once data channel opens.
    let conn: WebRtcConnection | null = null;
    conn = new WebRtcConnection({
      remotePubkeyHex: dial.remotePubkeyHex,
      remoteAddr: addr,
      pc: dial.pc,
      dataChannel: dial.dataChannel,
      onPacket: (data) => {
        this.ctx?.onPacket({
          transportType: "webrtc",
          remoteAddr: addr,
          data,
          receivedAtMs: Date.now(),
        });
      },
      onState: (state) => {
        this.ctx?.onConnectionState?.({ remoteAddr: addr, state });
        if (state === "connected") {
          if (conn) this.conns.set(dial.remotePubkeyHex, conn);
          if (this.pendingDials.delete(dial.sessionId)) {
            clearTimeout(dial.timer);
            dial.resolve();
          }
        } else if (state === "failed" || state === "disconnected") {
          this.conns.delete(dial.remotePubkeyHex);
          if (this.pendingDials.delete(dial.sessionId)) {
            clearTimeout(dial.timer);
            dial.reject(new Error(`webrtc state ${state}`));
          }
        }
      },
      logger: this.logger,
    });
  }

  private async handleIncomingSignal(
    signal: WebRtcSignal,
    senderXOnlyHex: string,
    sourceRelayUrl: string,
  ): Promise<void> {
    if (!this.ctx) return;
    this.logger.debug("webrtc signal received", signal.kind, signal.sessionId, signal.sender);
    const localPubkeyHex = toHex(this.ctx.localIdentity.publicKey);
    const valid = validateWebRtcSignal(signal, {
      localPubkeyHex,
      outerSenderPubkeyHex: signal.sender,
      knownSessionIds: this.knownSessionIds,
      seenSessionIds: this.seenSessionIds,
      nowMs: Date.now(),
    });
    // Pubkey continuity: inner.sender (33-byte) must match outer xOnly.
    if (valid.sender.slice(2) !== senderXOnlyHex) {
      this.logger.warn("inner sender does not match outer xOnly", valid.sender);
      return;
    }
    this.seenSessionIds.add(`${valid.sessionId}:${valid.kind}`);

    if (valid.kind === "offer") {
      if (!this.cfg.acceptConnections) return;
      const remoteAddr: TransportAddress = { transport: "webrtc", addr: valid.sender };
      const pc = new this.RTCPC({
        iceServers: (this.cfg.stunServers ?? []).map((u) => ({ urls: u })),
      });
      // Capture the incoming data channel via ondatachannel; wire it up
      // *after* publishing the answer, since the channel won't arrive until
      // the initiator receives the answer and the ICE handshake completes.
      const dcPromise = new Promise<RTCDataChannel>((resolve) => {
        pc.ondatachannel = (evt) => resolve(evt.channel);
      });
      await pc.setRemoteDescription({ type: "offer", sdp: valid.sdp! });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGatheringComplete(pc, this.cfg.iceGatherTimeoutMs);
      this.knownSessionIds.add(valid.sessionId);
      const reply: WebRtcSignal = {
        protocol: "fips-webrtc-v1",
        version: 1,
        sessionId: valid.sessionId,
        kind: "answer",
        sender: localPubkeyHex,
        recipient: valid.sender,
        sdp: pc.localDescription!.sdp,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      };
      await this.signaling!.sendSignal(senderXOnlyHex, reply, [sourceRelayUrl]);
      this.logger.debug("webrtc answer sent", valid.sender, valid.sessionId);
      // Now wait for the negotiated channel to arrive and wire it up.
      dcPromise.then((dataChannel) => {
        let conn: WebRtcConnection | null = null;
        conn = new WebRtcConnection({
          remotePubkeyHex: valid.sender,
          remoteAddr,
          pc,
          dataChannel,
          onPacket: (data) => {
            this.ctx?.onPacket({
              transportType: "webrtc",
              remoteAddr,
              data,
              receivedAtMs: Date.now(),
            });
          },
          onState: (state) => {
            this.ctx?.onConnectionState?.({ remoteAddr, state });
            if (state === "connected") {
              if (conn) this.conns.set(valid.sender, conn);
            }
            if (state === "failed" || state === "disconnected") {
              this.conns.delete(valid.sender);
            }
          },
          logger: this.logger,
        });
      }).catch((err) => this.logger.warn("dcPromise", err));
      return;
    }
    if (valid.kind === "answer") {
      const dial = this.pendingDials.get(valid.sessionId);
      if (!dial) return;
      dial.phase = "applying-answer";
      await dial.pc.setRemoteDescription({ type: "answer", sdp: valid.sdp! });
      dial.phase = "opening-data-channel";
      this.logger.debug("webrtc answer applied", valid.sender, valid.sessionId);
      return;
    }
    if (valid.kind === "reject") {
      const dial = this.pendingDials.get(valid.sessionId);
      if (dial) {
        clearTimeout(dial.timer);
        this.pendingDials.delete(valid.sessionId);
        dial.reject(new Error("peer rejected"));
      }
      return;
    }
    // "candidate" not used in non-trickle v1.
  }
}

function waitForIceGatheringComplete(
  pc: RTCPeerConnection,
  timeoutMs: number,
): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, timeoutMs);
    function onChange() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    }
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

class AsyncEventStream<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.values.length = 0;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

async function* emptyAsyncIterable<T>(): AsyncIterable<T> {
  return;
}

function normalizeSignalRelays(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const relays: string[] = [];
  for (const candidate of value.slice(0, 8)) {
    if (typeof candidate !== "string") continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") continue;
      const normalized = parsed.toString();
      if (!relays.includes(normalized)) relays.push(normalized);
    } catch {
      /* Invalid advertised relay URL. */
    }
  }
  return relays;
}

function cloneDiscoveredPeer(peer: DiscoveredPeer): DiscoveredPeer {
  return {
    remoteAddr: { ...peer.remoteAddr },
    publicKey: peer.publicKey ? new Uint8Array(peer.publicKey) : undefined,
    meta: peer.meta
      ? Object.fromEntries(Object.entries(peer.meta).map(([key, value]) => [
        key,
        Array.isArray(value) ? [...value] : value,
      ]))
      : undefined,
  };
}

function advertExpiryMs(event: NostrEvent, ttlMs: number, nowMs: number): number | undefined {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return undefined;
  const createdAtMs = event.created_at * 1_000;
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) return undefined;
  const localExpiryMs = Math.min(createdAtMs + ttlMs, nowMs + ttlMs);
  const expiration = event.tags.find((tag) => tag[0] === "expiration")?.[1];
  if (expiration === undefined) return localExpiryMs;
  if (!/^\d+$/.test(expiration)) return undefined;
  const advertisedExpiryMs = Number(expiration) * 1_000;
  if (!Number.isSafeInteger(advertisedExpiryMs)) return undefined;
  return Math.min(localExpiryMs, advertisedExpiryMs);
}
