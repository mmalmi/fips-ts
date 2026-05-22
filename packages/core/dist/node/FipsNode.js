import { randomBytes } from "@noble/hashes/utils";
import { bytesEqual, toHex } from "../codec/hex.js";
import { FmpLink } from "../fmp/link.js";
import { FspSession } from "../fsp/session.js";
import { FMP_PHASE_ESTABLISHED, FMP_PHASE_MSG1, FMP_PHASE_MSG2, peekFmpPhase, } from "../fmp/wire.js";
import { FSP_MSG_DATA, FSP_MSG_ENDPOINT_DATA, FSP_PHASE_ESTABLISHED, peekFspPhase, } from "../fsp/wire.js";
import { deriveNodeAddr, nodeAddrToHex } from "../nodeaddr/index.js";
import { decodeSessionDatagramPayload, encodeSessionDatagram, LinkMessageType, } from "../protocol/link.js";
import { noopLogger, transportAddressKey, } from "../transport/types.js";
let sessionIdxCounter = 1;
function nextSessionIdx() {
    const v = sessionIdxCounter++;
    return v >>> 0;
}
const defaultRandom = { bytes: (n) => randomBytes(n) };
export class FipsNode {
    identity;
    forwarding;
    transports;
    random;
    logger;
    services = new Map();
    peers = new Map(); // by transportAddressKey
    peersByPubkey = new Map(); // by pubkey hex
    peersByNodeAddr = new Map(); // by NodeAddr hex
    sessions = new Map(); // by remote NodeAddr hex
    listeners = new Map();
    started = false;
    constructor(cfg) {
        this.identity = cfg.identity;
        this.transports = cfg.transports;
        this.forwarding = cfg.forwarding ?? false;
        this.random = cfg.random ?? defaultRandom;
        this.logger = cfg.logger ?? noopLogger;
        for (const s of cfg.services ?? []) {
            this.services.set(s.port, s.handler);
        }
    }
    async start() {
        if (this.started)
            return;
        for (const t of this.transports) {
            await t.start({
                localIdentity: this.identity,
                onPacket: (p) => this.onTransportPacket(t, p),
                onConnectionState: (e) => this.onTransportConn(t, e),
                logger: this.logger,
            });
        }
        this.started = true;
    }
    async stop() {
        if (!this.started)
            return;
        for (const t of this.transports) {
            try {
                await t.stop();
            }
            catch (err) {
                this.emit("error", { err: err, where: "transport.stop" });
            }
        }
        this.peers.clear();
        this.peersByPubkey.clear();
        this.peersByNodeAddr.clear();
        this.sessions.clear();
        this.started = false;
    }
    registerService(port, handler) {
        this.services.set(port, handler);
        return () => {
            if (this.services.get(port) === handler)
                this.services.delete(port);
        };
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
        const key = transportAddressKey(addr);
        if (this.peers.has(key) && this.peers.get(key).link.state === "established")
            return;
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
            pubkeyHex: addr.addr,
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
        await transport.send(addr, msg1.packet);
        this.logger.debug("fips msg1 sent", addr.transport, addr.addr, msg1.packet.length);
        const timer = setTimeout(() => {
            this.logger.warn("fips handshake timeout", addr.transport, addr.addr);
            peer.outgoingHandshake?.reject(new Error("FMP handshake timeout"));
        }, 15_000);
        try {
            await handshakeDone;
        }
        finally {
            clearTimeout(timer);
        }
    }
    /** Send a service datagram to a target identity (adjacent or routable). */
    async sendDatagram(args) {
        const session = await this.ensureSession(args.dst);
        const fspFrame = session.fsp.encryptDatagram({
            srcPort: args.srcPort ?? 0,
            dstPort: args.dstPort,
            payload: args.payload,
        });
        await this.sendFspToward(session.remoteNodeAddr, fspFrame);
    }
    /** Send app-owned endpoint bytes to a target identity without service ports. */
    async sendEndpointData(args) {
        const session = await this.ensureSession(args.dst);
        const fspFrame = session.fsp.encryptEndpointData(args.payload);
        await this.sendFspToward(session.remoteNodeAddr, fspFrame);
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
                this.peers.delete(key);
                this.peersByPubkey.delete(peer.pubkeyHex);
                if (peer.pubkey.length > 0) {
                    this.peersByNodeAddr.delete(nodeAddrToHex(deriveNodeAddr(peer.pubkey)));
                }
                for (const [nodeHex, session] of this.sessions) {
                    if (session.remotePubkeyHex === peer.pubkeyHex) {
                        this.sessions.delete(nodeHex);
                        this.emit("session", { remotePubkey: peer.pubkeyHex, state: "closed" });
                    }
                }
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
            const phase = peekFmpPhase(p.data);
            this.logger.debug("fips packet received", p.remoteAddr.transport, p.remoteAddr.addr, p.data.length, phase);
            const key = transportAddressKey(p.remoteAddr);
            let peer = this.peers.get(key);
            switch (phase) {
                case FMP_PHASE_MSG1: {
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
                    const result = peer.link.handleMsg1(p.data, (n) => this.random.bytes(n));
                    peer.pubkey = result.remotePubkey;
                    peer.pubkeyHex = toHex(result.remotePubkey);
                    this.rememberPeer(peer);
                    if (result.reply) {
                        void transport.send(p.remoteAddr, result.reply).catch((err) => {
                            this.emit("error", { err: err, where: "send Msg2" });
                        });
                        this.logger.debug("fips msg2 sent", p.remoteAddr.transport, p.remoteAddr.addr, result.reply.length);
                    }
                    this.emit("peer", {
                        remotePubkey: peer.pubkeyHex,
                        remoteAddr: peer.remoteAddr,
                        state: "connected",
                    });
                    break;
                }
                case FMP_PHASE_MSG2: {
                    if (!peer)
                        throw new Error("FMP Msg2 with no peer state");
                    peer.link.handleMsg2(p.data);
                    peer.pubkey = peer.link.remotePubkey;
                    peer.pubkeyHex = toHex(peer.link.remotePubkey);
                    this.rememberPeer(peer);
                    this.emit("peer", {
                        remotePubkey: peer.pubkeyHex,
                        remoteAddr: peer.remoteAddr,
                        state: "connected",
                    });
                    peer.outgoingHandshake?.resolve();
                    peer.outgoingHandshake = undefined;
                    this.logger.debug("fips msg2 handled", p.remoteAddr.transport, p.remoteAddr.addr);
                    break;
                }
                case FMP_PHASE_ESTABLISHED: {
                    if (!peer || peer.link.state !== "established") {
                        throw new Error("FMP Established before handshake complete");
                    }
                    const { msgType, payload } = peer.link.decryptIncoming(p.data);
                    this.routeIncomingLinkMessage(peer, msgType, payload).catch((err) => {
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
    async routeIncomingLinkMessage(peer, msgType, payload) {
        if (msgType !== LinkMessageType.SessionDatagram) {
            if (isKnownUnhandledLinkMessage(msgType))
                return;
            this.logger.warn("unsupported FMP link message", msgType);
            return;
        }
        const datagram = decodeSessionDatagramPayload(payload);
        if (bytesEqual(datagram.destAddr, this.identity.nodeAddr)) {
            await this.handleFspFromPeer(peer, datagram.srcAddr, datagram.payload);
            return;
        }
        if (!this.forwarding) {
            this.logger.warn("dropping SessionDatagram; forwarding=false");
            return;
        }
        if (datagram.ttl <= 1) {
            this.logger.warn("dropping SessionDatagram; ttl exhausted");
            return;
        }
        await this.sendSessionDatagram({
            ...datagram,
            ttl: datagram.ttl - 1,
        });
    }
    async handleFspFromPeer(_peer, srcNodeAddr, fspFrame) {
        const phase = peekFspPhase(fspFrame);
        const srcNodeHex = nodeAddrToHex(srcNodeAddr);
        let session = this.sessions.get(srcNodeHex);
        if (phase === FSP_PHASE_ESTABLISHED) {
            if (!session || session.fsp.state !== "established") {
                throw new Error(`FSP Established before handshake from ${srcNodeHex}`);
            }
            const result = session.fsp.decryptIncoming(fspFrame);
            const srcHex = session.remotePubkeyHex ?? srcNodeHex;
            if (result.msgType === FSP_MSG_DATA && result.data) {
                const dp = result.data;
                const handler = this.services.get(dp.dstPort);
                const reply = async (data, replyPort) => {
                    await this.sendDatagram({
                        dst: srcHex,
                        srcPort: dp.dstPort,
                        dstPort: replyPort ?? dp.srcPort,
                        payload: data,
                    });
                };
                this.emit("datagram", {
                    src: srcHex,
                    dst: toHex(this.identity.publicKey),
                    srcPort: dp.srcPort,
                    dstPort: dp.dstPort,
                    payload: dp.payload,
                });
                if (handler)
                    await handler({ src: srcHex, srcPort: dp.srcPort, dstPort: dp.dstPort, payload: dp.payload, reply });
            }
            if (result.msgType === FSP_MSG_ENDPOINT_DATA && result.endpointData) {
                this.emit("endpointData", {
                    src: srcHex,
                    dst: toHex(this.identity.publicKey),
                    payload: result.endpointData,
                });
            }
            return;
        }
        // Handshake phases 1/2/3.
        if (phase === 1) {
            const fsp = new FspSession({ identity: this.identity, role: "responder" });
            const reply = fsp.handleSessionSetup(fspFrame, (n) => this.random.bytes(n), this.identity.nodeAddr);
            session = { remoteNodeAddr: srcNodeAddr, fsp };
            this.sessions.set(srcNodeHex, session);
            this.emit("session", { remotePubkey: srcNodeHex, state: "establishing" });
            await this.sendFspToward(srcNodeAddr, reply);
            return;
        }
        if (phase === 2) {
            if (!session)
                throw new Error(`FSP msg2 with no session ${srcNodeHex}`);
            const reply = session.fsp.handleSessionAck(fspFrame, (n) => this.random.bytes(n));
            const eventPubkey = session.remotePubkeyHex ?? srcNodeHex;
            this.emit("session", { remotePubkey: eventPubkey, state: "established" });
            await this.sendFspToward(srcNodeAddr, reply);
            session.setupResolve?.();
            session.setupResolve = undefined;
            session.setupReject = undefined;
            return;
        }
        if (phase === 3) {
            if (!session)
                throw new Error(`FSP msg3 with no session ${srcNodeHex}`);
            session.fsp.handleSessionMsg3(fspFrame);
            if (session.fsp.remotePubkey) {
                session.remotePubkey = session.fsp.remotePubkey;
                session.remotePubkeyHex = toHex(session.fsp.remotePubkey);
            }
            this.emit("session", {
                remotePubkey: session.remotePubkeyHex ?? srcNodeHex,
                state: "established",
            });
            return;
        }
        throw new Error(`unknown FSP phase ${phase}`);
    }
    async ensureSession(remotePubkeyHex) {
        const remotePubkey = hexBytes(remotePubkeyHex);
        const remoteNodeAddr = deriveNodeAddr(remotePubkey);
        const remoteNodeHex = nodeAddrToHex(remoteNodeAddr);
        let session = this.sessions.get(remoteNodeHex);
        if (session && session.fsp.state === "established")
            return session;
        if (session && session.fsp.state === "handshaking") {
            await new Promise((resolve, reject) => {
                session.setupResolve = resolve;
                session.setupReject = reject;
            });
            return session;
        }
        const fsp = new FspSession({
            identity: this.identity,
            role: "initiator",
            remotePubkey,
        });
        session = { remoteNodeAddr, remotePubkeyHex, remotePubkey, fsp };
        this.sessions.set(remoteNodeHex, session);
        this.emit("session", { remotePubkey: remotePubkeyHex, state: "establishing" });
        const msg1 = fsp.buildSessionSetup((n) => this.random.bytes(n), this.identity.nodeAddr, remoteNodeAddr);
        await this.sendFspToward(remoteNodeAddr, msg1);
        await new Promise((resolve, reject) => {
            session.setupResolve = resolve;
            session.setupReject = reject;
            setTimeout(() => reject(new Error("FSP handshake timeout")), 15_000);
        });
        return session;
    }
    /**
     * Wrap an FSP frame in a SessionDatagram and send it toward a remote NodeAddr.
     */
    async sendFspToward(remoteNodeAddr, fspFrame) {
        await this.sendSessionDatagram({
            ttl: 64,
            pathMtu: 1200,
            srcAddr: this.identity.nodeAddr,
            destAddr: remoteNodeAddr,
            payload: fspFrame,
        });
    }
    async sendSessionDatagram(datagram) {
        const destNodeHex = nodeAddrToHex(datagram.destAddr);
        const direct = this.peersByNodeAddr.get(destNodeHex);
        if (direct && direct.link.state === "established") {
            const encoded = encodeSessionDatagram(datagram);
            const outer = direct.link.encryptOutgoing(encoded.subarray(1), LinkMessageType.SessionDatagram);
            await direct.transport.send(direct.remoteAddr, outer);
            return;
        }
        for (const peer of this.peersByPubkey.values()) {
            if (peer.link.state === "established") {
                const encoded = encodeSessionDatagram(datagram);
                const outer = peer.link.encryptOutgoing(encoded.subarray(1), LinkMessageType.SessionDatagram);
                await peer.transport.send(peer.remoteAddr, outer);
                return;
            }
        }
        throw new Error(`no route to ${destNodeHex}`);
    }
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
function isKnownUnhandledLinkMessage(msgType) {
    return (msgType === LinkMessageType.Heartbeat ||
        msgType === LinkMessageType.Disconnect ||
        msgType === LinkMessageType.SenderReport ||
        msgType === LinkMessageType.ReceiverReport ||
        msgType === LinkMessageType.TreeAnnounce ||
        msgType === LinkMessageType.FilterAnnounce ||
        msgType === LinkMessageType.LookupRequest ||
        msgType === LinkMessageType.LookupResponse);
}
//# sourceMappingURL=FipsNode.js.map