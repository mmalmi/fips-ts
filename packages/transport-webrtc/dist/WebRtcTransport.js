import { fromHex, deriveNodeAddr, nodeAddrToHex, toHex, noopLogger, } from "@fips/core";
import { NostrRelayClient } from "./NostrRelayClient.js";
import { WebRtcAutoConnectPolicy } from "./WebRtcAutoConnectPolicy.js";
import { DEFAULT_FIPS_ADVERT_TTL_MS, FIPS_ADVERT_D_TAG, NostrWebRtcSignaling, } from "./NostrWebRtcSignaling.js";
import { WebRtcConnection } from "./WebRtcConnection.js";
import { AsyncEventStream, advertExpiryMs, cloneDiscoveredPeer, emptyAsyncIterable, normalizeSignalRelays, waitForIceGatheringComplete, } from "./WebRtcTransportSupport.js";
import { validateWebRtcSignal, } from "./WebRtcSignal.js";
const MAX_ADVERT_CACHE_ENTRIES = 256;
const ADVERT_RESOLUTION_TIMEOUT_MS = 5_000;
const AUTO_RECONNECT_DELAY_MS = 500;
const AUTO_CONNECT_FAILURE_COOLDOWN_MS = 30_000;
const AUTO_CONNECT_SETTLE_MS = 750;
function randomId() {
    const a = new Uint8Array(16);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        crypto.getRandomValues(a);
    }
    else {
        for (let i = 0; i < a.length; i++)
            a[i] = Math.floor(Math.random() * 256);
    }
    return toHex(a);
}
export class WebRtcTransport {
    type = "webrtc";
    mtu;
    ctx;
    cfg;
    logger;
    RTCPC;
    signaling;
    relayClients = [];
    ownsRelayClients = false;
    conns = new Map(); // by pubkeyHex
    pendingDials = new Map(); // by sessionId
    pendingInbound = new Map(); // by sessionId
    pendingConnects = new Map(); // by pubkeyHex
    autoConnectPeers = new Set(); // by pubkeyHex
    pendingAutoConnects = new Set(); // by pubkeyHex
    knownSessionIds = new Set();
    seenSessionIds = new Set();
    advertCache = new Map(); // by NodeAddr hex
    peerSignalRelays = new Map(); // by compressed pubkey hex
    peersWithTraffic = new Set();
    advertWaiters = new Map(); // by NodeAddr hex
    autoReconnectTimers = new Map();
    autoConnectCooldowns = new Map();
    autoConnectAttempts = new Map();
    autoConnectPolicy;
    autoConnectAttemptSequence = 0;
    autoConnectFillTimer;
    discoveryStream;
    advertCleanup;
    advertRefreshTimer;
    stopping = true;
    constructor(config) {
        const maxConnections = config.maxConnections ?? 32;
        this.cfg = {
            advertiseOnNostr: false,
            acceptConnections: true,
            autoConnect: false,
            mtu: 1200,
            maxConnections,
            maxAutoConnections: Math.min(maxConnections, Math.max(0, config.maxAutoConnections ?? maxConnections)),
            connectTimeoutMs: 30_000,
            relayConnectTimeoutMs: 5_000,
            iceGatherTimeoutMs: 10_000,
            dataChannelLabel: "fips",
            ordered: true,
            ...config,
        };
        this.autoConnectPolicy = new WebRtcAutoConnectPolicy(config.relays, config.preferredAutoConnectPeers ?? []);
        this.mtu = this.cfg.mtu;
        this.logger = config.logger ?? noopLogger;
        this.RTCPC =
            config.rtcPeerConnection ??
                globalThis
                    .RTCPeerConnection;
        if (!this.RTCPC) {
            throw new Error("RTCPeerConnection not available in this environment");
        }
    }
    async start(ctx) {
        this.stopping = false;
        this.ctx = ctx;
        this.discoveryStream = new AsyncEventStream();
        const sharedRelayClients = this.cfg.relayClients;
        if (sharedRelayClients !== undefined) {
            const configuredUrls = this.cfg.relays.map((url) => new URL(url).toString());
            const sharedUrls = sharedRelayClients.map((client) => new URL(client.url).toString());
            if (sharedUrls.length === 0
                || sharedUrls.length !== configuredUrls.length
                || sharedUrls.some((url, index) => url !== configuredUrls[index])) {
                throw new Error("shared relay clients must match configured relays in order");
            }
            this.relayClients = sharedRelayClients;
            this.ownsRelayClients = false;
        }
        else {
            this.relayClients = this.cfg.relays.map((u) => new NostrRelayClient({
                url: u,
                webSocket: this.cfg.webSocket,
                connectTimeoutMs: this.cfg.relayConnectTimeoutMs,
                logger: this.logger,
            }));
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
            onSignal: (signal, senderXOnly, sourceRelayUrl) => this.handleIncomingSignal(signal, senderXOnly, sourceRelayUrl).catch((err) => {
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
            await this.publishLocalAdvert();
            const refreshMs = Math.max(1_000, Math.floor((this.cfg.advertTtlMs ?? DEFAULT_FIPS_ADVERT_TTL_MS) / 2));
            this.advertRefreshTimer = setInterval(() => {
                if (this.stopping)
                    return;
                void this.publishLocalAdvert().catch((err) => {
                    this.logger.warn("advert refresh failed", err);
                });
            }, refreshMs);
        }
    }
    async stop() {
        this.stopping = true;
        if (this.advertRefreshTimer)
            clearInterval(this.advertRefreshTimer);
        this.advertRefreshTimer = undefined;
        for (const timer of this.autoReconnectTimers.values())
            clearTimeout(timer);
        this.autoReconnectTimers.clear();
        this.autoConnectCooldowns.clear();
        this.autoConnectAttempts.clear();
        this.autoConnectAttemptSequence = 0;
        if (this.autoConnectFillTimer)
            clearTimeout(this.autoConnectFillTimer);
        this.autoConnectFillTimer = undefined;
        this.advertCleanup?.();
        this.advertCleanup = undefined;
        this.signaling?.stop();
        for (const c of this.conns.values())
            c.close();
        this.conns.clear();
        this.autoConnectPeers.clear();
        this.pendingAutoConnects.clear();
        if (this.ownsRelayClients) {
            for (const r of this.relayClients)
                r.close();
        }
        this.relayClients = [];
        this.ownsRelayClients = false;
        for (const dial of this.pendingDials.values()) {
            clearTimeout(dial.timer);
            dial.reject(new Error("transport stopped"));
        }
        this.pendingDials.clear();
        for (const timer of this.pendingInbound.values())
            clearTimeout(timer);
        this.pendingInbound.clear();
        this.pendingConnects.clear();
        this.knownSessionIds.clear();
        this.seenSessionIds.clear();
        this.advertCache.clear();
        this.peerSignalRelays.clear();
        this.peersWithTraffic.clear();
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
    async handleAdvert(event, advert) {
        const signalRelays = normalizeSignalRelays(advert.signalRelays);
        if (signalRelays.length === 0)
            return;
        const localPubkeyHex = this.ctx ? toHex(this.ctx.localIdentity.publicKey) : "";
        for (const endpoint of advert.endpoints) {
            if (endpoint.transport !== "webrtc" || !/^(02|03)[0-9a-fA-F]{64}$/.test(endpoint.addr)) {
                continue;
            }
            const remotePubkeyHex = endpoint.addr.toLowerCase();
            if (remotePubkeyHex.slice(2) !== event.pubkey.toLowerCase())
                continue;
            if (remotePubkeyHex === localPubkeyHex)
                continue;
            const peer = {
                remoteAddr: { transport: this.type, addr: remotePubkeyHex },
                publicKey: fromHex(remotePubkeyHex),
                meta: { source: "nostr-advert", signalRelays: [...signalRelays] },
            };
            const nodeAddrHex = nodeAddrToHex(deriveNodeAddr(peer.publicKey));
            const cached = this.cacheAdvert(nodeAddrHex, peer, event);
            if (!cached)
                continue;
            this.peerSignalRelays.set(remotePubkeyHex, [...signalRelays]);
            const requested = this.resolveAdvertWaiters(nodeAddrHex, cached);
            if (this.cfg.autoConnect && !requested && !this.autoConnectFillTimer) {
                this.autoConnectFillTimer = setTimeout(() => {
                    this.autoConnectFillTimer = undefined;
                    this.fillAutoConnectSlots(localPubkeyHex);
                }, AUTO_CONNECT_SETTLE_MS);
            }
        }
    }
    fillAutoConnectSlots(localPubkeyHex = this.ctx ? toHex(this.ctx.localIdentity.publicKey) : "") {
        if (!this.cfg.autoConnect || this.stopping || !this.ctx)
            return;
        const now = Date.now();
        this.pruneAdvertCache(now);
        for (const [remote, until] of this.autoConnectCooldowns) {
            if (until <= now)
                this.autoConnectCooldowns.delete(remote);
        }
        const candidates = this.autoConnectPolicy.sort([...this.advertCache.values()], this.autoConnectAttempts);
        const reservePreferredSlot = this.autoConnectPolicy.shouldReserveSlot(candidates.map((cached) => cached.peer.remoteAddr.addr), this.conns.keys(), this.pendingConnects.keys(), this.autoConnectPeers);
        for (const cached of candidates) {
            const remote = cached.peer.remoteAddr.addr;
            const autoConnectLimit = this.autoConnectPolicy.connectionLimit(this.cfg.maxAutoConnections, reservePreferredSlot, remote);
            if (this.autoConnectCapacityUsed() >= autoConnectLimit)
                continue;
            if (this.speculativeAutoConnects() >= this.maxSpeculativeAutoConnects())
                return;
            if (this.conns.has(remote) || this.pendingConnects.has(remote) || this.autoConnectPeers.has(remote))
                continue;
            if ((this.autoConnectCooldowns.get(remote) ?? 0) > now)
                continue;
            this.autoConnectAttempts.set(remote, ++this.autoConnectAttemptSequence);
            this.autoConnectPeers.add(remote);
            const push = () => {
                if (this.stopping || !this.ctx || this.conns.has(remote)) {
                    this.autoConnectPeers.delete(remote);
                    return;
                }
                this.logger.debug("webrtc auto-connect queued", remote);
                this.discoveryStream?.push(cloneDiscoveredPeer(cached.peer));
            };
            if (localPubkeyHex.slice(2) > remote.slice(2))
                setTimeout(push, 1_200);
            else
                push();
        }
    }
    async publishLocalAdvert() {
        if (!this.ctx || !this.signaling)
            return;
        await this.signaling.publishAdvert({
            identifier: FIPS_ADVERT_D_TAG,
            version: 1,
            endpoints: [{ transport: "webrtc", addr: toHex(this.ctx.localIdentity.publicKey) }],
            signalRelays: this.cfg.relays,
            stunServers: this.cfg.stunServers ?? [],
        });
    }
    async resolve(nodeAddr, signal) {
        const nodeAddrHex = nodeAddrToHex(nodeAddr);
        const cached = this.getCachedAdvert(nodeAddrHex);
        // Resolution may race the discovery consumer. Keep any queued reservation
        // until connect() atomically transfers it to pendingAutoConnects.
        if (cached)
            return cached;
        if (!this.ctx || signal?.aborted)
            return undefined;
        return new Promise((resolve) => {
            const waiter = {
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
    cacheAdvert(nodeAddrHex, peer, event) {
        const nowMs = Date.now();
        this.pruneAdvertCache(nowMs);
        const expiresAtMs = advertExpiryMs(event, this.cfg.advertTtlMs ?? DEFAULT_FIPS_ADVERT_TTL_MS, nowMs);
        if (expiresAtMs === undefined || expiresAtMs <= nowMs)
            return undefined;
        const existing = this.advertCache.get(nodeAddrHex);
        if (existing && existing.createdAtSeconds > event.created_at) {
            return cloneDiscoveredPeer(existing.peer);
        }
        if (existing)
            this.advertCache.delete(nodeAddrHex);
        while (this.advertCache.size >= MAX_ADVERT_CACHE_ENTRIES) {
            const oldest = this.advertCache.keys().next().value;
            if (oldest === undefined)
                break;
            const evicted = this.advertCache.get(oldest);
            this.advertCache.delete(oldest);
            if (evicted)
                this.autoConnectAttempts.delete(evicted.peer.remoteAddr.addr);
        }
        this.advertCache.set(nodeAddrHex, {
            peer: cloneDiscoveredPeer(peer),
            createdAtSeconds: event.created_at,
            expiresAtMs,
        });
        return cloneDiscoveredPeer(peer);
    }
    getCachedAdvert(nodeAddrHex) {
        const cached = this.advertCache.get(nodeAddrHex);
        if (!cached)
            return undefined;
        if (cached.expiresAtMs <= Date.now()) {
            this.advertCache.delete(nodeAddrHex);
            this.autoConnectAttempts.delete(cached.peer.remoteAddr.addr);
            return undefined;
        }
        this.advertCache.delete(nodeAddrHex);
        this.advertCache.set(nodeAddrHex, cached);
        return cloneDiscoveredPeer(cached.peer);
    }
    pruneAdvertCache(nowMs) {
        for (const [nodeAddrHex, cached] of this.advertCache) {
            if (cached.expiresAtMs <= nowMs) {
                this.advertCache.delete(nodeAddrHex);
                this.autoConnectAttempts.delete(cached.peer.remoteAddr.addr);
            }
        }
    }
    resolveAdvertWaiters(nodeAddrHex, peer) {
        const waiters = this.advertWaiters.get(nodeAddrHex);
        if (!waiters || waiters.size === 0)
            return false;
        for (const waiter of [...waiters]) {
            this.settleAdvertWaiter(nodeAddrHex, waiter, cloneDiscoveredPeer(peer));
        }
        return true;
    }
    settleAdvertWaiter(nodeAddrHex, waiter, peer) {
        const waiters = this.advertWaiters.get(nodeAddrHex);
        if (!waiters?.delete(waiter))
            return;
        if (waiters.size === 0)
            this.advertWaiters.delete(nodeAddrHex);
        clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        waiter.resolve(peer);
    }
    discover() {
        return this.discoveryStream ?? emptyAsyncIterable();
    }
    async connect(addr) {
        if (addr.transport !== "webrtc")
            throw new Error("wrong transport");
        if (addr.addr.length !== 66) {
            throw new Error("WebRTC addr must be 33-byte compressed pubkey hex");
        }
        const remotePubkeyHex = addr.addr;
        // Discovery reservations only cover the queued handoff to FipsNode.
        // Once connect() starts, the concrete pending/connected maps own capacity.
        const isAutoConnect = this.autoConnectPeers.delete(remotePubkeyHex);
        if (this.conns.has(remotePubkeyHex))
            return;
        const pendingConnect = this.pendingConnects.get(remotePubkeyHex);
        if (pendingConnect) {
            await pendingConnect;
            return;
        }
        if (isAutoConnect)
            this.pendingAutoConnects.add(remotePubkeyHex);
        const remoteXOnlyHex = remotePubkeyHex.slice(2); // strip 02/03 parity
        const signalRelays = this.peerSignalRelays.get(remotePubkeyHex) ?? this.cfg.relays;
        const sessionId = randomId();
        this.knownSessionIds.add(sessionId);
        this.logger.debug("webrtc connect start", remotePubkeyHex, sessionId);
        const pc = new this.RTCPC({
            iceServers: (this.cfg.stunServers ?? []).map((u) => ({ urls: u })),
        });
        const dataChannelOptions = {
            ordered: this.cfg.ordered,
        };
        if (this.cfg.maxRetransmits !== undefined && this.cfg.maxRetransmits !== null) {
            dataChannelOptions.maxRetransmits = this.cfg.maxRetransmits;
        }
        const dataChannel = pc.createDataChannel(this.cfg.dataChannelLabel, dataChannelOptions);
        const connectPromise = new Promise((resolve, reject) => {
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
            const dial = {
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
        }
        catch (error) {
            this.handleAutoConnectFailure(remotePubkeyHex);
            throw error;
        }
        finally {
            if (this.pendingConnects.get(remotePubkeyHex) === connectPromise) {
                this.pendingConnects.delete(remotePubkeyHex);
            }
            if (!this.conns.has(remotePubkeyHex)) {
                this.autoConnectPeers.delete(remotePubkeyHex);
            }
            if (isAutoConnect) {
                this.pendingAutoConnects.delete(remotePubkeyHex);
                this.fillAutoConnectSlots();
            }
        }
    }
    async send(addr, packet) {
        const conn = this.conns.get(addr.addr);
        if (!conn)
            throw new Error(`no webrtc connection to ${addr.addr}`);
        if (packet.length > this.mtu) {
            throw new Error(`packet ${packet.length} exceeds MTU ${this.mtu}`);
        }
        conn.send(packet);
    }
    async close(addr) {
        const provenPeer = this.peersWithTraffic.delete(addr.addr);
        const conn = this.conns.get(addr.addr);
        if (conn) {
            conn.close();
            this.conns.delete(addr.addr);
        }
        if (provenPeer || this.autoReconnectTimers.has(addr.addr)) {
            this.scheduleAutoReconnect(addr.addr);
            return;
        }
        this.handleAutoConnectFailure(addr.addr);
    }
    async startInitiatorHandshake(dial, addr, signalRelays) {
        dial.phase = "creating-offer";
        const offer = await dial.pc.createOffer();
        dial.phase = "gathering-ice";
        await dial.pc.setLocalDescription(offer);
        await waitForIceGatheringComplete(dial.pc, this.cfg.iceGatherTimeoutMs);
        const localPubkeyHex = toHex(this.ctx.localIdentity.publicKey);
        const signal = {
            protocol: "fips-webrtc-v1",
            version: 1,
            sessionId: dial.sessionId,
            kind: "offer",
            sender: localPubkeyHex,
            recipient: dial.remotePubkeyHex,
            sdp: dial.pc.localDescription.sdp,
            createdAtMs: Date.now(),
            expiresAtMs: Date.now() + 60_000,
        };
        dial.phase = "publishing-offer";
        await this.signaling.sendSignal(dial.remoteXOnlyHex, signal, signalRelays);
        dial.phase = "awaiting-answer";
        this.logger.debug("webrtc offer sent", dial.remotePubkeyHex, dial.sessionId);
        // Wire connection state to dialer promise once data channel opens.
        let conn = null;
        conn = new WebRtcConnection({
            remotePubkeyHex: dial.remotePubkeyHex,
            remoteAddr: addr,
            pc: dial.pc,
            dataChannel: dial.dataChannel,
            onPacket: (data) => {
                this.peersWithTraffic.add(dial.remotePubkeyHex);
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
                    if (conn)
                        this.conns.set(dial.remotePubkeyHex, conn);
                    if (this.pendingDials.delete(dial.sessionId)) {
                        clearTimeout(dial.timer);
                        dial.resolve();
                    }
                }
                else if (state === "failed" || state === "disconnected") {
                    this.conns.delete(dial.remotePubkeyHex);
                    this.scheduleAutoReconnect(dial.remotePubkeyHex);
                    if (this.pendingDials.delete(dial.sessionId)) {
                        clearTimeout(dial.timer);
                        dial.reject(new Error(`webrtc state ${state}`));
                    }
                }
            },
            logger: this.logger,
        });
    }
    async handleIncomingSignal(signal, senderXOnlyHex, sourceRelayUrl) {
        if (!this.ctx)
            return;
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
            if (!this.cfg.acceptConnections)
                return;
            if (this.pendingInbound.has(valid.sessionId))
                return;
            if (this.conns.size + this.pendingDials.size + this.pendingInbound.size
                >= this.cfg.maxConnections) {
                this.logger.warn("inbound WebRTC offer rejected at connection limit", valid.sender);
                return;
            }
            const remoteAddr = { transport: "webrtc", addr: valid.sender };
            const pc = new this.RTCPC({
                iceServers: (this.cfg.stunServers ?? []).map((u) => ({ urls: u })),
            });
            this.pendingInbound.set(valid.sessionId, setTimeout(() => {
                this.pendingInbound.delete(valid.sessionId);
                pc.close();
            }, this.cfg.connectTimeoutMs));
            // Capture the incoming data channel via ondatachannel; wire it up
            // *after* publishing the answer, since the channel won't arrive until
            // the initiator receives the answer and the ICE handshake completes.
            const dcPromise = new Promise((resolve) => {
                pc.ondatachannel = (evt) => resolve(evt.channel);
            });
            try {
                await pc.setRemoteDescription({ type: "offer", sdp: valid.sdp });
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                await waitForIceGatheringComplete(pc, this.cfg.iceGatherTimeoutMs);
                this.knownSessionIds.add(valid.sessionId);
                const reply = {
                    protocol: "fips-webrtc-v1",
                    version: 1,
                    sessionId: valid.sessionId,
                    kind: "answer",
                    sender: localPubkeyHex,
                    recipient: valid.sender,
                    sdp: pc.localDescription.sdp,
                    createdAtMs: Date.now(),
                    expiresAtMs: Date.now() + 60_000,
                };
                await this.signaling.sendSignal(senderXOnlyHex, reply, [sourceRelayUrl]);
                this.logger.debug("webrtc answer sent", valid.sender, valid.sessionId);
            }
            catch (err) {
                this.clearPendingInbound(valid.sessionId);
                pc.close();
                throw err;
            }
            // Now wait for the negotiated channel to arrive and wire it up.
            dcPromise.then((dataChannel) => {
                this.clearPendingInbound(valid.sessionId);
                let conn = null;
                conn = new WebRtcConnection({
                    remotePubkeyHex: valid.sender,
                    remoteAddr,
                    pc,
                    dataChannel,
                    onPacket: (data) => {
                        this.peersWithTraffic.add(valid.sender);
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
                            if (conn)
                                this.conns.set(valid.sender, conn);
                        }
                        if (state === "failed" || state === "disconnected") {
                            this.conns.delete(valid.sender);
                            this.scheduleAutoReconnect(valid.sender);
                        }
                    },
                    logger: this.logger,
                });
            }).catch((err) => {
                this.clearPendingInbound(valid.sessionId);
                this.logger.warn("dcPromise", err);
            });
            return;
        }
        if (valid.kind === "answer") {
            const dial = this.pendingDials.get(valid.sessionId);
            if (!dial)
                return;
            dial.phase = "applying-answer";
            await dial.pc.setRemoteDescription({ type: "answer", sdp: valid.sdp });
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
    scheduleAutoReconnect(remotePubkeyHex) {
        this.autoConnectPeers.delete(remotePubkeyHex);
        if (!this.cfg.autoConnect || this.stopping || !this.ctx) {
            this.logger.debug("webrtc auto-reconnect disabled", remotePubkeyHex);
            return;
        }
        if (this.autoReconnectTimers.has(remotePubkeyHex))
            return;
        const delay = Math.max(AUTO_RECONNECT_DELAY_MS, (this.autoConnectCooldowns.get(remotePubkeyHex) ?? 0) - Date.now());
        this.logger.debug("webrtc auto-reconnect scheduled", remotePubkeyHex, delay);
        const timer = setTimeout(() => {
            this.autoReconnectTimers.delete(remotePubkeyHex);
            if (this.stopping || !this.ctx || this.conns.has(remotePubkeyHex)) {
                this.logger.debug("webrtc auto-reconnect no longer needed", remotePubkeyHex);
                return;
            }
            this.logger.debug("webrtc auto-reconnect retrying", remotePubkeyHex);
            this.fillAutoConnectSlots();
        }, delay);
        this.autoReconnectTimers.set(remotePubkeyHex, timer);
    }
    handleAutoConnectFailure(remotePubkeyHex) {
        if (!this.cfg.autoConnect || this.stopping)
            return;
        this.autoConnectPeers.delete(remotePubkeyHex);
        this.autoConnectCooldowns.set(remotePubkeyHex, Date.now() + AUTO_CONNECT_FAILURE_COOLDOWN_MS);
        this.scheduleAutoReconnect(remotePubkeyHex);
        this.fillAutoConnectSlots();
    }
    clearPendingInbound(sessionId) {
        const timer = this.pendingInbound.get(sessionId);
        if (timer)
            clearTimeout(timer);
        this.pendingInbound.delete(sessionId);
    }
    speculativeAutoConnects() {
        return this.autoConnectPeers.size + this.pendingAutoConnects.size;
    }
    autoConnectCapacityUsed() {
        return this.conns.size
            + this.pendingDials.size
            + this.pendingInbound.size
            + this.autoConnectPeers.size;
    }
    maxSpeculativeAutoConnects() {
        return Math.max(1, Math.floor(this.cfg.maxConnections / 2));
    }
}
//# sourceMappingURL=WebRtcTransport.js.map