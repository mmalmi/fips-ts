import { bytesEqual, toHex } from "../codec/hex.js";
import { segmentDirectFspTransportRecord, } from "../fsp/directTransport.js";
import { FspSession } from "../fsp/session.js";
import { decodeFspEstablished, FSP_FLAG_DIRECT_TRANSPORT, FSP_FLAG_K, FSP_MSG_DATA, FSP_MSG_ENDPOINT_DATA, FSP_PHASE_ESTABLISHED, peekFspPhase, } from "../fsp/wire.js";
import { deriveNodeAddr, nodeAddrToHex, } from "../nodeaddr/index.js";
const FSP_REKEY_DRAIN_MS = 45_000;
const FSP_DEFAULT_PATH_MTU = 1_200;
export class FspSessionManager {
    cfg;
    services = new Map();
    sessions = new Map();
    constructor(cfg) {
        this.cfg = cfg;
    }
    registerService(port, handler) {
        this.services.set(port, handler);
        return () => {
            if (this.services.get(port) === handler)
                this.services.delete(port);
        };
    }
    stop() {
        for (const session of this.sessions.values()) {
            session.fsp.close();
            session.pendingResponderFsp?.close();
            session.previousFsp?.fsp.close();
        }
        this.sessions.clear();
    }
    closePeerSessions(remotePubkeyHex) {
        for (const [nodeHex, session] of this.sessions) {
            if (session.remotePubkeyHex !== remotePubkeyHex)
                continue;
            this.sessions.delete(nodeHex);
            this.cfg.emitSession({ remotePubkey: remotePubkeyHex, state: "closed" });
        }
    }
    async sendDatagram(args) {
        const session = await this.ensureSession(args.dst);
        const directPeer = this.directPeerForSession(session);
        const epochFlag = session.currentKBit ? FSP_FLAG_K : 0;
        const fspFrame = session.fsp.encryptDatagram({
            srcPort: args.srcPort ?? 0,
            dstPort: args.dstPort,
            payload: args.payload,
        }, epochFlag | (directPeer ? FSP_FLAG_DIRECT_TRANSPORT : 0));
        if (directPeer)
            await this.sendDirectFsp(directPeer, fspFrame);
        else
            await this.cfg.routing.sendFspToward(session.remoteNodeAddr, fspFrame);
    }
    async sendEndpointData(args) {
        const session = await this.ensureSession(args.dst);
        const directPeer = this.directPeerForSession(session);
        const epochFlag = session.currentKBit ? FSP_FLAG_K : 0;
        const fspFrame = session.fsp.encryptEndpointData(args.payload, epochFlag | (directPeer ? FSP_FLAG_DIRECT_TRANSPORT : 0));
        if (directPeer)
            await this.sendDirectFsp(directPeer, fspFrame);
        else
            await this.cfg.routing.sendFspToward(session.remoteNodeAddr, fspFrame);
    }
    async handleFromPeer(peer, srcNodeAddr, fspFrame) {
        const phase = peekFspPhase(fspFrame);
        const srcNodeHex = nodeAddrToHex(srcNodeAddr);
        const session = this.sessions.get(srcNodeHex);
        if (phase === FSP_PHASE_ESTABLISHED) {
            await this.handleEstablished(peer, srcNodeHex, session, fspFrame);
            return;
        }
        if (phase === 1) {
            await this.handleSessionSetup(peer, srcNodeAddr, srcNodeHex, session, fspFrame);
            return;
        }
        if (phase === 2) {
            if (!session)
                throw new Error(`FSP msg2 with no session ${srcNodeHex}`);
            const reply = session.fsp.handleSessionAck(fspFrame, (n) => this.cfg.random.bytes(n));
            const eventPubkey = session.remotePubkeyHex ?? srcNodeHex;
            this.cfg.emitSession({ remotePubkey: eventPubkey, state: "established" });
            await this.cfg.routing.sendFspToward(srcNodeAddr, reply);
            session.setupResolve?.();
            session.setupResolve = undefined;
            session.setupReject = undefined;
            return;
        }
        if (phase === 3) {
            if (!session)
                throw new Error(`FSP msg3 with no session ${srcNodeHex}`);
            this.handleSessionMsg3(peer, srcNodeAddr, srcNodeHex, session, fspFrame);
            return;
        }
        throw new Error(`unknown FSP phase ${phase}`);
    }
    async handleEstablished(peer, srcNodeHex, session, fspFrame) {
        if (!session || session.fsp.state !== "established") {
            throw new Error(`FSP Established before handshake from ${srcNodeHex}`);
        }
        this.prunePreviousFsp(session, Date.now());
        const established = decodeFspEstablished(fspFrame);
        const receivedKBit = (established.flags & FSP_FLAG_K) !== 0;
        let receiveFsp = session.fsp;
        let promotePending = false;
        if (receivedKBit !== session.currentKBit) {
            if (session.pendingResponderFsp?.state === "established") {
                receiveFsp = session.pendingResponderFsp;
                promotePending = true;
            }
            else if (session.previousFsp?.kBit === receivedKBit) {
                receiveFsp = session.previousFsp.fsp;
            }
            else {
                throw new Error(`FSP Established epoch mismatch: receivedK=${Number(receivedKBit)}`
                    + ` currentK=${Number(session.currentKBit)}`);
            }
        }
        const result = receiveFsp.decryptIncoming(fspFrame);
        this.cfg.routing.learnReverseRoute(srcNodeHex, peer);
        if (promotePending)
            this.promotePendingSession(session, receiveFsp, receivedKBit, srcNodeHex);
        const srcHex = session.remotePubkeyHex ?? srcNodeHex;
        if (result.msgType === FSP_MSG_DATA && result.data) {
            await this.deliverDatagram(srcHex, result.data);
        }
        if (result.msgType === FSP_MSG_ENDPOINT_DATA && result.endpointData) {
            this.cfg.emitEndpointData({
                src: srcHex,
                dst: toHex(this.cfg.identity.publicKey),
                payload: result.endpointData,
            });
        }
    }
    promotePendingSession(session, receiveFsp, receivedKBit, srcNodeHex) {
        session.previousFsp?.fsp.close();
        session.previousFsp = {
            fsp: session.fsp,
            kBit: session.currentKBit,
            expiresAtMs: Date.now() + FSP_REKEY_DRAIN_MS,
        };
        session.fsp = receiveFsp;
        session.currentKBit = receivedKBit;
        session.pendingResponderFsp = undefined;
        if (receiveFsp.remotePubkey) {
            session.remotePubkey = receiveFsp.remotePubkey;
            session.remotePubkeyHex = toHex(receiveFsp.remotePubkey);
        }
        this.cfg.logger.debug("promoted authenticated FSP rekey epoch", srcNodeHex, receivedKBit);
    }
    async deliverDatagram(srcHex, datagram) {
        const handler = this.services.get(datagram.dstPort);
        const reply = async (data, replyPort) => {
            await this.sendDatagram({
                dst: srcHex,
                srcPort: datagram.dstPort,
                dstPort: replyPort ?? datagram.srcPort,
                payload: data,
            });
        };
        this.cfg.emitDatagram({
            src: srcHex,
            dst: toHex(this.cfg.identity.publicKey),
            srcPort: datagram.srcPort,
            dstPort: datagram.dstPort,
            payload: datagram.payload,
        });
        if (handler) {
            await handler({
                src: srcHex,
                srcPort: datagram.srcPort,
                dstPort: datagram.dstPort,
                payload: datagram.payload,
                reply,
            });
        }
    }
    async handleSessionSetup(peer, srcNodeAddr, srcNodeHex, session, fspFrame) {
        let reply;
        if (session?.pendingResponderFsp?.matchesSessionSetup(fspFrame)) {
            reply = session.pendingResponderFsp.handleSessionSetup(fspFrame, (n) => this.cfg.random.bytes(n), this.cfg.routing.coords);
        }
        else if (session?.fsp.matchesSessionSetup(fspFrame)) {
            reply = session.fsp.handleSessionSetup(fspFrame, (n) => this.cfg.random.bytes(n), this.cfg.routing.coords);
        }
        else if (session?.fsp.state === "established") {
            const pending = new FspSession({ identity: this.cfg.identity, role: "responder" });
            reply = pending.handleSessionSetup(fspFrame, (n) => this.cfg.random.bytes(n), this.cfg.routing.coords);
            session.pendingResponderFsp?.close();
            session.pendingResponderFsp = pending;
        }
        else {
            const fsp = new FspSession({ identity: this.cfg.identity, role: "responder" });
            reply = fsp.handleSessionSetup(fspFrame, (n) => this.cfg.random.bytes(n), this.cfg.routing.coords);
            session = { remoteNodeAddr: srcNodeAddr, fsp, currentKBit: false };
            this.sessions.set(srcNodeHex, session);
            this.cfg.emitSession({ remotePubkey: srcNodeHex, state: "establishing" });
        }
        await this.cfg.routing.sendFspReplyToward(srcNodeAddr, reply, peer);
    }
    handleSessionMsg3(peer, srcNodeAddr, srcNodeHex, session, fspFrame) {
        const handshakeFsp = session.pendingResponderFsp ?? session.fsp;
        handshakeFsp.handleSessionMsg3(fspFrame);
        if (handshakeFsp.remotePubkey) {
            if (!bytesEqual(deriveNodeAddr(handshakeFsp.remotePubkey), srcNodeAddr)) {
                handshakeFsp.close();
                if (session.pendingResponderFsp === handshakeFsp) {
                    session.pendingResponderFsp = undefined;
                }
                else {
                    this.sessions.delete(srcNodeHex);
                }
                throw new Error("FSP msg3 authenticated key does not match claimed source NodeAddr");
            }
            if (session.remotePubkey && !bytesEqual(session.remotePubkey, handshakeFsp.remotePubkey)) {
                throw new Error("FSP rekey changed the authenticated remote identity");
            }
            session.remotePubkey = handshakeFsp.remotePubkey;
            session.remotePubkeyHex = toHex(handshakeFsp.remotePubkey);
        }
        this.cfg.routing.learnReverseRoute(srcNodeHex, peer);
        this.cfg.emitSession({
            remotePubkey: session.remotePubkeyHex ?? srcNodeHex,
            state: "established",
        });
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
        const directPeer = this.cfg.getPeerByNodeAddr(remoteNodeHex);
        if (directPeer?.link.state !== "established"
            && !this.cfg.routing.coordinatesFor(remoteNodeHex)) {
            await this.cfg.routing.ensureFirstContactRoute(remoteNodeAddr, remoteNodeHex, remotePubkey);
        }
        const fsp = new FspSession({
            identity: this.cfg.identity,
            role: "initiator",
            remotePubkey,
        });
        session = { remoteNodeAddr, remotePubkeyHex, remotePubkey, fsp, currentKBit: false };
        this.sessions.set(remoteNodeHex, session);
        this.cfg.emitSession({ remotePubkey: remotePubkeyHex, state: "establishing" });
        const msg1 = fsp.buildSessionSetup((n) => this.cfg.random.bytes(n), this.cfg.routing.coords, this.cfg.routing.coordinatesFor(remoteNodeHex) ?? [remoteNodeAddr]);
        let timer;
        const setupDone = new Promise((resolve, reject) => {
            session.setupResolve = resolve;
            session.setupReject = reject;
            timer = setTimeout(() => reject(new Error("FSP handshake timeout")), 15_000);
        });
        try {
            await this.cfg.routing.sendFspToward(remoteNodeAddr, msg1);
            await setupDone;
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
        return session;
    }
    prunePreviousFsp(session, nowMs) {
        if (!session.previousFsp || session.previousFsp.expiresAtMs > nowMs)
            return;
        session.previousFsp.fsp.close();
        session.previousFsp = undefined;
    }
    directPeerForSession(session) {
        const peer = this.cfg.getPeerByNodeAddr(nodeAddrToHex(session.remoteNodeAddr));
        return peer?.link.state === "established" ? peer : undefined;
    }
    async sendDirectFsp(peer, fspFrame) {
        const pathMtu = Math.min(peer.transport.mtu, FSP_DEFAULT_PATH_MTU);
        const packets = segmentDirectFspTransportRecord(fspFrame, pathMtu);
        for (const packet of packets) {
            await peer.transport.send(peer.remoteAddr, packet);
        }
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
//# sourceMappingURL=FspSessionManager.js.map