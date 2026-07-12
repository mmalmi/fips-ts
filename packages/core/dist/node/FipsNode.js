import { randomBytes } from "@noble/hashes/utils";
import { bytesEqual, toHex } from "../codec/hex.js";
import { FmpLink } from "../fmp/link.js";
import { DirectFspTransportReassembler, isDirectFspTransportFragment, } from "../fsp/directTransport.js";
import { decodeFmpMsg2, decodeFmpEstablished, FMP_PHASE_ESTABLISHED, FMP_PHASE_MSG1, FMP_PHASE_MSG2, peekFmpPhase, } from "../fmp/wire.js";
import { isDirectFspEstablished, } from "../fsp/wire.js";
import { compressedPubkeyFromXOnly, } from "../identity/index.js";
import { compareNodeAddr, deriveNodeAddr, nodeAddrToHex, } from "../nodeaddr/index.js";
import { LinkMessageType } from "../protocol/link.js";
import { noopLogger, transportAddressKey, } from "../transport/types.js";
import { FipsRouting } from "./FipsRouting.js";
import { FspSessionManager } from "./FspSessionManager.js";
let sessionIdxCounter = 1;
function nextSessionIdx() {
    const v = sessionIdxCounter++;
    return v >>> 0;
}
const defaultRandom = { bytes: (n) => randomBytes(n) };
const FMP_HANDSHAKE_TIMEOUT_MS = 15_000;
const FMP_HANDSHAKE_RESEND_MS = 1_000;
const FMP_HEARTBEAT_INTERVAL_MS = 5_000;
const FMP_REPLACED_LINK_DRAIN_MS = 10_000;
export class FipsNode {
    identity;
    forwarding;
    routingMode;
    transports;
    random;
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
    directFspReassembler = new DirectFspTransportReassembler();
    routing;
    sessionManager;
    started = false;
    constructor(cfg) {
        this.identity = cfg.identity;
        this.transports = cfg.transports;
        this.forwarding = cfg.forwarding ?? false;
        this.routingMode = cfg.routingMode ?? "tree";
        this.defaultRoute = cfg.defaultRoute?.toLowerCase();
        if (this.defaultRoute && !/^(02|03)[0-9a-f]{64}$/.test(this.defaultRoute)) {
            throw new Error("defaultRoute must be a 33-byte compressed pubkey hex");
        }
        this.random = cfg.random ?? defaultRandom;
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
            logger: this.logger,
            routing: this.routing,
            getPeerByNodeAddr: (nodeAddrHex) => this.peersByNodeAddr.get(nodeAddrHex),
            emitDatagram: (event) => this.emit("datagram", event),
            emitEndpointData: (event) => this.emit("endpointData", event),
            emitSession: (event) => this.emit("session", event),
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
                    onPacket: (p) => this.onTransportPacket(t, p),
                    onConnectionState: (e) => this.onTransportConn(t, e),
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
        this.directFspReassembler.clear();
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
        const link = new FmpLink({
            identity: this.identity,
            remotePubkey,
            role: "initiator",
            sessionIdx: nextSessionIdx(),
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
                this.peers.delete(key);
                this.peersByPubkey.delete(peer.pubkeyHex);
                if (peer.pubkey.length > 0) {
                    const peerNodeAddr = deriveNodeAddr(peer.pubkey);
                    this.peersByNodeAddr.delete(nodeAddrToHex(peerNodeAddr));
                    this.routing.removePeer(peerNodeAddr);
                }
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
                this.peers.delete(key);
                this.peersByPubkey.delete(peer.pubkeyHex);
                if (peer.pubkey.length > 0) {
                    this.peersByNodeAddr.delete(nodeAddrToHex(deriveNodeAddr(peer.pubkey)));
                }
                this.sessionManager.closePeerSessions(peer.pubkeyHex);
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
    onTransportPacket(transport, p) {
        try {
            const key = transportAddressKey(p.remoteAddr);
            let peer = this.peers.get(key);
            let packet = p.data;
            if (isDirectFspTransportFragment(packet)) {
                if (!peer || peer.link.state !== "established" || peer.pubkey.length === 0) {
                    throw new Error("direct FSP fragment before adjacent link handshake complete");
                }
                const reassembled = this.directFspReassembler.ingest(key, packet, p.receivedAtMs);
                if (!reassembled)
                    return;
                packet = reassembled;
            }
            if (isDirectFspEstablished(packet)) {
                if (!peer || peer.link.state !== "established" || peer.pubkey.length === 0) {
                    throw new Error("direct FSP before adjacent link handshake complete");
                }
                void this.sessionManager.handleFromPeer(peer, deriveNodeAddr(peer.pubkey), packet).catch((err) => {
                    this.emit("error", { err: err, where: "direct-fsp" });
                });
                return;
            }
            const phase = peekFmpPhase(packet);
            this.logger.debug("fips packet received", p.remoteAddr.transport, p.remoteAddr.addr, packet.length, phase);
            switch (phase) {
                case FMP_PHASE_MSG1: {
                    let replacedEstablishedInitiator = false;
                    let replacedHandshake;
                    if (peer?.link.role === "initiator") {
                        if (peer.pubkey.length === 0) {
                            throw new Error("outbound FMP peer is missing its expected identity");
                        }
                        const order = compareNodeAddr(this.identity.nodeAddr, deriveNodeAddr(peer.pubkey));
                        if (order < 0) {
                            this.logger.debug("simultaneous FMP handshake: local initiator wins", p.remoteAddr.transport, p.remoteAddr.addr);
                            break;
                        }
                        if (order === 0)
                            throw new Error("simultaneous FMP handshake with local identity");
                        replacedEstablishedInitiator = peer.link.state === "established";
                        peer.abandonedInitiatorSessionIdx = peer.link.localSessionIdx;
                        replacedHandshake = peer.outgoingHandshake;
                        peer.link.close();
                        peer.link = new FmpLink({
                            identity: this.identity,
                            role: "responder",
                            sessionIdx: nextSessionIdx(),
                        });
                        this.logger.debug("simultaneous FMP handshake: remote initiator wins", p.remoteAddr.transport, p.remoteAddr.addr);
                    }
                    // Responder side: create link if absent.
                    if (!peer) {
                        const link = new FmpLink({
                            identity: this.identity,
                            role: "responder",
                            sessionIdx: nextSessionIdx(),
                        });
                        peer = {
                            pubkey: new Uint8Array(0),
                            pubkeyHex: "",
                            remoteAddr: p.remoteAddr,
                            transport,
                            link,
                        };
                        this.peers.set(key, peer);
                    }
                    const wasEstablished = replacedEstablishedInitiator
                        || peer.link.state === "established";
                    let result;
                    if (peer.link.role === "responder" && peer.link.state === "established") {
                        try {
                            result = peer.link.handleMsg1(packet, (n) => this.random.bytes(n));
                        }
                        catch (error) {
                            if (!(error instanceof Error)
                                || error.message !== "unexpected FMP Msg1 after establishment") {
                                throw error;
                            }
                            result = this.stageResponderReplacement(peer, packet);
                            this.logger.debug("staged responder link after fresh authenticated Msg1", p.remoteAddr.transport, p.remoteAddr.addr);
                        }
                    }
                    else {
                        result = peer.link.handleMsg1(packet, (n) => this.random.bytes(n));
                    }
                    peer.pubkey = result.remotePubkey;
                    peer.pubkeyHex = toHex(result.remotePubkey);
                    this.rememberPeer(peer);
                    if (result.reply) {
                        void transport.send(p.remoteAddr, result.reply)
                            .catch((err) => {
                            this.emit("error", { err: err, where: "send Msg2" });
                        });
                        this.logger.debug("fips msg2 sent", p.remoteAddr.transport, p.remoteAddr.addr, result.reply.length);
                    }
                    if (replacedHandshake) {
                        peer.outgoingHandshake = undefined;
                        replacedHandshake.resolve();
                    }
                    if (!wasEstablished) {
                        this.emit("peer", {
                            remotePubkey: peer.pubkeyHex,
                            remoteAddr: peer.remoteAddr,
                            state: "connected",
                        });
                    }
                    break;
                }
                case FMP_PHASE_MSG2: {
                    if (!peer)
                        throw new Error("FMP Msg2 with no peer state");
                    if (peer.link.role === "responder" && peer.abandonedInitiatorSessionIdx !== undefined) {
                        const msg2 = decodeFmpMsg2(packet);
                        if (msg2.receiverIdx === peer.abandonedInitiatorSessionIdx) {
                            peer.abandonedInitiatorSessionIdx = undefined;
                            this.logger.debug("ignored Msg2 for abandoned simultaneous FMP initiator", p.remoteAddr.transport, p.remoteAddr.addr);
                            break;
                        }
                    }
                    const wasEstablished = peer.link.state === "established";
                    peer.link.handleMsg2(packet);
                    peer.pubkey = peer.link.remotePubkey;
                    peer.pubkeyHex = toHex(peer.link.remotePubkey);
                    this.rememberPeer(peer);
                    if (!wasEstablished) {
                        this.emit("peer", {
                            remotePubkey: peer.pubkeyHex,
                            remoteAddr: peer.remoteAddr,
                            state: "connected",
                        });
                        peer.outgoingHandshake?.resolve();
                        peer.outgoingHandshake = undefined;
                        this.routing.scheduleTreeAnnounce(peer);
                    }
                    this.logger.debug("fips msg2 handled", p.remoteAddr.transport, p.remoteAddr.addr);
                    break;
                }
                case FMP_PHASE_ESTABLISHED: {
                    if (!peer || peer.link.state !== "established") {
                        throw new Error("FMP Established before handshake complete");
                    }
                    this.pruneDrainingResponderLinks(peer, Date.now());
                    const receiverIdx = decodeFmpEstablished(packet).receiverIdx;
                    let link = peer.link;
                    let promotePending = false;
                    if (receiverIdx !== link.localSessionIdx) {
                        if (peer.pendingResponderLink?.localSessionIdx === receiverIdx) {
                            link = peer.pendingResponderLink;
                            promotePending = true;
                        }
                        else {
                            const draining = peer.drainingResponderLinks?.get(receiverIdx);
                            if (!draining) {
                                const pendingIdx = peer.pendingResponderLink?.localSessionIdx;
                                throw new Error(`FMP Established receiver_idx mismatch: received=${receiverIdx} active=${peer.link.localSessionIdx}`
                                    + (pendingIdx === undefined ? "" : ` pending=${pendingIdx}`));
                            }
                            link = draining.link;
                        }
                    }
                    const { msgType, payload } = link.decryptIncoming(packet);
                    this.routing.scheduleTreeAnnounce(peer);
                    if (promotePending) {
                        const previous = peer.link;
                        peer.link = link;
                        peer.pendingResponderLink = undefined;
                        const draining = peer.drainingResponderLinks ?? new Map();
                        draining.set(previous.localSessionIdx, {
                            link: previous,
                            expiresAtMs: Date.now() + FMP_REPLACED_LINK_DRAIN_MS,
                        });
                        peer.drainingResponderLinks = draining;
                        this.logger.debug("promoted authenticated responder link", p.remoteAddr.transport, p.remoteAddr.addr, receiverIdx);
                    }
                    this.routing.handleLinkMessage(peer, msgType, payload).catch((err) => {
                        this.emit("error", { err: err, where: "link-message" });
                    });
                    break;
                }
                default:
                    throw new Error(`unknown FMP phase ${phase}`);
            }
        }
        catch (err) {
            this.emit("error", { err: err, where: "onTransportPacket" });
            this.logger.warn("transport packet error", err);
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
    stageResponderReplacement(peer, packet) {
        let replacement = peer.pendingResponderLink;
        if (replacement) {
            try {
                return replacement.handleMsg1(packet, (n) => this.random.bytes(n));
            }
            catch (error) {
                if (!(error instanceof Error)
                    || error.message !== "unexpected FMP Msg1 after establishment") {
                    throw error;
                }
                replacement.close();
                peer.pendingResponderLink = undefined;
            }
        }
        replacement = new FmpLink({
            identity: this.identity,
            role: "responder",
            sessionIdx: nextSessionIdx(),
        });
        const result = replacement.handleMsg1(packet, (n) => this.random.bytes(n));
        if (peer.pubkey.length > 0 && !bytesEqual(peer.pubkey, result.remotePubkey)) {
            replacement.close();
            throw new Error("fresh FMP Msg1 changed the authenticated peer identity");
        }
        peer.pendingResponderLink = replacement;
        return result;
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
//# sourceMappingURL=FipsNode.js.map