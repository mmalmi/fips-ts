import { BloomFilter } from "../bloom/index.js";
import { buildFilterAnnounce, decodeFilterAnnouncePayload, encodeFilterAnnouncePayload, } from "../protocol/filter.js";
import { LinkMessageType } from "../protocol/link.js";
import { noopLogger } from "../transport/types.js";
import { peerNodeAddr, peerNodeKey } from "./PeerState.js";
// Match native FIPS's default antipoison cap. Legitimate aggregated seed filters
// can exceed the former 5% limit well before reaching the fixed filter's ceiling.
const MAX_INBOUND_FILTER_FPR = 0.20;
export class BloomRouting {
    cfg;
    sequence = 0n;
    debugEnabled;
    selfFilter;
    pendingBroadcast;
    constructor(cfg) {
        this.cfg = cfg;
        this.debugEnabled = cfg.logger !== noopLogger;
        this.selfFilter = BloomFilter.empty();
        this.selfFilter.insertBytes(cfg.identity.nodeAddr);
    }
    stop() {
        this.pendingBroadcast = undefined;
    }
    schedule(peer) {
        setTimeout(() => {
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
            const peers = [...this.cfg.getPeers()].filter((peer) => peer !== skip && peer.link.state === "established");
            if (peers.length === 0)
                return;
            const fullFilter = this.outgoingFilterFor(undefined);
            await Promise.allSettled(peers.map((peer) => {
                const splitHorizon = this.cfg.forwarding
                    && (peer.clientOnly || (peer.inboundFilter !== undefined && this.cfg.isTreePeer(peerNodeAddr(peer))));
                return this.send(peer, splitHorizon ? undefined : fullFilter);
            }));
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
        if (!unchanged && this.cfg.isTreePeer(peerNodeAddr(peer)))
            await this.sendAll(peer);
    }
    async send(peer, precomputed) {
        if (this.cfg.strictClient || peer.link.state !== "established")
            return;
        const filter = precomputed ?? this.outgoingFilterFor(peer);
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
        if (this.debugEnabled) {
            this.cfg.logger.debug("filter announce sent", peerNodeKey(peer), "entries-bits", filter.countOnes());
        }
    }
    outgoingFilterFor(excludedPeer) {
        const filter = this.selfFilter.clone();
        if (!this.cfg.forwarding)
            return filter;
        for (const peer of this.cfg.getPeers()) {
            if (peer === excludedPeer || peer.link.state !== "established")
                continue;
            if (peer.clientOnly) {
                filter.insertBytes(peerNodeAddr(peer));
                continue;
            }
            if (!peer.inboundFilter || !this.cfg.isTreePeer(peerNodeAddr(peer)))
                continue;
            filter.merge(peer.inboundFilter);
        }
        return filter;
    }
}
//# sourceMappingURL=BloomRouting.js.map