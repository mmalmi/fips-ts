import { BloomFilter } from "../bloom/index.js";
import { buildFilterAnnounce, decodeFilterAnnouncePayload, encodeFilterAnnouncePayload, } from "../protocol/filter.js";
import { LinkMessageType } from "../protocol/link.js";
import { noopLogger } from "../transport/types.js";
import { peerNodeAddr, peerNodeKey } from "./PeerState.js";
// Match native FIPS's default antipoison cap. Legitimate aggregated seed filters
// can exceed the former 5% limit well before reaching the fixed filter's ceiling.
const MAX_INBOUND_FILTER_FPR = 0.20;
// Coalesce rapid cascading Bloom updates into a 50 ms trailing flush while
// allowing an initial two-update burst on fresh/idle links (0 ms small-mesh latency).
const BLOOM_DEBOUNCE_MS = 50;
export class BloomRouting {
    cfg;
    sequence = 0n;
    debugEnabled;
    selfFilter;
    pendingBroadcast;
    peerDebounce = new WeakMap();
    deferredPeers = new Set();
    flushTimer;
    flushDueMs = Infinity;
    constructor(cfg) {
        this.cfg = cfg;
        this.debugEnabled = cfg.logger !== noopLogger;
        this.selfFilter = BloomFilter.empty();
        this.selfFilter.insertBytes(cfg.identity.nodeAddr);
    }
    stop() {
        this.pendingBroadcast = undefined;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }
        this.flushDueMs = Infinity;
        this.deferredPeers.clear();
        this.peerDebounce = new WeakMap();
    }
    schedule(peer) {
        setTimeout(() => {
            if (this.deferredPeers.has(peer) || !this.shouldAnnounceTo(peer))
                return;
            void this.send(peer).catch((error) => {
                peer.filterAnnounced = false;
                this.cfg.emitError(error, "send FilterAnnounce");
            });
        }, 0);
    }
    sendAll(excludedPeer) {
        if (this.cfg.strictClient)
            return Promise.resolve();
        if (this.pendingBroadcast) {
            if (!excludedPeer || this.pendingBroadcast.excluded !== excludedPeer) {
                this.pendingBroadcast.all = true;
                this.pendingBroadcast.excluded = undefined;
            }
            return this.pendingBroadcast.promise;
        }
        const state = {
            excluded: excludedPeer,
            all: !excludedPeer,
            promise: undefined,
        };
        state.promise = Promise.resolve().then(async () => {
            if (this.pendingBroadcast === state)
                this.pendingBroadcast = undefined;
            const skip = state.all ? undefined : state.excluded;
            const peers = [...this.cfg.getPeers()].filter((peer) => peer !== skip && peer.link.state === "established" && this.shouldAnnounceTo(peer));
            await this.dispatchPeers(peers);
        });
        this.pendingBroadcast = state;
        return state.promise;
    }
    async handle(peer, payload) {
        const announce = decodeFilterAnnouncePayload(payload);
        if (announce.sequence <= (peer.inboundFilterSequence ?? 0n))
            return;
        const ones = announce.filter.countOnes();
        const fpr = (ones / announce.filter.numBits) ** announce.filter.hashCount;
        if (fpr > MAX_INBOUND_FILTER_FPR) {
            this.cfg.logger.warn("filter announce rejected above FPR cap", peerNodeKey(peer));
            return;
        }
        const unchanged = peer.inboundFilter?.equals(announce.filter) ?? false;
        peer.inboundFilter = announce.filter;
        peer.inboundFilterSequence = announce.sequence;
        if (this.debugEnabled) {
            this.cfg.logger.debug("filter announce accepted", peerNodeKey(peer), "entries-bits", ones);
        }
        if (!unchanged && this.cfg.isTreePeer(peerNodeAddr(peer), peerNodeKey(peer)))
            await this.sendAll(peer);
    }
    shouldAnnounceTo(peer) {
        return peer.clientOnly === true
            || peer.routingRoleSequence === undefined
            || this.cfg.isTreePeer(peerNodeAddr(peer), peerNodeKey(peer));
    }
    async dispatchPeers(peers, flushing = false) {
        if (peers.length === 0)
            return;
        const nowMs = Date.now();
        const ready = [];
        for (const peer of peers) {
            if (!flushing && this.deferredPeers.has(peer))
                continue;
            const dueMs = this.nextAllowedMs(peer, nowMs);
            if (dueMs <= nowMs) {
                this.deferredPeers.delete(peer);
                ready.push(peer);
            }
            else {
                this.deferredPeers.add(peer);
                this.scheduleFlush(dueMs, nowMs);
            }
        }
        if (ready.length === 0)
            return;
        const sources = this.collectFilterSources();
        const sourcePeers = new Set(sources.map((source) => source.peer));
        const fullFilter = this.buildFilter(sources, undefined);
        await Promise.allSettled(ready.map((peer) => {
            const filter = sourcePeers.has(peer) ? this.buildFilter(sources, peer) : fullFilter;
            return this.send(peer, filter);
        }));
    }
    nextAllowedMs(peer, nowMs) {
        const state = this.peerDebounce.get(peer.link);
        if (!state || !state.burstUsed)
            return nowMs;
        const dueMs = state.lastSendMs + BLOOM_DEBOUNCE_MS;
        return dueMs <= nowMs ? nowMs : dueMs;
    }
    recordSend(peer, nowMs) {
        const state = this.peerDebounce.get(peer.link);
        if (!state || nowMs - state.lastSendMs >= BLOOM_DEBOUNCE_MS * 2) {
            this.peerDebounce.set(peer.link, { lastSendMs: nowMs, burstUsed: false });
        }
        else {
            state.lastSendMs = nowMs;
            state.burstUsed = true;
        }
    }
    scheduleFlush(dueMs, nowMs) {
        if (this.flushTimer && dueMs >= this.flushDueMs)
            return;
        if (this.flushTimer)
            clearTimeout(this.flushTimer);
        this.flushDueMs = dueMs;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            this.flushDueMs = Infinity;
            void this.flushDeferred();
        }, Math.max(1, dueMs - nowMs));
    }
    async flushDeferred() {
        if (this.cfg.strictClient || this.deferredPeers.size === 0)
            return;
        const pending = [...this.deferredPeers];
        this.deferredPeers.clear();
        const active = pending.filter((peer) => peer.link.state === "established" && this.shouldAnnounceTo(peer));
        await this.dispatchPeers(active, true);
    }
    async send(peer, precomputed) {
        if (this.cfg.strictClient || peer.link.state !== "established")
            return;
        const filter = precomputed ?? this.buildFilter(this.collectFilterSources(), peer);
        if (peer.outboundFilter?.equals(filter))
            return;
        const previous = peer.outboundFilter;
        peer.outboundFilter = filter;
        this.sequence += 1n;
        const payload = encodeFilterAnnouncePayload(buildFilterAnnounce(filter, this.sequence));
        try {
            await this.cfg.sendLinkMessage(peer, LinkMessageType.FilterAnnounce, payload);
        }
        catch (error) {
            if (peer.outboundFilter === filter)
                peer.outboundFilter = previous;
            throw error;
        }
        this.recordSend(peer, Date.now());
        if (this.debugEnabled) {
            this.cfg.logger.debug("filter announce sent", peerNodeKey(peer), "entries-bits", filter.countOnes());
        }
    }
    collectFilterSources() {
        if (!this.cfg.forwarding)
            return [];
        const sources = [];
        for (const peer of this.cfg.getPeers()) {
            if (peer.link.state !== "established")
                continue;
            if (peer.clientOnly) {
                sources.push({ peer, nodeAddr: peerNodeAddr(peer) });
            }
            else if (peer.inboundFilter && this.cfg.isTreePeer(peerNodeAddr(peer), peerNodeKey(peer))) {
                sources.push({ peer, filter: peer.inboundFilter });
            }
        }
        return sources;
    }
    buildFilter(sources, excludedPeer) {
        if (sources.length === 0 || (excludedPeer !== undefined && sources.length === 1 && sources[0].peer === excludedPeer)) {
            return this.selfFilter;
        }
        const filter = this.selfFilter.clone();
        for (const source of sources) {
            if (source.peer === excludedPeer)
                continue;
            if (source.nodeAddr)
                filter.insertBytes(source.nodeAddr);
            else if (source.filter)
                filter.merge(source.filter);
        }
        return filter;
    }
}
//# sourceMappingURL=BloomRouting.js.map