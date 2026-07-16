import { randomBytes } from "@noble/hashes/utils";
import { bytesEqual, toHex } from "../codec/hex.js";
import { FmpLink } from "../fmp/link.js";
import { compressedPubkeyFromXOnly, } from "../identity/index.js";
import { deriveNodeAddr, nodeAddrToHex } from "../nodeaddr/index.js";
import { LinkMessageType } from "../protocol/link.js";
import { noopLogger, transportAddressKey, } from "../transport/types.js";
import { FipsRouting } from "./FipsRouting.js";
import { FmpTransportPacketProcessor, nextSessionIdx, } from "./FmpTransportPacketProcessor.js";
import { FspSessionManager } from "./FspSessionManager.js";
const defaultRandom = { bytes: (n) => randomBytes(n) };
const FMP_HANDSHAKE_TIMEOUT_MS = 15_000;
const FMP_HANDSHAKE_RESEND_MS = 1_000;
const FMP_HEARTBEAT_INTERVAL_MS = 5_000;
export class FipsNode {
    identity;
    forwarding;
    routingMode;
    transports;
    random;
    startupEpoch;
    logger;
    defaultRoute;
    heartbeatIntervalMs;
    peers = new Map(); // by transportAddressKey
    peersByPubkey = new Map(); // by pubkey hex
    peersByNodeAddr = new Map(); // by NodeAddr hex
    pendingPeerConnects = new Map(); // by transportAddressKey
    listeners = new Map();
    discoveryTasks = new Set();
    discoveryConnectTasks = new Set();
    discoveryGeneration = 0;
    heartbeatTimer;
    routing;
    sessionManager;
    packetProcessor;
    started = false;
    constructor(cfg) {
        this.identity = cfg.identity;
        this.transports = expandCompanionTransports(cfg.transports);
        this.forwarding = cfg.forwarding ?? false;
        this.routingMode = cfg.routingMode ?? "tree";
        this.defaultRoute = cfg.defaultRoute?.toLowerCase();
        if (this.defaultRoute && !/^(02|03)[0-9a-f]{64}$/.test(this.defaultRoute)) {
            throw new Error("defaultRoute must be a 33-byte compressed pubkey hex");
        }
        this.random = cfg.random ?? defaultRandom;
        this.startupEpoch = this.random.bytes(8);
        if (this.startupEpoch.length !== 8) {
            throw new Error("FIPS random source returned a bad startup epoch");
        }
        this.logger = cfg.logger ?? noopLogger;
        this.heartbeatIntervalMs = cfg.heartbeatIntervalMs ?? FMP_HEARTBEAT_INTERVAL_MS;
        if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0) {
            throw new Error("heartbeatIntervalMs must be a positive safe integer");
        }
        this.routing = new FipsRouting({
            identity: this.identity,
            forwarding: this.forwarding,
            routingMode: this.routingMode,
            defaultRoute: this.defaultRoute,
            transports: this.transports,
            logger: this.logger,
            randomBytes: (length) => this.random.bytes(length),
            getPeers: () => this.peers.values(),
            getPeerByPubkey: (pubkeyHex) => this.peersByPubkey.get(pubkeyHex),
            getPeerByNodeAddr: (nodeAddrHex) => this.peersByNodeAddr.get(nodeAddrHex),
            sendLinkMessage: (peer, msgType, payload) => this.sendLinkMessage(peer, msgType, payload),
            connectKnownPeer: (transport, remoteAddr, remotePubkey) => this.connectKnownPeer(transport, remoteAddr, remotePubkey),
            handleLocalSession: (peer, srcNodeAddr, payload) => this.sessionManager.handleFromPeer(peer, srcNodeAddr, payload),
            emitError: (error, where) => this.emit("error", { err: error, where }),
            isStarted: () => this.started,
        });
        this.sessionManager = new FspSessionManager({
            identity: this.identity,
            random: this.random,
            localEpoch: this.startupEpoch,
            logger: this.logger,
            routing: this.routing,
            getPeerByNodeAddr: (nodeAddrHex) => this.peersByNodeAddr.get(nodeAddrHex),
            emitDatagram: (event) => this.emit("datagram", event),
            emitEndpointData: (event) => this.emit("endpointData", event),
            handleLinkNegotiation: async (remotePubkeyHex, message) => {
                const transport = this.transports.find((candidate) => candidate.type === message.linkType && candidate.handleLinkNegotiation);
                if (!transport?.handleLinkNegotiation) {
                    this.logger.debug("ignored link negotiation for disabled adapter", message.linkType);
                    return;
                }
                await transport.handleLinkNegotiation(remotePubkeyHex, message);
            },
            emitSession: (event) => this.emit("session", event),
        });
        this.packetProcessor = new FmpTransportPacketProcessor({
            identity: this.identity,
            startupEpoch: this.startupEpoch,
            randomBytes: (length) => this.random.bytes(length),
            logger: this.logger,
            peers: this.peers,
            peersByPubkey: this.peersByPubkey,
            peersByNodeAddr: this.peersByNodeAddr,
            routing: this.routing,
            sessionManager: this.sessionManager,
            emitError: (error, where) => this.emit("error", { err: error, where }),
            emitPeer: (event) => this.emit("peer", event),
            handlePeerRestart: (remotePubkeyHex, preserveTransport) => {
                for (const transport of this.transports) {
                    if (transport === preserveTransport || !transport.handlePeerRestart)
                        continue;
                    void transport.handlePeerRestart(remotePubkeyHex).catch((error) => {
                        this.emit("error", { err: error, where: "transport.handlePeerRestart" });
                    });
                }
            },
        });
        for (const s of cfg.services ?? []) {
            this.sessionManager.registerService(s.port, s.handler);
        }
    }
    async start() {
        if (this.started)
            return;
        const startedTransports = [];
        try {
            for (const t of this.transports) {
                await t.start({
                    localIdentity: this.identity,
                    onPacket: (packet) => this.packetProcessor.process(t, packet),
                    onConnectionState: (e) => this.onTransportConn(t, e),
                    connectTransport: (addr) => this.connect(addr),
                    sendLinkNegotiation: (remotePubkeyHex, message) => this.sessionManager.sendLinkNegotiation(remotePubkeyHex, message),
                    logger: this.logger,
                });
                startedTransports.push(t);
            }
        }
        catch (err) {
            for (const t of startedTransports.reverse()) {
                try {
                    await t.stop();
                }
                catch {
                    // Preserve the original start failure.
                }
            }
            throw err;
        }
        this.started = true;
        this.heartbeatTimer = setInterval(() => {
            void this.sendHeartbeats();
        }, this.heartbeatIntervalMs);
        const generation = ++this.discoveryGeneration;
        for (const transport of this.transports) {
            if (!transport.discover)
                continue;
            const task = this.consumeDiscovery(transport, generation);
            this.discoveryTasks.add(task);
            void task.finally(() => this.discoveryTasks.delete(task));
        }
    }
    async stop() {
        if (!this.started)
            return;
        this.started = false;
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
        this.discoveryGeneration++;
        for (const peer of this.peers.values()) {
            peer.outgoingHandshake?.reject(new Error("FIPS node stopped"));
            peer.link.close();
            peer.pendingResponderLink?.close();
            for (const draining of peer.drainingResponderLinks?.values() ?? []) {
                draining.link.close();
            }
        }
        this.routing.stop();
        this.sessionManager.stop();
        for (const t of this.transports) {
            try {
                await t.stop();
            }
            catch (err) {
                this.emit("error", { err: err, where: "transport.stop" });
            }
        }
        await Promise.allSettled([...this.discoveryTasks]);
        this.discoveryTasks.clear();
        await Promise.allSettled([...this.discoveryConnectTasks]);
        this.discoveryConnectTasks.clear();
        this.peers.clear();
        this.peersByPubkey.clear();
        this.peersByNodeAddr.clear();
        this.pendingPeerConnects.clear();
        this.packetProcessor.clear();
    }
    async consumeDiscovery(transport, generation) {
        try {
            for await (const discovered of transport.discover()) {
                if (!this.started || generation !== this.discoveryGeneration)
                    return;
                const task = this.connectDiscoveredPeer(transport, discovered, generation);
                this.discoveryConnectTasks.add(task);
                void task.finally(() => this.discoveryConnectTasks.delete(task));
            }
        }
        catch (err) {
            if (this.started && generation === this.discoveryGeneration) {
                this.emit("error", { err: err, where: "transport.discover" });
            }
        }
    }
    async connectDiscoveredPeer(transport, discovered, generation) {
        try {
            const remotePubkey = discoveryPublicKey(discovered);
            if (bytesEqual(remotePubkey.subarray(1), this.identity.xOnlyPubkey))
                return;
            await this.connectKnownPeer(transport, discovered.remoteAddr, remotePubkey);
        }
        catch (err) {
            if (!this.started || generation !== this.discoveryGeneration)
                return;
            this.emit("error", { err: err, where: "transport.discover" });
            this.logger.warn("transport discovery connect failed", transport.type, err);
        }
    }
    registerService(port, handler) {
        return this.sessionManager.registerService(port, handler);
    }
    /**
     * Connect to an adjacent peer over a chosen transport. The address's `addr`
     * must be the remote node's 33-byte compressed pubkey in hex.
     */
    async connect(addr) {
        const transport = this.transports.find((t) => t.type === addr.transport);
        if (!transport)
            throw new Error(`no transport registered for ${addr.transport}`);
        if (addr.addr.length !== 66) {
            throw new Error("transport addr must be 33-byte compressed pubkey hex");
        }
        const remotePubkey = hexBytes(addr.addr);
        await this.connectKnownPeer(transport, addr, remotePubkey);
    }
    async connectKnownPeer(transport, addr, remotePubkey) {
        if (remotePubkey.length !== 33 || (remotePubkey[0] !== 0x02 && remotePubkey[0] !== 0x03)) {
            throw new Error("remote pubkey must be 33-byte compressed secp256k1 key");
        }
        const key = transportAddressKey(addr);
        if (this.peers.has(key) && this.peers.get(key).link.state === "established")
            return;
        const pendingConnect = this.pendingPeerConnects.get(key);
        if (pendingConnect) {
            await pendingConnect;
            return;
        }
        const connectPromise = this.connectAdjacentPeer(transport, addr, remotePubkey, key);
        this.pendingPeerConnects.set(key, connectPromise);
        try {
            await connectPromise;
        }
        finally {
            if (this.pendingPeerConnects.get(key) === connectPromise) {
                this.pendingPeerConnects.delete(key);
            }
        }
    }
    async connectAdjacentPeer(transport, addr, remotePubkey, key) {
        this.logger.debug("fips connect transport start", addr.transport, addr.addr);
        await transport.connect(addr);
        this.logger.debug("fips connect transport ready", addr.transport, addr.addr);
        const concurrentlyEstablished = this.peers.get(key);
        if (concurrentlyEstablished?.link.state === "established")
            return;
        const link = new FmpLink({
            identity: this.identity,
            remotePubkey,
            role: "initiator",
            sessionIdx: nextSessionIdx(),
            localEpoch: this.startupEpoch,
        });
        const peer = {
            pubkey: remotePubkey,
            pubkeyHex: toHex(remotePubkey),
            remoteAddr: addr,
            transport,
            link,
        };
        this.peers.set(key, peer);
        this.rememberPeer(peer);
        const handshakeDone = new Promise((resolve, reject) => {
            peer.outgoingHandshake = { resolve, reject };
        });
        const msg1 = link.buildMsg1((n) => this.random.bytes(n));
        const sendMsg1 = async (resend) => {
            await transport.send(addr, msg1.packet);
            this.logger.debug(resend ? "fips msg1 resent" : "fips msg1 sent", addr.transport, addr.addr, msg1.packet.length);
        };
        await sendMsg1(false);
        const resendTimer = setInterval(() => {
            if (!peer.outgoingHandshake)
                return;
            void sendMsg1(true).catch((err) => {
                this.emit("error", { err: err, where: "resend Msg1" });
            });
        }, FMP_HANDSHAKE_RESEND_MS);
        const timer = setTimeout(() => {
            this.logger.warn("fips handshake timeout", addr.transport, addr.addr);
            peer.outgoingHandshake?.reject(new Error("FMP handshake timeout"));
        }, FMP_HANDSHAKE_TIMEOUT_MS);
        try {
            await handshakeDone;
        }
        finally {
            clearTimeout(timer);
            clearInterval(resendTimer);
            peer.outgoingHandshake = undefined;
            if (peer.link.state !== "established" && this.peers.get(key) === peer) {
                this.removePeerPath(key, peer, false);
            }
        }
    }
    /** Send a service datagram to a target identity (adjacent or routable). */
    async sendDatagram(args) {
        await this.sessionManager.sendDatagram(args);
    }
    /** Send app-owned endpoint bytes to a target identity without service ports. */
    async sendEndpointData(args) {
        await this.sessionManager.sendEndpointData(args);
    }
    on(event, cb) {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(cb);
        return () => set.delete(cb);
    }
    emit(event, data) {
        const set = this.listeners.get(event);
        if (!set)
            return;
        for (const cb of set) {
            try {
                cb(data);
            }
            catch (err) {
                this.logger.warn("listener threw", err);
            }
        }
    }
    onTransportConn(_transport, e) {
        if (e.state === "disconnected" || e.state === "failed") {
            const key = transportAddressKey(e.remoteAddr);
            const peer = this.peers.get(key);
            if (peer) {
                peer.link.close();
                peer.pendingResponderLink?.close();
                for (const draining of peer.drainingResponderLinks?.values() ?? []) {
                    draining.link.close();
                }
                this.removePeerPath(key, peer, true);
                this.emit("peer", {
                    remotePubkey: peer.pubkeyHex,
                    remoteAddr: peer.remoteAddr,
                    state: "disconnected",
                });
            }
        }
    }
    rememberPeer(peer) {
        if (peer.pubkey.length === 0 || !peer.pubkeyHex)
            return;
        this.peersByPubkey.set(peer.pubkeyHex, peer);
        this.peersByNodeAddr.set(nodeAddrToHex(deriveNodeAddr(peer.pubkey)), peer);
    }
    removePeerPath(key, peer, closeSessionWithoutAlternate) {
        this.peers.delete(key);
        const alternate = [...this.peers.values()].find((candidate) => candidate !== peer
            && candidate.pubkeyHex === peer.pubkeyHex
            && candidate.link.state === "established");
        if (alternate) {
            this.rememberPeer(alternate);
            this.routing.scheduleTreeAnnounce(alternate);
            return;
        }
        if (this.peersByPubkey.get(peer.pubkeyHex) === peer) {
            this.peersByPubkey.delete(peer.pubkeyHex);
        }
        if (peer.pubkey.length > 0) {
            const peerNodeAddr = deriveNodeAddr(peer.pubkey);
            const nodeAddrHex = nodeAddrToHex(peerNodeAddr);
            if (this.peersByNodeAddr.get(nodeAddrHex) === peer) {
                this.peersByNodeAddr.delete(nodeAddrHex);
            }
            this.routing.removePeer(peerNodeAddr);
        }
        if (closeSessionWithoutAlternate) {
            this.sessionManager.closePeerSessions(peer.pubkeyHex);
        }
    }
    async sendLinkMessage(peer, msgType, payload) {
        const frame = peer.link.encryptOutgoing(payload, msgType);
        await peer.transport.send(peer.remoteAddr, frame);
    }
    async sendHeartbeats() {
        const nowMs = Date.now();
        for (const peer of this.peers.values()) {
            this.pruneDrainingResponderLinks(peer, nowMs);
        }
        const peers = [...this.peers.values()].filter((peer) => peer.link.state === "established");
        await Promise.allSettled(peers.map(async (peer) => {
            const frame = peer.link.encryptOutgoing(new Uint8Array(0), LinkMessageType.Heartbeat);
            try {
                await peer.transport.send(peer.remoteAddr, frame);
            }
            catch (err) {
                this.emit("error", { err: err, where: "send Heartbeat" });
            }
        }));
    }
    pruneDrainingResponderLinks(peer, nowMs) {
        if (!peer.drainingResponderLinks)
            return;
        for (const [receiverIdx, draining] of peer.drainingResponderLinks) {
            if (draining.expiresAtMs > nowMs)
                continue;
            draining.link.close();
            peer.drainingResponderLinks.delete(receiverIdx);
        }
        if (peer.drainingResponderLinks.size === 0) {
            peer.drainingResponderLinks = undefined;
        }
    }
}
function discoveryPublicKey(discovered) {
    const hinted = discovered.publicKey;
    if (hinted?.length === 32)
        return compressedPubkeyFromXOnly(hinted);
    if (hinted?.length === 33) {
        if (hinted[0] !== 0x02 && hinted[0] !== 0x03) {
            throw new Error("discovered compressed pubkey has invalid prefix");
        }
        return new Uint8Array(hinted);
    }
    if (!hinted && discovered.remoteAddr.addr.length === 66) {
        return hexBytes(discovered.remoteAddr.addr);
    }
    throw new Error("discovered peer did not include a FIPS public key");
}
function hexBytes(hex) {
    if (hex.length % 2 !== 0)
        throw new Error("hex length");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}
function expandCompanionTransports(configured) {
    const explicitTypes = new Set(configured.map((transport) => transport.type));
    const expanded = [];
    const addedTypes = new Set();
    for (const transport of configured) {
        for (const companion of transport.companionTransports?.() ?? []) {
            if (explicitTypes.has(companion.type) || addedTypes.has(companion.type))
                continue;
            expanded.push(companion);
            addedTypes.add(companion.type);
        }
        expanded.push(transport);
        addedTypes.add(transport.type);
    }
    return expanded;
}
//# sourceMappingURL=FipsNode.js.map