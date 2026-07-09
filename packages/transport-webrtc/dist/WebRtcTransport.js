import { fromHex, toHex, noopLogger, } from "@fips/core";
import { NostrRelayClient } from "./NostrRelayClient.js";
import { FIPS_ADVERT_D_TAG, NostrWebRtcSignaling, } from "./NostrWebRtcSignaling.js";
import { WebRtcConnection } from "./WebRtcConnection.js";
import { validateWebRtcSignal, } from "./WebRtcSignal.js";
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
    pendingConnects = new Map(); // by pubkeyHex
    autoConnectPeers = new Set(); // by pubkeyHex
    knownSessionIds = new Set();
    seenSessionIds = new Set();
    discoveryStream;
    advertCleanup;
    constructor(config) {
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
                globalThis
                    .RTCPeerConnection;
        if (!this.RTCPC) {
            throw new Error("RTCPeerConnection not available in this environment");
        }
    }
    async start(ctx) {
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
            discoveryApp: this.cfg.discoveryApp,
            advertTtlMs: this.cfg.advertTtlMs,
            logger: this.logger,
            onSignal: (signal, senderXOnly) => this.handleIncomingSignal(signal, senderXOnly).catch((err) => {
                this.logger.warn("handleIncomingSignal", err);
            }),
        });
        await this.signaling.start();
        if (this.cfg.autoConnect) {
            this.advertCleanup = await this.signaling.subscribeAdverts((event, advert) => {
                this.handleAdvert(event.pubkey, advert).catch((err) => {
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
    async stop() {
        this.advertCleanup?.();
        this.advertCleanup = undefined;
        this.signaling?.stop();
        for (const c of this.conns.values())
            c.close();
        this.conns.clear();
        this.autoConnectPeers.clear();
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
        this.pendingConnects.clear();
        this.knownSessionIds.clear();
        this.seenSessionIds.clear();
        this.discoveryStream?.close();
        this.discoveryStream = undefined;
        this.signaling = undefined;
        this.ctx = undefined;
    }
    async handleAdvert(authorXOnlyHex, advert) {
        const localPubkeyHex = this.ctx ? toHex(this.ctx.localIdentity.publicKey) : "";
        for (const endpoint of advert.endpoints) {
            if (endpoint.transport !== "webrtc" || endpoint.addr.length !== 66)
                continue;
            if (endpoint.addr.slice(2) !== authorXOnlyHex)
                continue;
            if (endpoint.addr === localPubkeyHex || this.conns.has(endpoint.addr))
                continue;
            if (this.autoConnectPeers.has(endpoint.addr))
                continue;
            if (this.conns.size + this.pendingDials.size + this.autoConnectPeers.size >= this.cfg.maxConnections) {
                return;
            }
            const shouldDelay = localPubkeyHex.length === 66
                && localPubkeyHex.slice(2) > endpoint.addr.slice(2);
            this.autoConnectPeers.add(endpoint.addr);
            if (shouldDelay)
                await new Promise((resolve) => setTimeout(resolve, 1200));
            if (!this.ctx || this.conns.has(endpoint.addr)) {
                this.autoConnectPeers.delete(endpoint.addr);
                continue;
            }
            this.discoveryStream?.push({
                remoteAddr: { transport: this.type, addr: endpoint.addr },
                publicKey: fromHex(endpoint.addr),
                meta: { source: "nostr-advert" },
            });
        }
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
        if (this.conns.has(remotePubkeyHex))
            return;
        const pendingConnect = this.pendingConnects.get(remotePubkeyHex);
        if (pendingConnect) {
            await pendingConnect;
            return;
        }
        const remoteXOnlyHex = remotePubkeyHex.slice(2); // strip 02/03 parity
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
                pc.close();
                reject(new Error("WebRTC connect timeout"));
            }, this.cfg.connectTimeoutMs);
            const dial = {
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
        this.pendingConnects.set(remotePubkeyHex, connectPromise);
        try {
            await connectPromise;
        }
        finally {
            if (this.pendingConnects.get(remotePubkeyHex) === connectPromise) {
                this.pendingConnects.delete(remotePubkeyHex);
            }
            if (!this.conns.has(remotePubkeyHex)) {
                this.autoConnectPeers.delete(remotePubkeyHex);
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
        const conn = this.conns.get(addr.addr);
        if (conn) {
            conn.close();
            this.conns.delete(addr.addr);
        }
    }
    async startInitiatorHandshake(dial, addr) {
        const offer = await dial.pc.createOffer();
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
        await this.signaling.sendSignal(dial.remoteXOnlyHex, signal);
        this.logger.debug("webrtc offer sent", dial.remotePubkeyHex, dial.sessionId);
        // Wire connection state to dialer promise once data channel opens.
        let conn = null;
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
                    if (conn)
                        this.conns.set(dial.remotePubkeyHex, conn);
                    if (this.pendingDials.delete(dial.sessionId)) {
                        clearTimeout(dial.timer);
                        dial.resolve();
                    }
                }
                else if (state === "failed" || state === "disconnected") {
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
    async handleIncomingSignal(signal, senderXOnlyHex) {
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
            const remoteAddr = { transport: "webrtc", addr: valid.sender };
            const pc = new this.RTCPC({
                iceServers: (this.cfg.stunServers ?? []).map((u) => ({ urls: u })),
            });
            // Capture the incoming data channel via ondatachannel; wire it up
            // *after* publishing the answer, since the channel won't arrive until
            // the initiator receives the answer and the ICE handshake completes.
            const dcPromise = new Promise((resolve) => {
                pc.ondatachannel = (evt) => resolve(evt.channel);
            });
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
            await this.signaling.sendSignal(senderXOnlyHex, reply);
            this.logger.debug("webrtc answer sent", valid.sender, valid.sessionId);
            // Now wait for the negotiated channel to arrive and wire it up.
            dcPromise.then((dataChannel) => {
                let conn = null;
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
                            if (conn)
                                this.conns.set(valid.sender, conn);
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
            if (!dial)
                return;
            await dial.pc.setRemoteDescription({ type: "answer", sdp: valid.sdp });
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
function waitForIceGatheringComplete(pc, timeoutMs) {
    if (pc.iceGatheringState === "complete")
        return Promise.resolve();
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
class AsyncEventStream {
    values = [];
    waiters = [];
    closed = false;
    push(value) {
        if (this.closed)
            return;
        const waiter = this.waiters.shift();
        if (waiter)
            waiter({ done: false, value });
        else
            this.values.push(value);
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.values.length = 0;
        for (const waiter of this.waiters.splice(0)) {
            waiter({ done: true, value: undefined });
        }
    }
    [Symbol.asyncIterator]() {
        return {
            next: () => {
                const value = this.values.shift();
                if (value !== undefined)
                    return Promise.resolve({ done: false, value });
                if (this.closed)
                    return Promise.resolve({ done: true, value: undefined });
                return new Promise((resolve) => this.waiters.push(resolve));
            },
        };
    }
}
async function* emptyAsyncIterable() {
    return;
}
//# sourceMappingURL=WebRtcTransport.js.map