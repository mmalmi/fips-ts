import {
  toHex,
  type Logger,
  type Transport,
  type TransportAddress,
  type TransportContext,
  noopLogger,
} from "@fips/core";

import { NostrRelayClient } from "./NostrRelayClient.js";
import {
  FIPS_ADVERT_D_TAG,
  NostrWebRtcSignaling,
} from "./NostrWebRtcSignaling.js";
import { WebRtcConnection } from "./WebRtcConnection.js";
import {
  validateWebRtcSignal,
  type WebRtcSignal,
} from "./WebRtcSignal.js";

export interface WebRtcTransportConfig {
  relays: string[];
  stunServers?: string[];
  advertiseOnNostr?: boolean;
  acceptConnections?: boolean;
  autoConnect?: boolean;
  discoveryApp?: string;
  advertTtlMs?: number;

  mtu?: number;
  maxConnections?: number;
  connectTimeoutMs?: number;
  iceGatherTimeoutMs?: number;

  dataChannelLabel?: string;
  ordered?: boolean;
  maxRetransmits?: number;

  webSocket?: typeof WebSocket;
  rtcPeerConnection?: typeof RTCPeerConnection;

  debug?: boolean;
  logger?: Logger;
}

interface PendingDial {
  sessionId: string;
  remotePubkeyHex: string;
  remoteXOnlyHex: string;
  pc: RTCPeerConnection;
  dataChannel: RTCDataChannel;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

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
      | "iceGatherTimeoutMs"
      | "dataChannelLabel"
      | "ordered"
      | "maxRetransmits"
    >
  > &
    WebRtcTransportConfig;
  private readonly logger: Logger;
  private readonly RTCPC: typeof RTCPeerConnection;
  private signaling?: NostrWebRtcSignaling;
  private relayClients: NostrRelayClient[] = [];
  private readonly conns = new Map<string, WebRtcConnection>(); // by pubkeyHex
  private readonly pendingDials = new Map<string, PendingDial>(); // by sessionId
  private readonly autoConnectPeers = new Set<string>(); // by pubkeyHex
  private readonly knownSessionIds = new Set<string>();
  private readonly seenSessionIds = new Set<string>();
  private advertCleanup?: () => void;

  constructor(config: WebRtcTransportConfig) {
    this.cfg = {
      advertiseOnNostr: false,
      acceptConnections: true,
      autoConnect: false,
      mtu: 1200,
      maxConnections: 32,
      connectTimeoutMs: 30_000,
      iceGatherTimeoutMs: 10_000,
      dataChannelLabel: "fips",
      ordered: false,
      maxRetransmits: 0,
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
    this.relayClients = this.cfg.relays.map(
      (u) => new NostrRelayClient({ url: u, webSocket: this.cfg.webSocket, logger: this.logger }),
    );
    this.signaling = new NostrWebRtcSignaling({
      identity: ctx.localIdentity,
      relays: this.relayClients,
      discoveryApp: this.cfg.discoveryApp,
      advertTtlMs: this.cfg.advertTtlMs,
      logger: this.logger,
      onSignal: (signal, senderXOnly) =>
        this.handleIncomingSignal(signal, senderXOnly).catch((err) => {
          this.logger.warn("handleIncomingSignal", err);
        }),
    });
    await this.signaling.start();

    if (this.cfg.autoConnect) {
      this.advertCleanup = await this.signaling.subscribeAdverts((_event, advert) => {
        this.handleAdvert(advert).catch((err) => {
          this.logger.warn("handleAdvert", err);
        });
      });
    }

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
    for (const r of this.relayClients) r.close();
    this.relayClients = [];
    for (const dial of this.pendingDials.values()) {
      clearTimeout(dial.timer);
      dial.reject(new Error("transport stopped"));
    }
    this.pendingDials.clear();
  }

  private async handleAdvert(advert: { endpoints: Array<{ transport: string; addr: string }> }): Promise<void> {
    const localPubkeyHex = this.ctx ? toHex(this.ctx.localIdentity.publicKey) : "";
    for (const endpoint of advert.endpoints) {
      if (endpoint.transport !== "webrtc" || endpoint.addr.length !== 66) continue;
      if (endpoint.addr === localPubkeyHex || this.conns.has(endpoint.addr)) continue;
      if (localPubkeyHex && localPubkeyHex > endpoint.addr) continue;
      if (this.autoConnectPeers.has(endpoint.addr)) continue;
      if (this.conns.size + this.pendingDials.size + this.autoConnectPeers.size >= this.cfg.maxConnections) {
        return;
      }

      this.autoConnectPeers.add(endpoint.addr);
      try {
        await this.connect({ transport: "webrtc", addr: endpoint.addr });
      } catch (err) {
        this.logger.warn("autoConnect failed", endpoint.addr, err);
      } finally {
        this.autoConnectPeers.delete(endpoint.addr);
      }
    }
  }

  async connect(addr: TransportAddress): Promise<void> {
    if (addr.transport !== "webrtc") throw new Error("wrong transport");
    if (addr.addr.length !== 66) {
      throw new Error("WebRTC addr must be 33-byte compressed pubkey hex");
    }
    const remotePubkeyHex = addr.addr;
    if (this.conns.has(remotePubkeyHex)) return;
    const remoteXOnlyHex = remotePubkeyHex.slice(2); // strip 02/03 parity
    const sessionId = randomId();
    this.knownSessionIds.add(sessionId);

    const pc = new this.RTCPC({
      iceServers: (this.cfg.stunServers ?? []).map((u) => ({ urls: u })),
    });
    const dataChannel = pc.createDataChannel(this.cfg.dataChannelLabel, {
      ordered: this.cfg.ordered,
      maxRetransmits: this.cfg.maxRetransmits,
    });

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDials.delete(sessionId);
        pc.close();
        reject(new Error("WebRTC connect timeout"));
      }, this.cfg.connectTimeoutMs);

      const dial: PendingDial = {
        sessionId,
        remotePubkeyHex,
        remoteXOnlyHex,
        pc,
        dataChannel,
        resolve,
        reject,
        timer,
      };
      this.pendingDials.set(sessionId, dial);

      this.startInitiatorHandshake(dial, addr).catch((err) => {
        clearTimeout(timer);
        this.pendingDials.delete(sessionId);
        pc.close();
        reject(err);
      });
    });
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
  ): Promise<void> {
    const offer = await dial.pc.createOffer();
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
    await this.signaling!.sendSignal(dial.remoteXOnlyHex, signal);
    // Wire connection state to dialer promise once data channel opens.
    const conn = new WebRtcConnection({
      remotePubkeyHex: dial.remotePubkeyHex,
      remoteAddr: addr,
      pc: dial.pc,
      dataChannel: dial.dataChannel,
      onPacket: (data) =>
        this.ctx!.onPacket({
          transportType: "webrtc",
          remoteAddr: addr,
          data,
          receivedAtMs: Date.now(),
        }),
      onState: (state) => {
        this.ctx!.onConnectionState?.({ remoteAddr: addr, state });
        if (state === "connected") {
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
    });
    this.conns.set(dial.remotePubkeyHex, conn);
  }

  private async handleIncomingSignal(
    signal: WebRtcSignal,
    senderXOnlyHex: string,
  ): Promise<void> {
    const localPubkeyHex = toHex(this.ctx!.localIdentity.publicKey);
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
      await this.signaling!.sendSignal(senderXOnlyHex, reply);
      // Now wait for the negotiated channel to arrive and wire it up.
      dcPromise.then((dataChannel) => {
        const conn = new WebRtcConnection({
          remotePubkeyHex: valid.sender,
          remoteAddr,
          pc,
          dataChannel,
          onPacket: (data) =>
            this.ctx!.onPacket({
              transportType: "webrtc",
              remoteAddr,
              data,
              receivedAtMs: Date.now(),
            }),
          onState: (state) => {
            this.ctx!.onConnectionState?.({ remoteAddr, state });
            if (state === "failed" || state === "disconnected") {
              this.conns.delete(valid.sender);
            }
          },
        });
        this.conns.set(valid.sender, conn);
      }).catch((err) => this.logger.warn("dcPromise", err));
      return;
    }
    if (valid.kind === "answer") {
      const dial = this.pendingDials.get(valid.sessionId);
      if (!dial) return;
      await dial.pc.setRemoteDescription({ type: "answer", sdp: valid.sdp! });
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
