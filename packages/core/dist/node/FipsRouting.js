import { sha256 } from "@noble/hashes/sha256";
import { bytesEqual } from "../codec/hex.js";
import { signSchnorr, verifySchnorr } from "../identity/index.js";
import { nodeAddrToHex } from "../nodeaddr/index.js";
import { encodeSessionDatagramPayload, LinkMessageType, parseSessionDatagramPayload, SESSION_DATAGRAM_HEADER_SIZE, } from "../protocol/link.js";
import { decodeSessionAck, decodeSessionSetup } from "../protocol/session.js";
import { decodeLinkExtension, encodeExtensionCapabilities, FMP_EXTENSION_CLIENT_ROLE, } from "../protocol/extensions.js";
import { FSP_FLAG_CP, parseFspEstablished } from "../fsp/wire.js";
import { FMP_AEAD_TAG_LEN, FMP_ESTABLISHED_HEADER_LEN } from "../fmp/wire.js";
import { decodeTreeAnnouncePayload, encodeTreeAnnounce, verifyTreeAnnounce } from "../protocol/tree.js";
import { decodeLookupRequest, decodeLookupResponse, encodeLookupRequestPayload, encodeLookupResponsePayload, lookupResponseProofBytes, } from "../protocol/discovery.js";
import { noopLogger } from "../transport/types.js";
import { BloomRouting } from "./BloomRouting.js";
import { LearnedRouteTable } from "./LearnedRouteTable.js";
import { LookupBackoff, LookupForwardDeferrals, LookupForwardLimiter } from "./LookupLimits.js";
import { OriginLookupRegistry } from "./OriginLookupRegistry.js";
import { peerNodeAddr, peerNodeKey } from "./PeerState.js";
import { filterLookupPeersByBloom, frameCapacity, isKnownUnhandledLinkMessage, lookupReverseKey, nextClientRoleMessage, resolveTransportIdentity, selectCarrier, } from "./routingHelpers.js";
import { TreeState } from "./TreeState.js";
const MAX_PENDING_ROUTE_RESOLUTIONS = 64;
const MAX_COORD_CACHE_ENTRIES = 4_096;
const LOOKUP_REVERSE_PATH_TTL_MS = 30_000;
const MAX_LOOKUP_REVERSE_PATHS = 256;
const LOOKUP_ORIGIN_TIMEOUT_MS = 5_000;
const LOOKUP_ORIGIN_TTL = 64;
const MAX_PENDING_ORIGIN_LOOKUPS = 64;
// Coalesce rapid TreeAnnounce storms into 50 ms waves after an initial 2-burst.
const TREE_ANNOUNCE_DEBOUNCE_MS = 50;
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
    lookupBackoff = new LookupBackoff();
    lookupForwardLimiter = new LookupForwardLimiter();
    deferredLookupForwards = new LookupForwardDeferrals();
    bloomRouting;
    localNodeAddrHex;
    debugEnabled;
    cachedTreeAnnounce;
    pendingTreeBroadcast;
    treeBroadcastTimer;
    lastTreeBroadcastMs = -Infinity;
    treeBurstUsed = false;
    treeAnnounceSentSeq = new WeakMap();
    clientSequence = 0n;
    constructor(cfg) {
        this.cfg = cfg;
        this.localNodeAddrHex = nodeAddrToHex(cfg.identity.nodeAddr);
        this.debugEnabled = cfg.logger !== noopLogger;
        this.treeState = new TreeState(cfg.identity);
        this.bloomRouting = new BloomRouting({
            identity: cfg.identity, forwarding: cfg.forwarding, strictClient: cfg.strictClient,
            logger: cfg.logger, getPeers: cfg.getPeers, sendLinkMessage: cfg.sendLinkMessage,
            emitError: cfg.emitError, isTreePeer: (nodeAddr, nodeHex) => this.treeState.isTreePeer(nodeAddr, nodeHex),
        });
    }
    get coords() {
        return this.cfg.strictClient ? [this.cfg.identity.nodeAddr] : this.treeState.coords;
    }
    coordinatesFor(nodeAddrHex) {
        const coords = this.coordCache.get(nodeAddrHex);
        return this.cfg.strictClient ? coords?.slice(0, 1) : coords;
    }
    /** Whether a currently usable carrier can still route to this identity. */
    hasUsableRoute(nodeAddrHex) {
        return this.nextHopFor(nodeAddrHex) !== undefined;
    }
    stop() {
        for (const pending of this.pendingRouteResolutions.values())
            pending.abort.abort();
        this.originLookups.stop();
        this.deferredLookupForwards.clear();
        this.lookupBackoff.resetAll();
        this.pendingRouteResolutions.clear();
        this.lookupReversePaths.clear();
        this.learnedRoutes.clear();
        this.coordCache.clear();
        this.treeState.reset();
        this.cachedTreeAnnounce = this.pendingTreeBroadcast = undefined;
        if (this.treeBroadcastTimer)
            clearTimeout(this.treeBroadcastTimer);
        this.treeBroadcastTimer = undefined;
        this.lastTreeBroadcastMs = -Infinity;
        this.treeBurstUsed = false;
        this.treeAnnounceSentSeq = new WeakMap();
        this.bloomRouting.stop();
        for (const peer of this.cfg.getPeers()) {
            peer.clientSupported = peer.clientOnly = undefined;
            peer.routingRoleSequence = undefined;
            peer.extensionNamespace = peer.extensionCapabilities = undefined;
            peer.extensionRequestSent = peer.legacySupportProbes = undefined;
        }
    }
    removePeer(peerNodeAddr) {
        const wasTreePeer = this.treeState.isTreePeer(peerNodeAddr);
        const parentChanged = this.treeState.removePeer(peerNodeAddr);
        if (parentChanged)
            this.resetLookupBackoff();
        if (parentChanged)
            void this.broadcastTreeAnnounce();
        if (parentChanged || wasTreePeer)
            void this.bloomRouting.sendAll();
    }
    async handleLinkMessage(peer, msgType, payload) {
        switch (msgType) {
            case LinkMessageType.SessionDatagram: return this.handleSessionDatagram(peer, payload);
            case LinkMessageType.Extension: return this.handleExtensionMessage(peer, payload);
            case LinkMessageType.ClientSupport:
            case LinkMessageType.ClientOnly: return this.handleLegacyClientMessage(peer, msgType, payload);
            case 0x54: return;
            case LinkMessageType.TreeAnnounce: return this.handleTreeAnnounce(peer, payload);
            case LinkMessageType.FilterAnnounce: return this.bloomRouting.handle(peer, payload);
            case LinkMessageType.LookupRequest: return this.handleIncomingLookupRequest(peer, payload);
            case LinkMessageType.LookupResponse:
                if (!(await this.handleOriginLookupResponse(peer, payload)) && this.cfg.forwarding) {
                    await this.forwardLookupResponse(peer, payload);
                }
                return;
            default:
                if (!isKnownUnhandledLinkMessage(msgType))
                    this.cfg.logger.warn("unsupported FMP link message", msgType);
        }
    }
    async handleLegacyClientMessage(peer, msgType, payload) {
        if (msgType === LinkMessageType.ClientSupport) {
            if (payload.length !== 0 || peer.extensionNamespace)
                return;
            peer.extensionNamespace = "legacy";
            peer.clientSupported = true;
            if (this.cfg.strictClient)
                await this.sendTreeAnnounce(peer);
            else
                await this.cfg.sendLinkMessage(peer, LinkMessageType.ClientSupport, new Uint8Array());
            return;
        }
        if (peer.extensionNamespace !== "legacy" || payload.length !== 8)
            return;
        const sequence = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigUint64(0, true);
        await this.handleClientRole(peer, sequence);
    }
    async handleIncomingLookupRequest(peer, payload) {
        const request = decodeLookupRequest(payload);
        this.cfg.assertNodeAllowed?.(request.origin);
        this.cfg.assertNodeAllowed?.(request.target);
        // The origin field is unsigned; identify our looped requests by ID and target.
        if (this.originLookups.findRequest(request.requestId)?.targetHex === nodeAddrToHex(request.target))
            return;
        await this.handleLookupRequest(peer, request);
    }
    async handleExtensionMessage(peer, payload) {
        const message = decodeLinkExtension(payload);
        if (!message)
            return;
        if (message.kind === 3) {
            if (peer.extensionNamespace === "namespaced" && ((peer.extensionCapabilities ?? 0) & FMP_EXTENSION_CLIENT_ROLE)) {
                await this.handleClientRole(peer, message.sequence);
            }
            return;
        }
        const hadSupport = peer.extensionNamespace === "namespaced"
            && !!((peer.extensionCapabilities ?? 0) & FMP_EXTENSION_CLIENT_ROLE);
        peer.extensionNamespace = "namespaced";
        peer.extensionCapabilities = (peer.extensionCapabilities ?? 0) | (message.capabilities & FMP_EXTENSION_CLIENT_ROLE);
        peer.clientSupported = !!(peer.extensionCapabilities & FMP_EXTENSION_CLIENT_ROLE);
        if (message.kind === 1) {
            await this.cfg.sendLinkMessage(peer, LinkMessageType.Extension, encodeExtensionCapabilities(2, FMP_EXTENSION_CLIENT_ROLE));
        }
        if (this.cfg.strictClient && peer.clientSupported && !hadSupport)
            await this.sendTreeAnnounce(peer);
    }
    async handleSessionDatagram(peer, payload) {
        const datagram = parseSessionDatagramPayload(payload);
        this.cfg.assertNodeAllowed?.(datagram.srcAddr);
        this.cfg.assertNodeAllowed?.(datagram.destAddr);
        this.cacheSessionCoordinates(datagram);
        if (bytesEqual(datagram.destAddr, this.cfg.identity.nodeAddr)) {
            if (this.debugEnabled) {
                this.cfg.logger.debug("session datagram delivered locally", nodeAddrToHex(datagram.srcAddr), "phase", datagram.payload[0] & 0x0f, "bytes", datagram.payload.length);
            }
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
        if (this.debugEnabled) {
            this.cfg.logger.debug("session datagram forwarded", nodeAddrToHex(datagram.srcAddr), nodeAddrToHex(datagram.destAddr), "phase", datagram.payload[0] & 0x0f, "bytes", datagram.payload.length, "ttl", datagram.ttl);
        }
        datagram.ttl -= 1;
        await this.sendSessionDatagram(datagram, peer);
    }
    async sendTreeAnnounce(peer, allowLegacyProbe = false) {
        if (peer.link.state !== "established")
            return;
        if (!peer.extensionRequestSent && peer.extensionNamespace !== "namespaced") {
            peer.extensionRequestSent = true;
            await this.cfg.sendLinkMessage(peer, LinkMessageType.Extension, encodeExtensionCapabilities(1, FMP_EXTENSION_CLIENT_ROLE));
            if (this.cfg.strictClient)
                return;
        }
        if (this.cfg.strictClient) {
            const msg = nextClientRoleMessage(peer, allowLegacyProbe, () => ++this.clientSequence);
            if (msg)
                await this.cfg.sendLinkMessage(peer, msg.msgType, msg.payload);
            return;
        }
        const announce = this.treeState.announce();
        const link = peer.link;
        if (this.treeAnnounceSentSeq.get(link) === announce.sequence)
            return;
        if (this.cachedTreeAnnounce?.announce !== announce) {
            this.cachedTreeAnnounce = { announce, payload: encodeTreeAnnounce(announce).subarray(1) };
        }
        const previousSeq = this.treeAnnounceSentSeq.get(link);
        this.treeAnnounceSentSeq.set(link, announce.sequence);
        try {
            await this.cfg.sendLinkMessage(peer, LinkMessageType.TreeAnnounce, this.cachedTreeAnnounce.payload);
        }
        catch (error) {
            if (this.treeAnnounceSentSeq.get(link) === announce.sequence) {
                if (previousSeq === undefined)
                    this.treeAnnounceSentSeq.delete(link);
                else
                    this.treeAnnounceSentSeq.set(link, previousSeq);
            }
            throw error;
        }
    }
    async handleClientRole(peer, sequence) {
        const last = peer.routingRoleSequence;
        if (last !== undefined && (sequence < last || (sequence === last && !peer.clientOnly)))
            return;
        peer.routingRoleSequence = sequence;
        peer.clientSupported = true;
        if (!peer.clientOnly) {
            peer.clientOnly = true;
            this.removePeer(peerNodeAddr(peer));
            await this.bloomRouting.sendAll();
        }
    }
    scheduleTreeAnnounce(peer) {
        if (!this.cfg.strictClient && !peer.filterAnnounced) {
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
    /** Topology changed (new authenticated peer or tree coordinates): unreachable targets may now resolve. */
    resetLookupBackoff() { this.lookupBackoff.resetAll(); }
    /** An authenticated session proves this node reachable; drop its lookup backoff. */
    noteSessionEstablished(nodeAddrHex) { this.lookupBackoff.recordSuccess(nodeAddrHex); }
    /** Reuse the authenticated heartbeat cadence for bounded capability retries. */
    async refreshClientRole() {
        if (this.cfg.strictClient)
            await this.sendTreeAnnounceToAll(true);
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
        this.assertLookupAllowed(targetHex);
        const hadLookupPeers = this.originLookupPeers().length > 0;
        await this.runOriginLookup({ target, targetHex, targetPubkey, minMtu: 0, retryWhenReachable: !hadLookupPeers });
    }
    /** Post-failure suppression keeps an offline target from triggering a fresh network-wide lookup. */
    assertLookupAllowed(targetHex, excludedPeer, minMtu = 0) {
        if (!this.lookupBackoff.isSuppressed(targetHex, Date.now()))
            return;
        // A failure that never reached any peer earns one retry once a peer exists.
        if (this.originLookupPeers(excludedPeer, minMtu).length > 0
            && this.lookupBackoff.retryDelayedWithRoute(targetHex))
            return;
        this.cfg.logger.debug("lookup suppressed by backoff", targetHex, this.lookupBackoff.failureCount(targetHex));
        throw new Error(`no route to ${targetHex} (lookup backoff)`);
    }
    async refreshTransitRoute(target, targetHex, previousHop, minMtu = 0) {
        const existing = this.originLookups.get(targetHex);
        if (existing) {
            await existing.promise;
            if (existing.minMtu >= minMtu)
                return existing.nextHop;
            return this.refreshTransitRoute(target, targetHex, previousHop, minMtu);
        }
        if (this.originLookupPeers(previousHop, minMtu).length === 0)
            throw new Error(`no route to ${targetHex}`);
        this.assertLookupAllowed(targetHex, previousHop, minMtu);
        return this.runOriginLookup({ target, targetHex, minMtu, excludedPeer: previousHop });
    }
    async runOriginLookup(args) {
        const pending = this.originLookups.create({
            targetHex: args.targetHex, targetPubkey: args.targetPubkey, minMtu: args.minMtu,
            randomBytes: () => this.cfg.randomBytes(8), timeoutMs: LOOKUP_ORIGIN_TIMEOUT_MS,
        });
        const request = {
            target: args.target, origin: this.cfg.identity.nodeAddr,
            ttl: LOOKUP_ORIGIN_TTL, minMtu: args.minMtu, originCoords: this.coords,
        };
        const retrying = this.retryOriginLookup(pending, request, args.excludedPeer);
        try {
            await pending.promise;
            return pending.nextHop;
        }
        catch (error) {
            if (pending.timedOut)
                this.lookupBackoff.recordFailure(args.targetHex, Date.now(), args.retryWhenReachable);
            throw error;
        }
        finally {
            await retrying;
        }
    }
    async sendFspToward(remoteNodeAddr, fspFrame) {
        await this.sendSessionDatagram({
            ttl: 64, pathMtu: FSP_DEFAULT_PATH_MTU,
            srcAddr: this.cfg.identity.nodeAddr, destAddr: remoteNodeAddr, payload: fspFrame,
        });
    }
    async sendFspReplyToward(remoteNodeAddr, fspFrame, previousHop) {
        const nextHop = (this.cfg.routingMode === "tree" ? this.nextHopFor(nodeAddrToHex(remoteNodeAddr)) : undefined)
            ?? previousHop;
        await this.sendSessionDatagramVia(nextHop, {
            ttl: 64, pathMtu: FSP_DEFAULT_PATH_MTU,
            srcAddr: this.cfg.identity.nodeAddr, destAddr: remoteNodeAddr, payload: fspFrame,
        });
    }
    async sendSessionDatagramVia(peer, datagram) {
        if (this.debugEnabled) {
            this.cfg.logger.debug("session datagram routed", nodeAddrToHex(datagram.srcAddr), nodeAddrToHex(datagram.destAddr), "phase", datagram.payload[0] & 0x0f, "bytes", datagram.payload.length, peer.remoteAddr.transport, peer.remoteAddr.addr);
        }
        await this.cfg.sendLinkMessage(peer, LinkMessageType.SessionDatagram, encodeSessionDatagramPayload(datagram));
    }
    learnReverseRoute(destinationNodeHex, nextHop, pathMtu) {
        if (this.cfg.routingMode !== "reply_learned" && pathMtu === undefined)
            return;
        if (destinationNodeHex === this.localNodeAddrHex)
            return;
        this.learnedRoutes.learn(destinationNodeHex, peerNodeKey(nextHop), Date.now(), REPLY_LEARNED_ROUTE_TTL_SECONDS, MAX_REPLY_LEARNED_ROUTES_PER_DESTINATION, pathMtu);
    }
    broadcastTreeAnnounce() {
        if (this.pendingTreeBroadcast)
            return this.pendingTreeBroadcast;
        if (this.treeBroadcastTimer)
            return Promise.resolve();
        const nowMs = Date.now();
        const elapsed = nowMs - this.lastTreeBroadcastMs;
        const flush = async () => {
            const started = Date.now();
            this.treeBurstUsed = started - this.lastTreeBroadcastMs < TREE_ANNOUNCE_DEBOUNCE_MS * 2;
            this.lastTreeBroadcastMs = started;
            await this.sendTreeAnnounceToAll();
            this.lastTreeBroadcastMs = Date.now();
        };
        if (this.treeBurstUsed && elapsed < TREE_ANNOUNCE_DEBOUNCE_MS) {
            this.treeBroadcastTimer = setTimeout(() => { this.treeBroadcastTimer = undefined; void flush(); }, TREE_ANNOUNCE_DEBOUNCE_MS - elapsed);
            return Promise.resolve();
        }
        return (this.pendingTreeBroadcast = Promise.resolve().then(() => {
            this.pendingTreeBroadcast = undefined;
            return flush();
        }));
    }
    async sendTreeAnnounceToAll(allowLegacyProbe = false) {
        const peers = [...this.cfg.getPeers()].filter((peer) => peer.link.state === "established");
        await Promise.allSettled(peers.map((peer) => this.sendTreeAnnounce(peer, allowLegacyProbe)));
    }
    async handleTreeAnnounce(peer, payload) {
        const announce = decodeTreeAnnouncePayload(payload);
        const peerAddr = peerNodeAddr(peer);
        const peerHex = peerNodeKey(peer);
        if (!bytesEqual(announce.ancestry[0].nodeAddr, peerAddr)) {
            throw new Error("TreeAnnounce node address does not match authenticated peer");
        }
        if (!verifyTreeAnnounce(announce, peer.pubkey)) {
            throw new Error("TreeAnnounce signature verification failed");
        }
        if (peer.routingRoleSequence !== undefined && announce.sequence <= peer.routingRoleSequence)
            return;
        peer.routingRoleSequence = announce.sequence;
        const wasClient = peer.clientOnly;
        peer.clientOnly = false;
        const prevParent = this.treeState.parentNodeAddr;
        const wasTreePeer = this.treeState.isTreePeer(peerAddr, peerHex);
        const changed = this.treeState.updatePeer(peerAddr, announce, peerHex);
        const isTreePeer = this.treeState.isTreePeer(peerAddr, peerHex);
        if (this.debugEnabled) {
            this.cfg.logger.debug("tree announce accepted", peerHex, "depth", announce.ancestry.length - 1, "root", nodeAddrToHex(announce.ancestry.at(-1).nodeAddr));
        }
        if (changed)
            this.resetLookupBackoff();
        if (changed)
            await this.broadcastTreeAnnounce();
        const parentChanged = !bytesEqual(prevParent, this.treeState.parentNodeAddr);
        if (parentChanged || wasClient || wasTreePeer !== isTreePeer)
            await this.bloomRouting.sendAll();
    }
    cacheSessionCoordinates(datagram) {
        const phase = datagram.payload[0] & 0x0f;
        if (phase === 0 && (datagram.payload[1] & FSP_FLAG_CP) === 0)
            return;
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
            else if (phase === 0) {
                const established = parseFspEstablished(datagram.payload, true);
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
        const key = nodeAddrToHex(nodeAddr);
        this.coordCache.delete(key);
        if (this.coordCache.size >= MAX_COORD_CACHE_ENTRIES) {
            const oldest = this.coordCache.keys().next().value;
            if (oldest !== undefined)
                this.coordCache.delete(oldest);
        }
        this.coordCache.set(key, coords.map((entry) => new Uint8Array(entry)));
    }
    async handleLookupRequest(sourcePeer, request, allowDeferral = true) {
        const targetHex = nodeAddrToHex(request.target);
        if (frameCapacity(sourcePeer) < request.minMtu)
            return;
        if (bytesEqual(request.target, this.cfg.identity.nodeAddr)) {
            await this.answerLocalLookup(sourcePeer, request, targetHex);
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
        const { nextHops, canResolveDirectly } = this.selectLookupForwardTargets(sourcePeer, request, targetHex, existingReverse);
        if (nextHops.length === 0 && !canResolveDirectly) {
            this.cfg.logger.debug("lookup request not forwarded", targetHex, "no-next-hop");
            return;
        }
        if (!this.lookupForwardLimiter.admit(peerNodeKey(sourcePeer), targetHex, Date.now())) {
            if (allowDeferral && !existingReverse)
                this.deferLookupForward(sourcePeer, request, targetHex);
            this.cfg.logger.debug("lookup request not forwarded", targetHex, "rate-limited");
            return;
        }
        const reverse = existingReverse ?? this.recordLookupReversePath(reverseKey, sourcePeer, request);
        if (canResolveDirectly)
            void this.resolveAndForwardLookup(targetHex, reverseKey, reverse, sourcePeer);
        if (nextHops.length > 0)
            await this.sendLookupToNextHops(reverse, reverseKey, nextHops, targetHex);
    }
    selectLookupForwardTargets(sourcePeer, request, targetHex, existingReverse) {
        const directOrLearned = this.nextHopFor(targetHex, sourcePeer, request.minMtu);
        const fallbackPeers = directOrLearned ? [] : this.lookupFallbackPeers(sourcePeer, request, targetHex);
        const candidates = directOrLearned ? [directOrLearned] : fallbackPeers;
        const nextHops = existingReverse
            ? candidates.filter((nextHop) => !existingReverse.forwardedNextHops.has(peerNodeKey(nextHop)))
            : candidates;
        const canResolveDirectly = !directOrLearned && fallbackPeers.length === 0
            && this.cfg.transports.some((transport) => transport.resolve !== undefined);
        return { nextHops, canResolveDirectly };
    }
    async answerLocalLookup(sourcePeer, request, targetHex) {
        const targetCoords = this.coords;
        const proof = signSchnorr(this.cfg.identity, sha256(lookupResponseProofBytes(request.requestId, request.target, targetCoords)));
        await this.cfg.sendLinkMessage(sourcePeer, LinkMessageType.LookupResponse, encodeLookupResponsePayload({
            requestId: request.requestId, target: request.target, pathMtu: frameCapacity(sourcePeer), targetCoords, proof,
        }));
        this.cfg.logger.debug("lookup request answered locally", targetHex);
    }
    recordLookupReversePath(reverseKey, sourcePeer, request) {
        const reverse = {
            peer: sourcePeer,
            expiresAtMs: Date.now() + LOOKUP_REVERSE_PATH_TTL_MS,
            forwardedNextHops: new Set(),
            request: { ...request, ttl: request.ttl - 1 },
        };
        if (this.lookupReversePaths.size >= MAX_LOOKUP_REVERSE_PATHS) {
            const oldest = this.lookupReversePaths.keys().next().value;
            if (oldest !== undefined)
                this.lookupReversePaths.delete(oldest);
        }
        this.lookupReversePaths.set(reverseKey, reverse);
        return reverse;
    }
    async sendLookupToNextHops(reverse, reverseKey, nextHops, targetHex) {
        for (const nextHop of nextHops)
            reverse.forwardedNextHops.add(peerNodeKey(nextHop));
        const encoded = encodeLookupRequestPayload(reverse.request);
        const results = await Promise.allSettled(nextHops.map((nextHop) => this.cfg.sendLinkMessage(nextHop, LinkMessageType.LookupRequest, encoded)));
        results.forEach((result, index) => {
            if (result.status === "rejected" && nextHops[index]) {
                reverse.forwardedNextHops.delete(peerNodeKey(nextHops[index]));
            }
        });
        if (results.every((result) => result.status === "rejected")) {
            if (reverse.forwardedNextHops.size === 0)
                this.lookupReversePaths.delete(reverseKey);
            throw new Error(`failed to forward lookup request for ${targetHex}`);
        }
        this.cfg.logger.debug("lookup request forwarded", targetHex, nextHops.length);
    }
    lookupFallbackPeers(sourcePeer, request, targetHex) {
        const originHex = nodeAddrToHex(request.origin);
        const isTree = (peer) => this.treeState.isTreePeer(peerNodeAddr(peer), peerNodeKey(peer));
        const candidates = [...this.cfg.getPeers()].filter((peer) => peer !== sourcePeer
            && peer.link.state === "established"
            && (isTree(peer) || this.cfg.routingMode === "reply_learned")
            && peerNodeKey(peer) !== originHex
            && frameCapacity(peer) >= request.minMtu);
        if (request.minMtu > 0) {
            return candidates.filter((peer) => !peer.clientOnly || peerNodeKey(peer) === targetHex)
                .slice(0, MAX_REPLY_LEARNED_LOOKUP_PEERS);
        }
        const treeScope = this.cfg.routingMode === "reply_learned"
            ? { isTreePeer: isTree, strictTreeOnly: isTree(sourcePeer) }
            : undefined;
        return filterLookupPeersByBloom(candidates, request.target, targetHex, undefined, false, treeScope)
            .slice(0, MAX_REPLY_LEARNED_LOOKUP_PEERS);
    }
    /** Hold one rate-limited request per target until that target's next forwarding slot. */
    deferLookupForward(sourcePeer, request, targetHex) {
        const ingressKey = peerNodeKey(sourcePeer);
        const nowMs = Date.now();
        const dueMs = this.lookupForwardLimiter.nextSlotMs(ingressKey, targetHex, nowMs);
        if (dueMs === undefined)
            return;
        this.deferredLookupForwards.defer(targetHex, ingressKey, dueMs - nowMs, () => {
            if (!this.cfg.isStarted() || sourcePeer.link.state !== "established")
                return;
            void this.handleLookupRequest(sourcePeer, request, false).catch((error) => {
                this.cfg.emitError(error, "forward deferred LookupRequest");
            });
        });
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
    async forwardLookupResponse(sourcePeer, payload) {
        const response = decodeLookupResponse(payload);
        const reverseKey = lookupReverseKey(response.requestId, response.target);
        this.pruneLookupReversePaths(Date.now());
        const reverse = this.lookupReversePaths.get(reverseKey);
        if (!reverse || reverse.peer === sourcePeer) {
            this.cfg.logger.debug("lookup response not forwarded", nodeAddrToHex(response.target));
            return;
        }
        const nextMtu = Math.min(response.pathMtu, frameCapacity(sourcePeer), frameCapacity(reverse.peer));
        if (nextMtu < reverse.request.minMtu)
            return;
        this.cacheCoordinates(response.target, response.targetCoords);
        this.learnReverseRoute(nodeAddrToHex(response.target), sourcePeer, Math.min(response.pathMtu, frameCapacity(sourcePeer)));
        this.lookupReversePaths.delete(reverseKey);
        response.pathMtu = nextMtu;
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
        if (pending.targetPubkey) {
            const proofDigest = sha256(lookupResponseProofBytes(response.requestId, response.target, response.targetCoords));
            if (!verifySchnorr(response.proof, proofDigest, pending.targetPubkey.subarray(1))) {
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
        this.lookupBackoff.recordSuccess(pending.targetHex);
        this.originLookups.complete(pending, peerNodeKey(sourcePeer));
        this.cfg.logger.debug("lookup response accepted", pending.targetHex);
        return true;
    }
    originLookupPeers(excludedPeer, minMtu = 0) {
        const defaultPeer = this.cfg.defaultRoute ? this.cfg.getPeerByPubkey(this.cfg.defaultRoute) : undefined;
        return [...this.cfg.getPeers()].filter((peer) => {
            if (peer === excludedPeer || peer.link.state !== "established" || frameCapacity(peer) < minMtu)
                return false;
            if (this.cfg.routingMode === "reply_learned")
                return true;
            return peer === defaultPeer || this.treeState.isTreePeer(peerNodeAddr(peer), peerNodeKey(peer));
        });
    }
    async retryOriginLookup(pending, request, excludedPeer) {
        let attempt = 0;
        await this.originLookups.retry(pending, async () => {
            const encoded = encodeLookupRequestPayload({ ...request, requestId: pending.requestId });
            const candidates = this.originLookupPeers(excludedPeer, pending.minMtu);
            const defaultPeer = this.cfg.defaultRoute ? this.cfg.getPeerByPubkey(this.cfg.defaultRoute) : undefined;
            const treeScope = this.cfg.routingMode === "reply_learned"
                ? { isTreePeer: (peer) => this.treeState.isTreePeer(peerNodeAddr(peer), peerNodeKey(peer)), strictTreeOnly: false }
                : undefined;
            const filtered = attempt < 2 && pending.minMtu === 0
                ? filterLookupPeersByBloom(candidates, request.target, pending.targetHex, defaultPeer, true, treeScope)
                : candidates.filter((peer) => !peer.clientOnly || peerNodeKey(peer) === pending.targetHex);
            attempt += 1;
            await Promise.allSettled(filtered.slice(0, MAX_REPLY_LEARNED_LOOKUP_PEERS).map((peer) => this.cfg.sendLinkMessage(peer, LinkMessageType.LookupRequest, encoded)));
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
        const sendFrame = async (payload, existing) => {
            const minMtu = payload.length + ROUTED_FRAME_OVERHEAD;
            let hop = nextHop;
            if (this.pathMtuFor(destNodeHex, hop) < minMtu) {
                let fallback = this.nextHopFor(destNodeHex, previousHop, minMtu);
                if (!fallback) {
                    const resolved = await this.refreshTransitRoute(datagram.destAddr, destNodeHex, previousHop, minMtu);
                    fallback = selectCarrier(this.cfg.getPeerByNodeAddr(resolved ?? ""), this.cfg.getPeers(), previousHop, minMtu);
                }
                if (!fallback)
                    throw new Error(`no route to ${destNodeHex} with MTU ${minMtu}`);
                hop = fallback;
                nextHop = fallback;
            }
            await this.sendSessionDatagramVia(hop, existing ?? { ...datagram, payload });
        };
        if (typeof datagram.payload === "function") {
            for (const payload of datagram.payload(nextHop))
                await sendFrame(payload);
        }
        else {
            await sendFrame(datagram.payload, datagram);
        }
    }
    pathMtuFor(destination, peer, nowMs = Date.now()) {
        const nextHop = peerNodeKey(peer);
        const capacity = frameCapacity(peer);
        const verified = destination === nextHop
            ? capacity
            : this.learnedRoutes.pathMtu(destination, nextHop, nowMs) ?? FSP_DEFAULT_PATH_MTU;
        return Math.min(capacity, verified);
    }
    nextHopFor(destNodeHex, excludedPeer, minMtu = 0) {
        const nowMs = minMtu > 0 || this.cfg.routingMode === "reply_learned" ? Date.now() : 0;
        const usablePeer = (nodeHex) => {
            const peer = selectCarrier(this.cfg.getPeerByNodeAddr(nodeHex), this.cfg.getPeers(), excludedPeer, minMtu);
            return peer && (minMtu === 0 || this.pathMtuFor(destNodeHex, peer, nowMs) >= minMtu) ? peer : undefined;
        };
        const direct = usablePeer(destNodeHex);
        if (direct)
            return direct;
        let cachedHop;
        let cachedPeer;
        const canSend = (nodeHex) => {
            const peer = usablePeer(nodeHex);
            if (!peer)
                return false;
            cachedHop = nodeHex;
            cachedPeer = peer;
            return true;
        };
        if (this.cfg.routingMode === "reply_learned") {
            const learnedNodeHex = this.learnedRoutes.selectNextHop(destNodeHex, nowMs, canSend);
            if (learnedNodeHex)
                return learnedNodeHex === cachedHop ? cachedPeer : usablePeer(learnedNodeHex);
        }
        const destCoords = this.coordCache.get(destNodeHex);
        if (destCoords) {
            const treeNodeHex = this.treeState.nextHop(destCoords, canSend);
            if (treeNodeHex)
                return treeNodeHex === cachedHop ? cachedPeer : usablePeer(treeNodeHex);
        }
        const defaultPeer = this.cfg.defaultRoute ? this.cfg.getPeerByPubkey(this.cfg.defaultRoute) : undefined;
        return defaultPeer ? usablePeer(peerNodeKey(defaultPeer)) : undefined;
    }
    pruneLookupReversePaths(nowMs) {
        for (const [key, reverse] of this.lookupReversePaths) {
            if (reverse.expiresAtMs <= nowMs)
                this.lookupReversePaths.delete(key);
        }
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
        const promise = resolveTransportIdentity(this.cfg.transports, destNodeAddr, abort, this.cfg.isStarted)
            .then((resolved) => this.cfg.connectKnownPeer(resolved.transport, resolved.remoteAddr, resolved.remotePubkey));
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
    /** Resolve only the identity: FSP signaling can be needed before its carrier exists. */
    async resolveIdentity(nodeAddr, abort) {
        const adjacent = this.cfg.getPeerByNodeAddr(nodeAddrToHex(nodeAddr));
        if (adjacent?.link.state === "established" && adjacent.pubkey)
            return adjacent.pubkey;
        return (await resolveTransportIdentity(this.cfg.transports, nodeAddr, abort, this.cfg.isStarted)).remotePubkey;
    }
}
//# sourceMappingURL=FipsRouting.js.map