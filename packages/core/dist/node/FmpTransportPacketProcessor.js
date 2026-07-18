import { bytesEqual, toHex } from "../codec/hex.js";
import { FmpLink } from "../fmp/link.js";
import { DirectFspTransportReassembler, isDirectFspTransportFragment, } from "../fsp/directTransport.js";
import { isDirectFspEstablished } from "../fsp/wire.js";
import { compareNodeAddr, deriveNodeAddr, nodeAddrToHex } from "../nodeaddr/index.js";
import { decodeFmpEstablished, decodeFmpMsg2, FMP_PHASE_ESTABLISHED, FMP_PHASE_MSG1, FMP_PHASE_MSG2, peekFmpPhase, } from "../fmp/wire.js";
import { transportAddressKey, } from "../transport/types.js";
const FMP_REPLACED_LINK_DRAIN_MS = 10_000;
const FMP_REMOTE_EPOCH_HISTORY_LIMIT = 8;
export class FmpTransportPacketProcessor {
    cfg;
    reassembler = new DirectFspTransportReassembler();
    remoteEpochHistory = new Map();
    constructor(cfg) {
        this.cfg = cfg;
    }
    clear() {
        this.reassembler.clear();
        this.remoteEpochHistory.clear();
    }
    process(transport, received) {
        try {
            const key = transportAddressKey(received.remoteAddr);
            const peer = this.cfg.peers.get(key)
                ?? this.findXOnlyTransportPeer(transport, received.remoteAddr);
            let packet = received.data;
            if (isDirectFspTransportFragment(packet)) {
                if (!peer || peer.link.state !== "established" || peer.pubkey.length === 0) {
                    throw new Error("direct FSP fragment before adjacent link handshake complete");
                }
                const reassembled = this.reassembler.ingest(key, packet, received.receivedAtMs);
                if (!reassembled)
                    return;
                packet = reassembled;
            }
            if (isDirectFspEstablished(packet)) {
                if (!peer || peer.link.state !== "established" || peer.pubkey.length === 0) {
                    throw new Error("direct FSP before adjacent link handshake complete");
                }
                void this.cfg.sessionManager
                    .handleFromPeer(peer, deriveNodeAddr(peer.pubkey), packet)
                    .catch((error) => this.cfg.emitError(error, "direct-fsp"));
                return;
            }
            const phase = peekFmpPhase(packet);
            this.cfg.logger.debug("fips packet received", received.remoteAddr.transport, received.remoteAddr.addr, packet.length, phase);
            if (phase === FMP_PHASE_MSG1) {
                this.handleMsg1(transport, received.remoteAddr, key, peer, packet);
                return;
            }
            if (phase === FMP_PHASE_MSG2) {
                this.handleMsg2(transport, received.remoteAddr, peer, packet);
                return;
            }
            if (phase === FMP_PHASE_ESTABLISHED) {
                this.handleEstablished(received.remoteAddr, peer, packet);
                return;
            }
            throw new Error(`unknown FMP phase ${phase}`);
        }
        catch (error) {
            this.cfg.emitError(error, "onTransportPacket");
            this.cfg.logger.warn("transport packet error", error);
        }
    }
    handleMsg1(transport, remoteAddr, key, initialPeer, packet) {
        const prepared = this.prepareMsg1Peer(transport, remoteAddr, key, initialPeer);
        if (!prepared)
            return;
        let { peer } = prepared;
        const { peerEpochBeforeMsg1, replacedEstablishedInitiator, replacedHandshake, stageEstablishedInitiator, } = prepared;
        let wasEstablished = replacedEstablishedInitiator || peer.link.state === "established";
        let result;
        let handshakeLink;
        if (stageEstablishedInitiator) {
            result = this.stageResponderReplacement(peer, packet);
            handshakeLink = peer.pendingResponderLink;
            this.cfg.logger.debug("staged responder link for established initiator", remoteAddr.transport, remoteAddr.addr);
        }
        else if (peer.link.state === "established") {
            try {
                result = peer.link.handleMsg1(packet, this.cfg.randomBytes);
                handshakeLink = peer.link;
            }
            catch (error) {
                if (!(error instanceof Error)
                    || error.message !== "unexpected FMP Msg1 after establishment") {
                    throw error;
                }
                result = this.stageResponderReplacement(peer, packet);
                handshakeLink = peer.pendingResponderLink;
                this.cfg.logger.debug("staged responder link after fresh authenticated Msg1", remoteAddr.transport, remoteAddr.addr);
            }
        }
        else {
            result = peer.link.handleMsg1(packet, this.cfg.randomBytes);
            handshakeLink = peer.link;
        }
        const remotePubkeyHex = toHex(result.remotePubkey);
        const previousRemoteEpoch = peerEpochBeforeMsg1
            ?? this.establishedRemoteEpoch(remotePubkeyHex, handshakeLink);
        const candidateEpoch = handshakeLink.remoteEpoch;
        const changedEpoch = previousRemoteEpoch !== undefined
            && candidateEpoch !== undefined
            && !bytesEqual(previousRemoteEpoch, candidateEpoch);
        if (this.rejectRetiredEpoch(peer, handshakeLink, remotePubkeyHex, candidateEpoch, changedEpoch, remoteAddr))
            return;
        if (changedEpoch) {
            this.removeRestartedPeerPaths(remotePubkeyHex, handshakeLink, transport, replacedHandshake);
            peer = {
                pubkey: result.remotePubkey,
                pubkeyHex: remotePubkeyHex,
                remoteAddr,
                transport,
                link: handshakeLink,
            };
            this.cfg.peers.set(key, peer);
            wasEstablished = false;
            this.cfg.logger.info("FMP peer restart detected", remotePubkeyHex);
        }
        else if (replacedHandshake && peer.link !== handshakeLink) {
            peer.abandonedInitiatorSessionIdx = peer.link.localSessionIdx;
            peer.link.close();
            peer.link = handshakeLink;
            peer.pendingResponderLink = undefined;
        }
        peer.pubkey = result.remotePubkey;
        peer.pubkeyHex = remotePubkeyHex;
        this.rememberPeer(peer);
        const reply = result.reply;
        let replySent;
        if (reply) {
            replySent = transport.send(remoteAddr, reply);
            void replySent.catch((error) => {
                this.cfg.emitError(error, "send Msg2");
            });
            this.cfg.logger.debug("fips msg2 sent", remoteAddr.transport, remoteAddr.addr, reply.length);
        }
        if (replacedHandshake) {
            peer.outgoingHandshake = undefined;
            replacedHandshake.resolve();
        }
        if (!wasEstablished) {
            this.cfg.emitPeer({
                remotePubkey: peer.pubkeyHex,
                remoteAddr: peer.remoteAddr,
                state: "connected",
            });
            this.replayPendingLookupsAfterEstablishment(peer, replySent);
        }
    }
    prepareMsg1Peer(transport, remoteAddr, key, initialPeer) {
        let peer = initialPeer;
        const peerEpochBeforeMsg1 = peer?.link.remoteEpoch?.slice();
        let replacedEstablishedInitiator = false;
        let replacedHandshake;
        let stageEstablishedInitiator = false;
        if (peer?.link.role === "initiator" && peer.outgoingHandshake) {
            if (peer.pubkey.length === 0) {
                throw new Error("outbound FMP peer is missing its expected identity");
            }
            const order = compareNodeAddr(this.cfg.identity.nodeAddr, deriveNodeAddr(peer.pubkey));
            if (order < 0) {
                this.cfg.logger.debug("simultaneous FMP handshake: local initiator wins", remoteAddr.transport, remoteAddr.addr);
                return undefined;
            }
            if (order === 0)
                throw new Error("simultaneous FMP handshake with local identity");
            replacedEstablishedInitiator = peer.link.state === "established";
            replacedHandshake = peer.outgoingHandshake;
            stageEstablishedInitiator = true;
            this.cfg.logger.debug("simultaneous FMP handshake: staging remote initiator winner", remoteAddr.transport, remoteAddr.addr);
        }
        else if (peer?.link.role === "initiator") {
            stageEstablishedInitiator = true;
        }
        if (!peer) {
            peer = {
                pubkey: new Uint8Array(0),
                pubkeyHex: "",
                remoteAddr,
                transport,
                link: this.newResponderLink(),
            };
            this.cfg.peers.set(key, peer);
        }
        return {
            peer,
            peerEpochBeforeMsg1,
            replacedEstablishedInitiator,
            replacedHandshake,
            stageEstablishedInitiator,
        };
    }
    rejectRetiredEpoch(peer, handshakeLink, remotePubkeyHex, candidateEpoch, changedEpoch, remoteAddr) {
        if (!changedEpoch || !candidateEpoch)
            return false;
        if (!this.isRetiredRemoteEpoch(remotePubkeyHex, candidateEpoch))
            return false;
        handshakeLink.close();
        if (peer.pendingResponderLink === handshakeLink)
            peer.pendingResponderLink = undefined;
        this.cfg.logger.debug("ignored FMP Msg1 from a retired startup epoch", remoteAddr.transport, remoteAddr.addr);
        return true;
    }
    handleMsg2(transport, remoteAddr, addressedPeer, packet) {
        const msg2 = decodeFmpMsg2(packet);
        const peer = this.matchMsg2Peer(msg2.receiverIdx);
        if (!peer) {
            if (addressedPeer?.abandonedInitiatorSessionIdx === msg2.receiverIdx) {
                addressedPeer.abandonedInitiatorSessionIdx = undefined;
                this.cfg.logger.debug("ignored Msg2 for abandoned simultaneous FMP initiator", remoteAddr.transport, remoteAddr.addr);
                return;
            }
            this.cfg.logger.debug("ignored Msg2 with no pending FMP initiator", remoteAddr.transport, remoteAddr.addr, msg2.receiverIdx);
            return;
        }
        const wasEstablished = peer.link.state === "established";
        const previousRemoteEpoch = this.establishedRemoteEpoch(peer.pubkeyHex, peer.link);
        const restartedHandshake = peer.outgoingHandshake;
        peer.link.handleMsg2(packet);
        peer.pubkey = peer.link.remotePubkey;
        peer.pubkeyHex = toHex(peer.link.remotePubkey);
        const candidateEpoch = peer.link.remoteEpoch;
        const changedEpoch = previousRemoteEpoch !== undefined
            && candidateEpoch !== undefined
            && !bytesEqual(previousRemoteEpoch, candidateEpoch);
        if (changedEpoch && candidateEpoch) {
            if (this.isRetiredRemoteEpoch(peer.pubkeyHex, candidateEpoch)) {
                this.rejectRetiredMsg2Peer(peer, remoteAddr);
                return;
            }
            this.removeRestartedPeerPaths(peer.pubkeyHex, peer.link, transport, restartedHandshake);
            this.cfg.peers.set(transportAddressKey(peer.remoteAddr), peer);
            this.cfg.logger.info("FMP peer restart detected", peer.pubkeyHex);
        }
        this.retireDisplacedMsg2Peer(remoteAddr, peer);
        this.rememberPeer(peer);
        if (!wasEstablished) {
            this.cfg.emitPeer({
                remotePubkey: peer.pubkeyHex,
                remoteAddr: peer.remoteAddr,
                state: "connected",
            });
            peer.outgoingHandshake?.resolve();
            peer.outgoingHandshake = undefined;
            this.cfg.routing.scheduleTreeAnnounce(peer);
            this.replayPendingLookupsAfterEstablishment(peer);
        }
        this.cfg.logger.debug("fips msg2 handled", remoteAddr.transport, remoteAddr.addr);
    }
    replayPendingLookupsAfterEstablishment(peer, establishmentReply) {
        const replay = () => {
            void this.cfg.routing.replayPendingLookupsFor(peer).catch((error) => {
                this.cfg.emitError(error, "replay pending lookups");
            });
        };
        if (establishmentReply)
            void establishmentReply.then(replay, () => undefined);
        else
            replay();
    }
    matchMsg2Peer(receiverIdx) {
        const matches = new Set();
        for (const candidate of this.cfg.peers.values()) {
            if (candidate.outgoingHandshake
                && candidate.link.role === "initiator"
                && candidate.link.localSessionIdx === receiverIdx) {
                matches.add(candidate);
            }
        }
        return matches.size === 1 ? matches.values().next().value : undefined;
    }
    retireDisplacedMsg2Peer(remoteAddr, peer) {
        const key = transportAddressKey(remoteAddr);
        const displaced = this.cfg.peers.get(key);
        if (!displaced || displaced === peer)
            return;
        for (const [candidateKey, candidate] of this.cfg.peers) {
            if (candidate === displaced)
                this.cfg.peers.delete(candidateKey);
        }
        this.drainAuthenticatedLink(peer, displaced.link);
        if (displaced.pendingResponderLink) {
            this.drainAuthenticatedLink(peer, displaced.pendingResponderLink);
        }
        for (const draining of displaced.drainingResponderLinks?.values() ?? []) {
            this.drainAuthenticatedLink(peer, draining.link, draining.expiresAtMs);
        }
        displaced.outgoingHandshake?.reject(new Error("authenticated FMP path replaced address alias"));
        if (this.cfg.peersByPubkey.get(displaced.pubkeyHex) === displaced) {
            this.cfg.peersByPubkey.delete(displaced.pubkeyHex);
        }
        if (displaced.pubkey.length > 0) {
            const nodeAddrHex = nodeAddrToHex(deriveNodeAddr(displaced.pubkey));
            if (this.cfg.peersByNodeAddr.get(nodeAddrHex) === displaced) {
                this.cfg.peersByNodeAddr.delete(nodeAddrHex);
            }
        }
    }
    drainAuthenticatedLink(peer, link, expiresAtMs = Date.now() + FMP_REPLACED_LINK_DRAIN_MS) {
        if (link === peer.link || link === peer.pendingResponderLink)
            return;
        if (link.state !== "established") {
            link.close();
            return;
        }
        const draining = peer.drainingResponderLinks ?? new Map();
        const existing = draining.get(link.localSessionIdx);
        if (existing && existing.link !== link) {
            link.close();
            return;
        }
        draining.set(link.localSessionIdx, { link, expiresAtMs });
        peer.drainingResponderLinks = draining;
    }
    handleEstablished(remoteAddr, _addressedPeer, packet) {
        const receiverIdx = decodeFmpEstablished(packet).receiverIdx;
        const match = this.matchEstablishedLink(receiverIdx);
        if (!match) {
            this.cfg.logger.debug("ignored FMP Established with no matching receiver index", remoteAddr.transport, remoteAddr.addr, receiverIdx);
            return;
        }
        const { peer, link, promotePending } = match;
        const { msgType, payload } = link.decryptIncoming(packet);
        this.cfg.routing.scheduleTreeAnnounce(peer);
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
            this.cfg.logger.debug("promoted authenticated responder link", remoteAddr.transport, remoteAddr.addr, receiverIdx);
        }
        this.cfg.routing.handleLinkMessage(peer, msgType, payload).catch((error) => {
            this.cfg.emitError(error, "link-message");
        });
    }
    matchEstablishedLink(receiverIdx) {
        const matches = new Map();
        const nowMs = Date.now();
        for (const peer of new Set(this.cfg.peers.values())) {
            this.pruneDrainingResponderLinks(peer, nowMs);
            if (peer.link.state === "established"
                && peer.link.localSessionIdx === receiverIdx) {
                matches.set(peer.link, { peer, link: peer.link, promotePending: false });
            }
            if (peer.pendingResponderLink?.state === "established"
                && peer.pendingResponderLink.localSessionIdx === receiverIdx) {
                matches.set(peer.pendingResponderLink, {
                    peer,
                    link: peer.pendingResponderLink,
                    promotePending: true,
                });
            }
            const draining = peer.drainingResponderLinks?.get(receiverIdx);
            if (draining) {
                matches.set(draining.link, { peer, link: draining.link, promotePending: false });
            }
        }
        if (matches.size > 1) {
            throw new Error(`ambiguous FMP Established receiver_idx ${receiverIdx}`);
        }
        return matches.values().next().value;
    }
    newResponderLink() {
        return new FmpLink({
            identity: this.cfg.identity,
            role: "responder",
            sessionIdx: this.cfg.nextSessionIdx(),
            localEpoch: this.cfg.startupEpoch,
        });
    }
    rememberPeer(peer) {
        if (peer.pubkey.length === 0 || !peer.pubkeyHex)
            return;
        this.cfg.peersByPubkey.set(peer.pubkeyHex, peer);
        this.cfg.peersByNodeAddr.set(nodeAddrToHex(deriveNodeAddr(peer.pubkey)), peer);
        if (peer.link.remoteEpoch)
            this.rememberRemoteEpoch(peer.pubkeyHex, peer.link.remoteEpoch);
    }
    rememberRemoteEpoch(remotePubkeyHex, epoch) {
        const encoded = toHex(epoch);
        const history = this.remoteEpochHistory.get(remotePubkeyHex) ?? [];
        if (history.includes(encoded))
            return;
        history.push(encoded);
        if (history.length > FMP_REMOTE_EPOCH_HISTORY_LIMIT)
            history.shift();
        this.remoteEpochHistory.set(remotePubkeyHex, history);
    }
    isRetiredRemoteEpoch(remotePubkeyHex, epoch) {
        return this.remoteEpochHistory.get(remotePubkeyHex)?.includes(toHex(epoch)) ?? false;
    }
    rejectRetiredMsg2Peer(peer, remoteAddr) {
        peer.link.close();
        for (const [key, candidate] of this.cfg.peers) {
            if (candidate === peer)
                this.cfg.peers.delete(key);
        }
        const alternate = [...this.cfg.peers.values()].find((candidate) => candidate !== peer
            && candidate.pubkeyHex === peer.pubkeyHex
            && candidate.link.state === "established");
        if (alternate) {
            this.rememberPeer(alternate);
            this.cfg.routing.scheduleTreeAnnounce(alternate);
        }
        else {
            if (this.cfg.peersByPubkey.get(peer.pubkeyHex) === peer) {
                this.cfg.peersByPubkey.delete(peer.pubkeyHex);
            }
            if (peer.pubkey.length > 0) {
                const nodeAddrHex = nodeAddrToHex(deriveNodeAddr(peer.pubkey));
                if (this.cfg.peersByNodeAddr.get(nodeAddrHex) === peer) {
                    this.cfg.peersByNodeAddr.delete(nodeAddrHex);
                }
            }
        }
        peer.outgoingHandshake?.reject(new Error("remote FIPS peer replied from a retired startup epoch"));
        peer.outgoingHandshake = undefined;
        this.cfg.logger.debug("ignored FMP Msg2 from a retired startup epoch", remoteAddr.transport, remoteAddr.addr);
    }
    findXOnlyTransportPeer(transport, remoteAddr) {
        if (!/^[0-9a-fA-F]{64}$/.test(remoteAddr.addr))
            return undefined;
        const xOnly = remoteAddr.addr.toLowerCase();
        for (const peer of this.cfg.peers.values()) {
            if (peer.transport !== transport || peer.pubkey.length !== 33)
                continue;
            if (peer.pubkeyHex.slice(2).toLowerCase() === xOnly)
                return peer;
        }
        return undefined;
    }
    establishedRemoteEpoch(remotePubkeyHex, excludingLink) {
        if (!remotePubkeyHex)
            return undefined;
        for (const candidate of this.cfg.peers.values()) {
            if (candidate.pubkeyHex !== remotePubkeyHex
                || candidate.link === excludingLink
                || candidate.link.state !== "established"
                || !candidate.link.remoteEpoch) {
                continue;
            }
            return candidate.link.remoteEpoch.slice();
        }
        return undefined;
    }
    removeRestartedPeerPaths(remotePubkeyHex, preserveLink, preserveTransport, preserveHandshake) {
        let remotePubkey;
        for (const [pathKey, candidate] of [...this.cfg.peers]) {
            if (candidate.pubkeyHex !== remotePubkeyHex)
                continue;
            remotePubkey = candidate.pubkey;
            this.cfg.peers.delete(pathKey);
            if (candidate.link !== preserveLink)
                candidate.link.close();
            if (candidate.pendingResponderLink !== preserveLink) {
                candidate.pendingResponderLink?.close();
            }
            for (const draining of candidate.drainingResponderLinks?.values() ?? []) {
                if (draining.link !== preserveLink)
                    draining.link.close();
            }
            if (candidate.outgoingHandshake && candidate.outgoingHandshake !== preserveHandshake) {
                candidate.outgoingHandshake.reject(new Error("remote FIPS peer restarted"));
                candidate.outgoingHandshake = undefined;
            }
        }
        this.cfg.peersByPubkey.delete(remotePubkeyHex);
        if (remotePubkey) {
            const remoteNodeAddr = deriveNodeAddr(remotePubkey);
            this.cfg.peersByNodeAddr.delete(nodeAddrToHex(remoteNodeAddr));
            this.cfg.routing.removePeer(remoteNodeAddr);
        }
        this.cfg.sessionManager.closePeerSessions(remotePubkeyHex);
        this.cfg.handlePeerRestart(remotePubkeyHex, preserveTransport);
    }
    stageResponderReplacement(peer, packet) {
        let replacement = peer.pendingResponderLink;
        if (replacement) {
            try {
                return replacement.handleMsg1(packet, this.cfg.randomBytes);
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
        replacement = this.newResponderLink();
        const result = replacement.handleMsg1(packet, this.cfg.randomBytes);
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
//# sourceMappingURL=FmpTransportPacketProcessor.js.map