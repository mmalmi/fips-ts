import { randomBytes } from "@noble/hashes/utils";
import { bytesEqual, fromHex, toHex } from "../codec/hex.js";
import { FmpLink } from "../fmp/link.js";
import { deriveNodeAddr, nodeAddrToHex } from "../nodeaddr/index.js";
import { DisconnectReason, LinkMessageType, decodeSessionDatagramPayload } from "../protocol/link.js";
import { decodeLookupRequest } from "../protocol/discovery.js";
import { noopLogger, transportAddressKey, } from "../transport/types.js";
import { FipsRouting } from "./FipsRouting.js";
import { FmpTransportPacketProcessor, } from "./FmpTransportPacketProcessor.js";
import { FspSessionManager } from "./FspSessionManager.js";
import { FMP_HANDSHAKE_TIMEOUT_MS, pruneDrainingResponderLinks, sameCompressedIdentity } from "./PeerState.js";
import { discoveryPublicKey } from "./routingHelpers.js";
import { PeerAdmission } from "./PeerAdmission.js";
const defaultRandom = { bytes: (n) => randomBytes(n) };
const FMP_HANDSHAKE_RESEND_MS = 1_000;
const FMP_HEARTBEAT_INTERVAL_MS = 5_000;
export class FipsNode {
    identity;
    forwarding;
    routingMode;
    transports;
    random;
    startupEpoch;
    nextFmpSessionIdx;
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
    desiredRunning = false;
    hasStarted = false;
    needsTransportCleanup = false;
    admission;
    admissionUpdating = false;
    admissionUpdate = Promise.resolve();
    startTask;
    stopTask;
    pendingSends = new Set();
    constructor(cfg) {
        this.identity = cfg.identity;
        this.admission = new PeerAdmission(cfg.blockedPeerPubkeys);
        this.transports = expandCompanionTransports(cfg.transports);
        this.forwarding = cfg.forwarding ?? false;
        if (cfg.strictClient && this.forwarding)
            throw new Error("strictClient cannot forward traffic");
        this.routingMode = cfg.strictClient ? "reply_learned" : cfg.routingMode ?? "tree";
        this.defaultRoute = cfg.defaultRoute?.toLowerCase();
        if (this.defaultRoute && !/^(02|03)[0-9a-f]{64}$/.test(this.defaultRoute)) {
            throw new Error("defaultRoute must be a 33-byte compressed pubkey hex");
        }
        this.random = cfg.random ?? defaultRandom;
        this.startupEpoch = this.random.bytes(8);
        if (this.startupEpoch.length !== 8) {
            throw new Error("FIPS random source returned a bad startup epoch");
        }
        this.nextFmpSessionIdx = readU32Le(this.startupEpoch) || 1;
        this.logger = cfg.logger ?? noopLogger;
        this.heartbeatIntervalMs = cfg.heartbeatIntervalMs ?? FMP_HEARTBEAT_INTERVAL_MS;
        if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0) {
            throw new Error("heartbeatIntervalMs must be a positive safe integer");
        }
        this.routing = new FipsRouting({
            identity: this.identity,
            forwarding: this.forwarding,
            strictClient: cfg.strictClient,
            assertNodeAllowed: (nodeAddr) => this.admission.assertNode(nodeAddr),
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
            strictClient: cfg.strictClient,
            getPeerByNodeAddr: (nodeAddrHex) => this.peersByNodeAddr.get(nodeAddrHex),
            assertPeerAllowed: (pubkey) => this.admission.assertPeer(pubkey),
            assertNodeAllowed: (nodeAddr) => this.admission.assertNode(nodeAddr),
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
            emitSession: (event) => {
                if (event.state === "established") {
                    const sessionNodeHex = sessionEventNodeHex(event.remotePubkey);
                    if (sessionNodeHex)
                        this.routing.noteSessionEstablished(sessionNodeHex);
                    for (const transport of this.transports) {
                        try {
                            if (event.restarted)
                                transport.handleSessionEstablished?.(event.remotePubkey, true);
                            else
                                transport.handleSessionEstablished?.(event.remotePubkey);
                        }
                        catch (err) {
                            this.emit("error", { err: err, where: "transport.handleSessionEstablished" });
                        }
                    }
                }
                this.emit("session", event);
            },
        });
        this.packetProcessor = new FmpTransportPacketProcessor({
            identity: this.identity,
            startupEpoch: this.startupEpoch,
            nextSessionIdx: () => this.allocateFmpSessionIdx(),
            randomBytes: (length) => this.random.bytes(length),
            logger: this.logger,
            peers: this.peers,
            peersByPubkey: this.peersByPubkey,
            peersByNodeAddr: this.peersByNodeAddr,
            routing: this.routing,
            sessionManager: this.sessionManager,
            assertPeerAllowed: (pubkey) => this.admission.assertPeer(pubkey),
            emitError: (error, where) => this.emit("error", { err: error, where }),
            emitPeer: (event) => this.emit("peer", event),
            removePeerPath: (peer) => {
                const key = transportAddressKey(peer.remoteAddr);
                if (this.peers.get(key) === peer)
                    this.removePeerPath(key, peer, true);
            },
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
        this.desiredRunning = true;
        await this.stopTask;
        if (this.admissionUpdating)
            await this.admissionUpdate;
        if (this.desiredRunning)
            await this.startNode();
    }
    startNode() {
        if (this.startTask)
            return this.startTask;
        const task = this.startTransports();
        this.startTask = task;
        void task.finally(() => { if (this.startTask === task)
            this.startTask = undefined; }).catch(() => { });
        return task;
    }
    async startTransports() {
        if (this.started)
            return;
        if (this.hasStarted) {
            // Retained services restart with fresh link/session keys. Authenticate a
            // new epoch so surviving remote sessions cannot mistake this for rekey.
            const epoch = new DataView(this.startupEpoch.buffer, this.startupEpoch.byteOffset, 8);
            epoch.setBigUint64(0, epoch.getBigUint64(0, true) + 1n, true);
            this.sessionManager.resetLocalEpoch();
        }
        this.needsTransportCleanup = true;
        const generation = ++this.discoveryGeneration;
        const current = () => generation === this.discoveryGeneration;
        const startedTransports = [];
        try {
            for (const t of this.transports) {
                startedTransports.push(t);
                await t.start({
                    localIdentity: this.identity,
                    onPacket: (packet) => { if (current())
                        this.packetProcessor.process(t, packet); },
                    onConnectionState: (e) => { if (current())
                        this.onTransportConn(t, e); },
                    allowPeer: (pubkey) => current() && this.admission.allows(pubkey),
                    isLinked: () => current()
                        && [...this.peers.values()].some((peer) => peer.link.state === "established"),
                    connectTransport: async (addr) => {
                        if (!current())
                            throw new Error("FIPS transport was stopped");
                        await this.connect(addr);
                    },
                    sendLinkNegotiation: async (remotePubkeyHex, message) => {
                        if (!current())
                            throw new Error("FIPS transport was stopped");
                        await this.trackSend(this.sessionManager.sendLinkNegotiation(remotePubkeyHex, message));
                    },
                    logger: this.logger,
                });
                if (!current() || !this.desiredRunning)
                    throw new Error("FIPS node start cancelled");
            }
        }
        catch (err) {
            this.discoveryGeneration++;
            let closed = true;
            for (const t of startedTransports.reverse()) {
                try {
                    await t.stop();
                }
                catch {
                    closed = false;
                    // Preserve the original start failure.
                }
            }
            this.needsTransportCleanup = !closed;
            throw err;
        }
        this.started = true;
        this.hasStarted = true;
        this.sessionManager.start();
        this.heartbeatTimer = setInterval(() => {
            void this.sendHeartbeats();
        }, this.heartbeatIntervalMs);
        for (const transport of this.transports) {
            if (!transport.discover)
                continue;
            const task = this.consumeDiscovery(transport, generation);
            this.discoveryTasks.add(task);
            void task.finally(() => this.discoveryTasks.delete(task));
        }
    }
    async stop() {
        this.desiredRunning = false;
        await this.stopNode();
        await this.admissionUpdate.catch(() => { });
    }
    stopNode() {
        if (this.stopTask)
            return this.stopTask;
        const task = this.stopTransports();
        this.stopTask = task;
        void task.finally(() => { if (this.stopTask === task)
            this.stopTask = undefined; }).catch(() => { });
        return task;
    }
    async stopTransports() {
        const failures = [];
        if (!this.needsTransportCleanup && !this.started && !this.startTask)
            return failures;
        this.started = false;
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
        this.discoveryGeneration++;
        this.packetProcessor.clear();
        this.routing.stop();
        this.sessionManager.stop();
        // Authenticate a graceful departure before rotating the startup epoch.
        // Otherwise a UDP router correctly treats the fresh Msg1 as a possible
        // replay against a still-live carrier until its restart grace expires.
        const departures = [...this.peers.values()]
            .filter(peer => peer.link.state === "established" && this.admission.allows(peer.pubkey))
            .map(peer => this.sendLinkMessage(peer, LinkMessageType.Disconnect, new Uint8Array([this.desiredRunning ? DisconnectReason.Restart : DisconnectReason.Shutdown])));
        if (departures.length) {
            let timeout;
            try {
                await Promise.race([Promise.allSettled(departures),
                    new Promise(resolve => { timeout = setTimeout(resolve, 100); })]);
            }
            finally {
                clearTimeout(timeout);
            }
        }
        for (const peer of this.peers.values()) {
            peer.outgoingHandshake?.reject(new Error("FIPS node stopped"));
            peer.link.close();
            peer.pendingResponderLink?.close();
            for (const draining of peer.drainingResponderLinks?.values() ?? []) {
                draining.link.close();
            }
        }
        for (const t of this.transports) {
            try {
                await t.stop();
            }
            catch (err) {
                failures.push(err instanceof Error ? err : new Error(String(err)));
                this.emit("error", { err: err, where: "transport.stop" });
            }
        }
        await Promise.allSettled([...this.discoveryTasks]);
        this.discoveryTasks.clear();
        await Promise.allSettled([...this.discoveryConnectTasks]);
        this.discoveryConnectTasks.clear();
        await Promise.allSettled([...this.pendingPeerConnects.values(), ...this.pendingSends, ...(this.startTask ? [this.startTask] : [])]);
        this.peers.clear();
        this.peersByPubkey.clear();
        this.peersByNodeAddr.clear();
        this.pendingPeerConnects.clear();
        this.needsTransportCleanup = failures.length > 0;
        return failures;
    }
    /**
     * Revoke immediately, then drain/reset the reader's connections before acknowledging.
     * Service registrations/listeners survive; identical sets do not reset anything.
     * stop() during the reset prevents restart. A failed closure rejects the barrier.
     */
    setBlockedPeerPubkeys(keys) {
        const next = new PeerAdmission(keys);
        if (this.admission.equals(next))
            return this.admissionUpdate;
        this.admission = next;
        this.admissionUpdating = true;
        this.discoveryGeneration++;
        const update = this.admissionUpdate.catch(() => { }).then(async () => {
            const failures = await this.stopNode();
            if (failures.length)
                throw new AggregateError(failures, `FIPS revocation failed: ${failures.map(e => e.message).join("; ")}`);
            if (this.desiredRunning)
                await this.startNode();
        }).finally(() => {
            if (this.admissionUpdate === update)
                this.admissionUpdating = false;
        });
        this.admissionUpdate = update;
        return update;
    }
    trackSend(task) {
        this.pendingSends.add(task);
        void task.finally(() => this.pendingSends.delete(task)).catch(() => { });
        return task;
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
        if (this.admissionUpdating)
            throw new Error("FIPS peer policy is updating");
        const transport = this.transports.find((t) => t.type === addr.transport);
        if (!transport)
            throw new Error(`no transport registered for ${addr.transport}`);
        if (addr.addr.length !== 66) {
            throw new Error("transport addr must be 33-byte compressed pubkey hex");
        }
        const remotePubkey = fromHex(addr.addr);
        await this.connectKnownPeer(transport, addr, remotePubkey);
    }
    async connectKnownPeer(transport, addr, remotePubkey) {
        this.admission.assertPeer(remotePubkey);
        if (remotePubkey.length !== 33 || (remotePubkey[0] !== 0x02 && remotePubkey[0] !== 0x03)) {
            throw new Error("remote pubkey must be 33-byte compressed secp256k1 key");
        }
        const key = transportAddressKey(addr);
        const pendingConnect = this.pendingPeerConnects.get(key);
        if (pendingConnect) {
            await pendingConnect;
            return;
        }
        if (this.peers.get(key)?.link.state === "established")
            return;
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
        const generation = this.discoveryGeneration;
        this.logger.debug("fips connect transport start", addr.transport, addr.addr);
        await transport.connect(addr);
        this.admission.assertPeer(remotePubkey);
        if (generation !== this.discoveryGeneration)
            throw new Error("FIPS connection was revoked");
        this.logger.debug("fips connect transport ready", addr.transport, addr.addr);
        const concurrentlyEstablished = this.peers.get(key);
        if (concurrentlyEstablished?.link.state === "established")
            return;
        if (concurrentlyEstablished) {
            this.packetProcessor.discardPendingResponder(concurrentlyEstablished);
            concurrentlyEstablished.link.close();
        }
        const link = new FmpLink({
            identity: this.identity,
            remotePubkey,
            role: "initiator",
            sessionIdx: this.allocateFmpSessionIdx(),
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
        const handshakeDone = new Promise((resolve, reject) => {
            peer.outgoingHandshake = { resolve, reject };
        });
        let resendTimer;
        let timer;
        let connected = false;
        try {
            const msg1 = link.buildMsg1((n) => this.random.bytes(n));
            const sendMsg1 = async (resend) => {
                this.admission.assertPeer(remotePubkey);
                if (generation !== this.discoveryGeneration)
                    throw new Error("FIPS connection was revoked");
                await transport.send(addr, msg1.packet);
                this.logger.debug(resend ? "fips msg1 resent" : "fips msg1 sent", addr.transport, addr.addr, msg1.packet.length);
            };
            await sendMsg1(false);
            resendTimer = setInterval(() => {
                if (!peer.outgoingHandshake)
                    return;
                void sendMsg1(true).catch((err) => {
                    this.emit("error", { err: err, where: "resend Msg1" });
                });
            }, FMP_HANDSHAKE_RESEND_MS);
            timer = setTimeout(() => {
                this.logger.warn("fips handshake timeout", addr.transport, addr.addr);
                peer.outgoingHandshake?.reject(new Error("FMP handshake timeout"));
            }, FMP_HANDSHAKE_TIMEOUT_MS);
            await handshakeDone;
            connected = true;
        }
        finally {
            clearTimeout(timer);
            clearInterval(resendTimer);
            peer.outgoingHandshake = undefined;
            if (!connected && this.peers.get(key) === peer) {
                peer.link.close();
                this.packetProcessor.discardPendingResponder(peer);
                this.removePeerPath(key, peer, false);
            }
        }
    }
    allocateFmpSessionIdx() {
        const value = this.nextFmpSessionIdx;
        this.nextFmpSessionIdx = (value + 1) >>> 0 || 1;
        return value;
    }
    /** Send a service datagram to a target identity (adjacent or routable). */
    async sendDatagram(args) {
        if (this.admissionUpdating)
            throw new Error("FIPS peer policy is updating");
        await this.trackSend(this.sessionManager.sendDatagram(args));
    }
    /** Send app-owned endpoint bytes to a target identity without service ports. */
    async sendEndpointData(args) {
        if (this.admissionUpdating)
            throw new Error("FIPS peer policy is updating");
        await this.trackSend(this.sessionManager.sendEndpointData(args));
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
                const wasConnected = peer.link.state === "established" && !peer.outgoingHandshake;
                peer.outgoingHandshake?.reject(new Error("FMP transport disconnected"));
                peer.link.close();
                this.packetProcessor.discardPendingResponder(peer);
                for (const draining of peer.drainingResponderLinks?.values() ?? []) {
                    draining.link.close();
                }
                this.removePeerPath(key, peer, true);
                if (wasConnected) {
                    this.emit("peer", {
                        remotePubkey: peer.pubkeyHex,
                        remoteAddr: peer.remoteAddr,
                        state: "disconnected",
                    });
                }
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
        const alternates = [...this.peers.values()].filter((candidate) => candidate !== peer
            && sameCompressedIdentity(candidate.pubkey, peer.pubkey)
            && (candidate.link.state === "established"
                || candidate.outgoingHandshake !== undefined
                || candidate.pendingResponderLink !== undefined));
        const alternate = alternates.find((candidate) => candidate.link.state === "established" && !candidate.outgoingHandshake);
        // Retarget every encoding of the removed identity. A pending alternate
        // keeps the session alive, but must not be indexed as a usable carrier yet.
        for (const [alias, indexed] of this.peersByPubkey) {
            if (indexed !== peer)
                continue;
            if (alternate)
                this.peersByPubkey.set(alias, alternate);
            else
                this.peersByPubkey.delete(alias);
        }
        if (alternate) {
            this.rememberPeer(alternate);
            this.routing.scheduleTreeAnnounce(alternate);
            return;
        }
        if (peer.pubkey.length > 0) {
            const peerNodeAddr = deriveNodeAddr(peer.pubkey);
            const nodeAddrHex = nodeAddrToHex(peerNodeAddr);
            if (this.peersByNodeAddr.get(nodeAddrHex) === peer) {
                this.peersByNodeAddr.delete(nodeAddrHex);
            }
            this.routing.removePeer(peerNodeAddr);
        }
        // An FSP session belongs to the remote identity, not this direct carrier.
        // Retain its keys when authenticated routing can still reach that identity;
        // a new local session would disagree with the surviving peer's key epoch.
        if (closeSessionWithoutAlternate && alternates.length === 0
            && (peer.pubkey.length === 0
                || !this.routing.hasUsableRoute(nodeAddrToHex(deriveNodeAddr(peer.pubkey))))) {
            this.sessionManager.closePeerSessions(peer.pubkeyHex);
        }
    }
    async sendLinkMessage(peer, msgType, payload) {
        this.admission.assertPeer(peer.pubkey);
        if (this.admission.hasBlockedPeers && msgType === LinkMessageType.SessionDatagram) {
            const datagram = decodeSessionDatagramPayload(payload);
            this.admission.assertNode(datagram.srcAddr);
            this.admission.assertNode(datagram.destAddr);
        }
        else if (this.admission.hasBlockedPeers && msgType === LinkMessageType.LookupRequest) {
            const request = decodeLookupRequest(payload);
            this.admission.assertNode(request.target);
            this.admission.assertNode(request.origin);
        }
        const frame = peer.link.encryptOutgoing(payload, msgType);
        await peer.transport.send(peer.remoteAddr, frame);
    }
    async sendHeartbeats() {
        await this.routing.refreshClientRole();
        const nowMs = Date.now();
        for (const peer of this.peers.values()) {
            pruneDrainingResponderLinks(peer, nowMs);
        }
        const peers = [...this.peers.values()].filter((peer) => peer.link.state === "established");
        await Promise.allSettled(peers.map(async (peer) => {
            this.admission.assertPeer(peer.pubkey);
            const frame = peer.link.encryptOutgoing(new Uint8Array(0), LinkMessageType.Heartbeat);
            try {
                await peer.transport.send(peer.remoteAddr, frame);
            }
            catch (err) {
                this.emit("error", { err: err, where: "send Heartbeat" });
            }
        }));
    }
}
function sessionEventNodeHex(remote) {
    if (/^(02|03)[0-9a-fA-F]{64}$/.test(remote))
        return nodeAddrToHex(deriveNodeAddr(fromHex(remote)));
    return /^[0-9a-fA-F]{32}$/.test(remote) ? remote.toLowerCase() : undefined;
}
function readU32Le(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
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