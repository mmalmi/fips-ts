import { sha256 } from "@noble/hashes/sha256";
import { bytesEqual } from "../codec/hex.js";
import { signSchnorr, verifySchnorr, } from "../identity/index.js";
import { deriveNodeAddr, nodeAddrToHex, } from "../nodeaddr/index.js";
import { decodeSessionDatagramPayload, encodeSessionDatagram, LinkMessageType, SESSION_DATAGRAM_HEADER_SIZE, } from "../protocol/link.js";
import { decodeSessionAck, decodeSessionSetup } from "../protocol/session.js";
import { decodeFspEstablished, FSP_FLAG_CP } from "../fsp/wire.js";
import { FMP_AEAD_TAG_LEN, FMP_ESTABLISHED_HEADER_LEN } from "../fmp/wire.js";
import { decodeTreeAnnouncePayload, encodeTreeAnnounce, verifyTreeAnnounce, } from "../protocol/tree.js";
import { decodeLookupRequest, decodeLookupResponse, encodeLookupRequestPayload, encodeLookupResponsePayload, lookupResponseProofBytes, } from "../protocol/discovery.js";
import { BloomRouting } from "./BloomRouting.js";
import { LearnedRouteTable } from "./LearnedRouteTable.js";
import { OriginLookupRegistry } from "./OriginLookupRegistry.js";
import { resolveTransportIdentity, frameCapacity, isKnownUnhandledLinkMessage, lookupReverseKey, peerNodeKey, selectCarrier, } from "./routingHelpers.js";
import { TreeState } from "./TreeState.js";
const MAX_PENDING_ROUTE_RESOLUTIONS = 64;
const LOOKUP_REVERSE_PATH_TTL_MS = 30_000;
const MAX_LOOKUP_REVERSE_PATHS = 256;
const LOOKUP_ORIGIN_TIMEOUT_MS = 5_000;
const LOOKUP_ORIGIN_TTL = 8;
const MAX_PENDING_ORIGIN_LOOKUPS = 64;
const REPLY_LEARNED_ROUTE_TTL_SECONDS = 300;
const MAX_REPLY_LEARNED_ROUTES_PER_DESTINATION = 4;
const MAX_REPLY_LEARNED_LOOKUP_PEERS = 16;
const FSP_DEFAULT_PATH_MTU = 1_200;
// SessionDatagram already includes the message type; FMP adds its timestamp,
// established header and authentication tag around the forwarding envelope.
const ROUTED_FRAME_OVERHEAD = SESSION_DATAGRAM_HEADER_SIZE
    + FMP_ESTABLISHED_HEADER_LEN + FMP_AEAD_TAG_LEN + 4;
export class FipsRouting {
    cfg;
    treeState;
    pendingRouteResolutions = new Map();
    lookupReversePaths = new Map();
    originLookups = new OriginLookupRegistry(MAX_PENDING_ORIGIN_LOOKUPS);
    learnedRoutes = new LearnedRouteTable();
    coordCache = new Map();
    bloomRouting;
    constructor(cfg) {
        this.cfg = cfg;
        this.treeState = new TreeState(cfg.identity);
        this.bloomRouting = new BloomRouting({
            identity: cfg.identity,
            logger: cfg.logger,
            getPeers: cfg.getPeers,
            isTreePeer: (nodeAddr) => this.treeState.isTreePeer(nodeAddr),
            sendLinkMessage: cfg.sendLinkMessage,
            emitError: cfg.emitError,
        });
    }
    get coords() {
        return this.treeState.coords;
    }
    coordinatesFor(nodeAddrHex) {
        return this.coordCache.get(nodeAddrHex);
    }
    /** Whether a currently usable carrier can still route to this identity. */
    hasUsableRoute(nodeAddrHex) {
        return this.nextHopFor(nodeAddrHex) !== undefined;
    }
    stop() {
        for (const pending of this.pendingRouteResolutions.values()) {
            pending.abort.abort();
        }
        this.originLookups.stop();
        this.pendingRouteResolutions.clear();
        this.lookupReversePaths.clear();
        this.learnedRoutes.clear();
        this.coordCache.clear();
        this.treeState.reset();
    }
    removePeer(peerNodeAddr) {
        const wasTreePeer = this.treeState.isTreePeer(peerNodeAddr);
        const parentChanged = this.treeState.removePeer(peerNodeAddr);
        if (parentChanged)
            void this.sendTreeAnnounceToAll();
        if (parentChanged || wasTreePeer)
            void this.bloomRouting.sendAll();
    }
    async handleLinkMessage(peer, msgType, payload) {
        if (msgType === LinkMessageType.TreeAnnounce) {
            await this.handleTreeAnnounce(peer, payload);
            return;
        }
        if (msgType === LinkMessageType.FilterAnnounce) {
            await this.bloomRouting.handle(peer, payload);
            return;
        }
        if (msgType === LinkMessageType.LookupRequest) {
            const request = decodeLookupRequest(payload);
            // The origin field is unsigned; identify our looped requests by ID and target.
            if (this.originLookups.findRequest(request.requestId)?.targetHex === nodeAddrToHex(request.target))
                return;
            await this.handleLookupRequest(peer, request);
            return;
        }
        if (msgType === LinkMessageType.LookupResponse) {
            if (await this.handleOriginLookupResponse(peer, payload))
                return;
            if (this.cfg.forwarding)
                await this.forwardLookupResponse(peer, payload);
            return;
        }
        if (msgType !== LinkMessageType.SessionDatagram) {
            if (isKnownUnhandledLinkMessage(msgType))
                return;
            this.cfg.logger.warn("unsupported FMP link message", msgType);
            return;
        }
        const datagram = decodeSessionDatagramPayload(payload);
        this.cacheSessionCoordinates(datagram);
        if (bytesEqual(datagram.destAddr, this.cfg.identity.nodeAddr)) {
            this.cfg.logger.debug("session datagram delivered locally", nodeAddrToHex(datagram.srcAddr), "phase", datagram.payload[0] & 0x0f, "bytes", datagram.payload.length);
            await this.cfg.handleLocalSession(peer, datagram.srcAddr, datagram.payload);
            return;
        }
        if (!this.cfg.forwarding) {
            this.cfg.logger.warn("dropping SessionDatagram; forwarding=false");
            return;
        }
        if (datagram.ttl <= 1) {
            this.cfg.logger.warn("dropping SessionDatagram; ttl exhausted");
            return;
        }
        this.cfg.logger.debug("session datagram forwarded", nodeAddrToHex(datagram.srcAddr), nodeAddrToHex(datagram.destAddr), "phase", datagram.payload[0] & 0x0f, "bytes", datagram.payload.length, "ttl", datagram.ttl);
        await this.sendSessionDatagram({ ...datagram, ttl: datagram.ttl - 1 }, peer);
    }
    async sendTreeAnnounce(peer) {
        if (peer.link.state !== "established")
            return;
        const encoded = encodeTreeAnnounce(this.treeState.announce());
        await this.cfg.sendLinkMessage(peer, LinkMessageType.TreeAnnounce, encoded.subarray(1));
    }
    scheduleTreeAnnounce(peer) {
        if (!peer.filterAnnounced) {
            peer.filterAnnounced = true;
            this.bloomRouting.schedule(peer);
        }
        if (peer.treeAnnounced)
            return;
        peer.treeAnnounced = true;
        setTimeout(() => {
            void this.sendTreeAnnounce(peer).catch((error) => {
                peer.treeAnnounced = false;
                this.cfg.emitError(error, "send TreeAnnounce");
            });
        }, 0);
    }
    async replayPendingLookupsFor(peer) {
        if (peer.link.state !== "established")
            return;
        const peerKey = peerNodeKey(peer);
        if (this.cfg.getPeerByNodeAddr(peerKey) !== peer)
            return;
        this.pruneLookupReversePaths(Date.now());
        const pending = [...this.lookupReversePaths.values()].filter((reverse) => nodeAddrToHex(reverse.request.target) === peerKey
            && peerNodeKey(reverse.peer) !== peerKey
            && !reverse.forwardedNextHops.has(peerKey)
            && frameCapacity(peer) >= reverse.request.minMtu);
        await Promise.all(pending.map(async (reverse) => {
            reverse.forwardedNextHops.add(peerKey);
            try {
                await this.cfg.sendLinkMessage(peer, LinkMessageType.LookupRequest, encodeLookupRequestPayload(reverse.request));
                this.cfg.logger.debug("pending lookup replayed to established target", peerKey);
            }
            catch (error) {
                reverse.forwardedNextHops.delete(peerKey);
                this.cfg.emitError(error, "replay pending LookupRequest");
            }
        }));
    }
    async ensureFirstContactRoute(target, targetHex, targetPubkey) {
        const existing = this.originLookups.get(targetHex);
        if (existing) {
            await existing.promise;
            return;
        }
        const pending = this.originLookups.create({
            targetHex,
            targetPubkey,
            randomBytes: () => this.cfg.randomBytes(8),
            timeoutMs: LOOKUP_ORIGIN_TIMEOUT_MS,
        });
        const request = {
            target,
            origin: this.cfg.identity.nodeAddr,
            ttl: LOOKUP_ORIGIN_TTL,
            minMtu: 0,
            originCoords: this.treeState.coords,
        };
        const retrying = this.retryOriginLookup(pending, request);
        try {
            await pending.promise;
        }
        finally {
            await retrying;
        }
    }
    async refreshTransitRoute(target, targetHex, previousHop, minMtu = 0) {
        const existing = this.originLookups.get(targetHex);
        if (existing) {
            await existing.promise;
            if (existing.minMtu >= minMtu)
                return existing.nextHop;
            return this.refreshTransitRoute(target, targetHex, previousHop, minMtu);
        }
        if (this.originLookupPeers(previousHop, minMtu).length === 0) {
            throw new Error(`no route to ${targetHex}`);
        }
        const pending = this.originLookups.create({
            targetHex,
            minMtu,
            randomBytes: () => this.cfg.randomBytes(8),
            timeoutMs: LOOKUP_ORIGIN_TIMEOUT_MS,
        });
        const request = {
            target,
            origin: this.cfg.identity.nodeAddr,
            ttl: LOOKUP_ORIGIN_TTL,
            minMtu,
            originCoords: this.treeState.coords,
        };
        const retrying = this.retryOriginLookup(pending, request, previousHop);
        try {
            await pending.promise;
            return pending.nextHop;
        }
        finally {
            await retrying;
        }
    }
    async sendFspToward(remoteNodeAddr, fspFrame) {
        await this.sendSessionDatagram({
            ttl: 64,
            pathMtu: FSP_DEFAULT_PATH_MTU,
            srcAddr: this.cfg.identity.nodeAddr,
            destAddr: remoteNodeAddr,
            payload: fspFrame,
        });
    }
    async sendFspReplyToward(remoteNodeAddr, fspFrame, previousHop) {
        const datagram = {
            ttl: 64,
            pathMtu: FSP_DEFAULT_PATH_MTU,
            srcAddr: this.cfg.identity.nodeAddr,
            destAddr: remoteNodeAddr,
            payload: fspFrame,
        };
        await this.sendSessionDatagramVia(previousHop, datagram);
    }
    async sendSessionDatagramVia(peer, datagram) {
        this.cfg.logger.debug("session datagram routed", nodeAddrToHex(datagram.srcAddr), nodeAddrToHex(datagram.destAddr), "phase", datagram.payload[0] & 0x0f, "bytes", datagram.payload.length, peer.remoteAddr.transport, peer.remoteAddr.addr);
        const encoded = encodeSessionDatagram(datagram);
        await this.cfg.sendLinkMessage(peer, LinkMessageType.SessionDatagram, encoded.subarray(1));
    }
    learnReverseRoute(destinationNodeHex, nextHop, pathMtu) {
        if (this.cfg.routingMode !== "reply_learned" && pathMtu === undefined)
            return;
        const nextHopNodeHex = peerNodeKey(nextHop);
        if (destinationNodeHex === nodeAddrToHex(this.cfg.identity.nodeAddr))
            return;
        this.learnedRoutes.learn(destinationNodeHex, nextHopNodeHex, Date.now(), REPLY_LEARNED_ROUTE_TTL_SECONDS, MAX_REPLY_LEARNED_ROUTES_PER_DESTINATION, pathMtu);
    }
    async sendTreeAnnounceToAll() {
        const peers = [...this.cfg.getPeers()].filter((peer) => peer.link.state === "established");
        await Promise.allSettled(peers.map((peer) => this.sendTreeAnnounce(peer)));
    }
    async handleTreeAnnounce(peer, payload) {
        const announce = decodeTreeAnnouncePayload(payload);
        const peerNodeAddr = deriveNodeAddr(peer.pubkey);
        if (!bytesEqual(announce.ancestry[0].nodeAddr, peerNodeAddr)) {
            throw new Error("TreeAnnounce node address does not match authenticated peer");
        }
        if (!verifyTreeAnnounce(announce, peer.pubkey)) {
            throw new Error("TreeAnnounce signature verification failed");
        }
        const wasTreePeer = this.treeState.isTreePeer(peerNodeAddr);
        const changed = this.treeState.updatePeer(peerNodeAddr, announce);
        const isTreePeer = this.treeState.isTreePeer(peerNodeAddr);
        this.cfg.logger.debug("tree announce accepted", nodeAddrToHex(peerNodeAddr), "depth", announce.ancestry.length - 1, "root", nodeAddrToHex(announce.ancestry.at(-1).nodeAddr));
        if (changed)
            await this.sendTreeAnnounceToAll();
        if (changed || wasTreePeer !== isTreePeer)
            await this.bloomRouting.sendAll();
    }
    cacheSessionCoordinates(datagram) {
        const phase = datagram.payload[0] & 0x0f;
        try {
            if (phase === 1) {
                const setup = decodeSessionSetup(datagram.payload);
                this.cacheCoordinates(datagram.srcAddr, setup.srcCoords);
                this.cacheCoordinates(datagram.destAddr, setup.destCoords);
            }
            else if (phase === 2) {
                const ack = decodeSessionAck(datagram.payload);
                this.cacheCoordinates(datagram.srcAddr, ack.srcCoords);
                this.cacheCoordinates(datagram.destAddr, ack.destCoords);
            }
            else if (phase === 0 && (datagram.payload[1] & FSP_FLAG_CP) !== 0) {
                const established = decodeFspEstablished(datagram.payload);
                this.cacheCoordinates(datagram.srcAddr, established.srcCoords ?? []);
                this.cacheCoordinates(datagram.destAddr, established.destCoords ?? []);
            }
        }
        catch (error) {
            this.cfg.logger.warn("invalid FSP session coordinates", error);
        }
    }
    cacheCoordinates(nodeAddr, coords) {
        if (coords.length === 0 || !bytesEqual(coords[0], nodeAddr))
            return;
        this.coordCache.set(nodeAddrToHex(nodeAddr), coords.map((entry) => new Uint8Array(entry)));
    }
    async handleLookupRequest(sourcePeer, request) {
        const targetHex = nodeAddrToHex(request.target);
        if (frameCapacity(sourcePeer) < request.minMtu)
            return;
        if (bytesEqual(request.target, this.cfg.identity.nodeAddr)) {
            const targetCoords = this.treeState.coords;
            const proof = signSchnorr(this.cfg.identity, sha256(lookupResponseProofBytes(request.requestId, request.target, targetCoords)));
            await this.cfg.sendLinkMessage(sourcePeer, LinkMessageType.LookupResponse, encodeLookupResponsePayload({
                requestId: request.requestId,
                target: request.target,
                pathMtu: frameCapacity(sourcePeer),
                targetCoords,
                proof,
            }));
            this.cfg.logger.debug("lookup request answered locally", targetHex);
            return;
        }
        if (!this.cfg.forwarding || request.ttl === 0) {
            this.cfg.logger.debug("lookup request not forwarded", targetHex, "disabled-or-expired");
            return;
        }
        const reverseKey = lookupReverseKey(request.requestId, request.target);
        this.pruneLookupReversePaths(Date.now());
        const existingReverse = this.lookupReversePaths.get(reverseKey);
        if (existingReverse && peerNodeKey(existingReverse.peer) !== peerNodeKey(sourcePeer))
            return;
        if (existingReverse)
            existingReverse.peer = sourcePeer;
        const directOrLearned = this.nextHopFor(targetHex, sourcePeer, request.minMtu);
        const fallbackPeers = !directOrLearned
            ? [...this.cfg.getPeers()]
                .filter((peer) => peer !== sourcePeer
                && peer.link.state === "established"
                && (this.treeState.isTreePeer(deriveNodeAddr(peer.pubkey))
                    || this.cfg.routingMode === "reply_learned")
                && nodeAddrToHex(deriveNodeAddr(peer.pubkey)) !== nodeAddrToHex(request.origin)
                && frameCapacity(peer) >= request.minMtu)
                .slice(0, MAX_REPLY_LEARNED_LOOKUP_PEERS)
            : [];
        const nextHops = (directOrLearned ? [directOrLearned] : fallbackPeers)
            .filter((nextHop) => !existingReverse?.forwardedNextHops.has(peerNodeKey(nextHop)));
        const canResolveDirectly = this.canResolveLookupDirectly(directOrLearned, fallbackPeers.length > 0);
        if (nextHops.length === 0 && !canResolveDirectly) {
            this.cfg.logger.debug("lookup request not forwarded", targetHex, "no-next-hop");
            return;
        }
        const reverse = existingReverse ?? {
            peer: sourcePeer,
            expiresAtMs: Date.now() + LOOKUP_REVERSE_PATH_TTL_MS,
            forwardedNextHops: new Set(),
            request: { ...request, ttl: request.ttl - 1 },
        };
        if (!existingReverse) {
            this.reserveLookupReversePath();
            this.lookupReversePaths.set(reverseKey, reverse);
        }
        if (canResolveDirectly) {
            void this.resolveAndForwardLookup(targetHex, reverseKey, reverse, sourcePeer);
        }
        if (nextHops.length === 0)
            return;
        for (const nextHop of nextHops)
            reverse.forwardedNextHops.add(peerNodeKey(nextHop));
        const encoded = encodeLookupRequestPayload(reverse.request);
        const results = await Promise.allSettled(nextHops.map((nextHop) => this.cfg.sendLinkMessage(nextHop, LinkMessageType.LookupRequest, encoded)));
        results.forEach((result, index) => {
            if (result.status === "rejected") {
                const nextHop = nextHops[index];
                if (nextHop)
                    reverse.forwardedNextHops.delete(peerNodeKey(nextHop));
            }
        });
        if (results.every((result) => result.status === "rejected")) {
            if (reverse.forwardedNextHops.size === 0)
                this.lookupReversePaths.delete(reverseKey);
            throw new Error(`failed to forward lookup request for ${targetHex}`);
        }
        this.cfg.logger.debug("lookup request forwarded", targetHex, nextHops.length);
    }
    async resolveAndForwardLookup(targetHex, reverseKey, reverse, sourcePeer) {
        try {
            await this.resolveRoute(reverse.request.target, targetHex);
        }
        catch {
            this.cfg.logger.debug("lookup target transport resolution failed", targetHex);
            return;
        }
        if (this.lookupReversePaths.get(reverseKey) !== reverse)
            return;
        const nextHop = this.nextHopFor(targetHex, sourcePeer, reverse.request.minMtu);
        if (!nextHop)
            return;
        const nextHopKey = peerNodeKey(nextHop);
        if (reverse.forwardedNextHops.has(nextHopKey))
            return;
        reverse.forwardedNextHops.add(nextHopKey);
        try {
            await this.cfg.sendLinkMessage(nextHop, LinkMessageType.LookupRequest, encodeLookupRequestPayload(reverse.request));
            this.cfg.logger.debug("lookup request forwarded after transport resolution", targetHex);
        }
        catch (error) {
            reverse.forwardedNextHops.delete(nextHopKey);
            this.cfg.emitError(error, "forward resolved LookupRequest");
        }
    }
    canResolveLookupDirectly(nextHop, hasFallbackPeer) {
        return !nextHop && !hasFallbackPeer
            && this.cfg.transports.some((transport) => transport.resolve !== undefined);
    }
    async forwardLookupResponse(sourcePeer, payload) {
        const response = decodeLookupResponse(payload);
        const reverseKey = lookupReverseKey(response.requestId, response.target);
        this.pruneLookupReversePaths(Date.now());
        const reverse = this.lookupReversePaths.get(reverseKey);
        if (!reverse || reverse.peer === sourcePeer) {
            this.cfg.logger.debug("lookup response not forwarded", nodeAddrToHex(response.target));
            return;
        }
        if (Math.min(response.pathMtu, frameCapacity(sourcePeer), frameCapacity(reverse.peer)) < reverse.request.minMtu)
            return;
        this.cacheCoordinates(response.target, response.targetCoords);
        this.learnReverseRoute(nodeAddrToHex(response.target), sourcePeer, Math.min(response.pathMtu, frameCapacity(sourcePeer)));
        this.lookupReversePaths.delete(reverseKey);
        response.pathMtu = Math.min(response.pathMtu, frameCapacity(sourcePeer), frameCapacity(reverse.peer));
        await this.cfg.sendLinkMessage(reverse.peer, LinkMessageType.LookupResponse, encodeLookupResponsePayload(response));
        this.cfg.logger.debug("lookup response forwarded", nodeAddrToHex(response.target), reverse.peer.remoteAddr.transport, reverse.peer.remoteAddr.addr);
    }
    async handleOriginLookupResponse(sourcePeer, payload) {
        const response = decodeLookupResponse(payload);
        const pending = this.originLookups.findRequest(response.requestId);
        if (!pending)
            return false;
        if (nodeAddrToHex(response.target) !== pending.targetHex)
            return true;
        if (Math.min(response.pathMtu, frameCapacity(sourcePeer)) < pending.minMtu)
            return true;
        // A locally originated first-contact lookup knows the compressed target
        // key and verifies its proof. A transit refresh only knows the NodeAddr;
        // its established end-to-end FSP session still authenticates payloads,
        // while this response is used solely to relearn a forwarding path.
        if (pending.targetPubkey) {
            const proofDigest = sha256(lookupResponseProofBytes(response.requestId, response.target, response.targetCoords));
            const proofValid = verifySchnorr(response.proof, proofDigest, pending.targetPubkey.subarray(1));
            if (!proofValid) {
                this.cfg.logger.warn("lookup response proof verification failed", pending.targetHex);
                return true;
            }
        }
        if (!bytesEqual(response.targetCoords[0], response.target)) {
            this.cfg.logger.warn("lookup response coordinates do not start at target", pending.targetHex);
            return true;
        }
        this.cacheCoordinates(response.target, response.targetCoords);
        this.learnReverseRoute(pending.targetHex, sourcePeer, Math.min(response.pathMtu, frameCapacity(sourcePeer)));
        this.originLookups.complete(pending, peerNodeKey(sourcePeer));
        this.cfg.logger.debug("lookup response accepted", pending.targetHex);
        return true;
    }
    originLookupPeers(excludedPeer, minMtu = 0) {
        const defaultPeer = this.cfg.defaultRoute
            ? this.cfg.getPeerByPubkey(this.cfg.defaultRoute)
            : undefined;
        return [...this.cfg.getPeers()]
            .filter((peer) => {
            if (peer === excludedPeer || peer.link.state !== "established" || frameCapacity(peer) < minMtu)
                return false;
            if (this.cfg.routingMode === "reply_learned")
                return true;
            return peer === defaultPeer || this.treeState.isTreePeer(deriveNodeAddr(peer.pubkey));
        })
            .slice(0, MAX_REPLY_LEARNED_LOOKUP_PEERS);
    }
    async retryOriginLookup(pending, request, excludedPeer) {
        await this.originLookups.retry(pending, async () => {
            const encoded = encodeLookupRequestPayload({ ...request, requestId: pending.requestId });
            const peers = this.originLookupPeers(excludedPeer, pending.minMtu);
            await Promise.allSettled(peers.map((peer) => this.cfg.sendLinkMessage(peer, LinkMessageType.LookupRequest, encoded)));
        });
    }
    async sendSessionDatagram(datagram, previousHop) {
        const destNodeHex = nodeAddrToHex(datagram.destAddr);
        let nextHop = this.nextHopFor(destNodeHex, previousHop);
        if (!nextHop && !previousHop) {
            await this.resolveRoute(datagram.destAddr, destNodeHex);
            nextHop = this.nextHopFor(destNodeHex, previousHop);
        }
        if (!nextHop && previousHop) {
            await this.refreshTransitRoute(datagram.destAddr, destNodeHex, previousHop);
            nextHop = this.nextHopFor(destNodeHex, previousHop);
        }
        if (!nextHop)
            throw new Error(`no route to ${destNodeHex}`);
        const frames = typeof datagram.payload === "function"
            ? datagram.payload(nextHop)
            : [datagram.payload];
        for (const payload of frames) {
            const minMtu = payload.length + ROUTED_FRAME_OVERHEAD;
            if (this.pathMtuFor(destNodeHex, nextHop) < minMtu) {
                nextHop = this.nextHopFor(destNodeHex, previousHop, minMtu);
                if (!nextHop) {
                    const resolved = await this.refreshTransitRoute(datagram.destAddr, destNodeHex, previousHop, minMtu);
                    nextHop = selectCarrier(this.cfg.getPeerByNodeAddr(resolved ?? ""), this.cfg.getPeers(), previousHop, minMtu);
                }
                if (!nextHop)
                    throw new Error(`no route to ${destNodeHex} with MTU ${minMtu}`);
            }
            await this.sendSessionDatagramVia(nextHop, { ...datagram, payload });
        }
    }
    pathMtuFor(destination, peer) {
        const nextHop = peerNodeKey(peer);
        const verified = destination === nextHop ? frameCapacity(peer)
            : this.learnedRoutes.pathMtu(destination, nextHop, Date.now()) ?? FSP_DEFAULT_PATH_MTU;
        return Math.min(frameCapacity(peer), verified);
    }
    nextHopFor(destNodeHex, excludedPeer, minMtu = 0) {
        const usablePeer = (nodeHex) => {
            const peer = selectCarrier(this.cfg.getPeerByNodeAddr(nodeHex), this.cfg.getPeers(), excludedPeer, minMtu);
            return peer && this.pathMtuFor(destNodeHex, peer) >= minMtu ? peer : undefined;
        };
        const direct = usablePeer(destNodeHex);
        if (direct)
            return direct;
        if (this.cfg.routingMode === "reply_learned") {
            const learnedNodeHex = this.learnedRoutes.selectNextHop(destNodeHex, Date.now(), (nextHop) => usablePeer(nextHop) !== undefined);
            if (learnedNodeHex)
                return usablePeer(learnedNodeHex);
        }
        const destCoords = this.coordCache.get(destNodeHex);
        if (destCoords) {
            const treeNodeHex = this.treeState.nextHop(destCoords, (nodeHex) => usablePeer(nodeHex) !== undefined);
            if (treeNodeHex)
                return usablePeer(treeNodeHex);
        }
        const defaultPeer = this.cfg.defaultRoute
            ? this.cfg.getPeerByPubkey(this.cfg.defaultRoute)
            : undefined;
        return defaultPeer ? usablePeer(peerNodeKey(defaultPeer)) : undefined;
    }
    pruneLookupReversePaths(nowMs) {
        for (const [key, reverse] of this.lookupReversePaths) {
            if (reverse.expiresAtMs <= nowMs)
                this.lookupReversePaths.delete(key);
        }
    }
    reserveLookupReversePath() {
        if (this.lookupReversePaths.size < MAX_LOOKUP_REVERSE_PATHS)
            return;
        const oldest = this.lookupReversePaths.keys().next().value;
        if (oldest !== undefined)
            this.lookupReversePaths.delete(oldest);
    }
    async resolveRoute(destNodeAddr, destNodeHex) {
        const existing = this.pendingRouteResolutions.get(destNodeHex);
        if (existing) {
            await existing.promise;
            return;
        }
        if (this.pendingRouteResolutions.size >= MAX_PENDING_ROUTE_RESOLUTIONS) {
            throw new Error(`route resolution capacity exceeded for ${destNodeHex}`);
        }
        const abort = new AbortController();
        const promise = this.resolveAndConnectRoute(destNodeAddr, abort);
        this.pendingRouteResolutions.set(destNodeHex, { promise, abort });
        try {
            await promise;
        }
        finally {
            if (this.pendingRouteResolutions.get(destNodeHex)?.promise === promise) {
                this.pendingRouteResolutions.delete(destNodeHex);
            }
        }
    }
    async resolveAndConnectRoute(destNodeAddr, abort) {
        const resolved = await resolveTransportIdentity(this.cfg.transports, destNodeAddr, abort, this.cfg.isStarted);
        await this.cfg.connectKnownPeer(resolved.transport, resolved.remoteAddr, resolved.remotePubkey);
    }
    /** Resolve only the identity: FSP signaling can be needed before its carrier exists. */
    async resolveIdentity(nodeAddr, abort) {
        const nodeHex = nodeAddrToHex(nodeAddr);
        const adjacent = this.cfg.getPeerByNodeAddr(nodeHex);
        if (adjacent?.link.state === "established" && adjacent.pubkey)
            return adjacent.pubkey;
        return (await resolveTransportIdentity(this.cfg.transports, nodeAddr, abort, this.cfg.isStarted)).remotePubkey;
    }
}
//# sourceMappingURL=FipsRouting.js.map