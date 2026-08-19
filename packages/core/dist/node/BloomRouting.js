import { BloomFilter } from "../bloom/index.js";
import { bytesEqual } from "../codec/hex.js";
import { deriveNodeAddr, nodeAddrToHex } from "../nodeaddr/index.js";
import { buildFilterAnnounce, decodeFilterAnnounce, encodeFilterAnnounce, } from "../protocol/filter.js";
import { LinkMessageType } from "../protocol/link.js";
const MAX_INBOUND_FILTER_FPR = 0.05;
export class BloomRouting {
    cfg;
    sequence = 0n;
    constructor(cfg) {
        this.cfg = cfg;
    }
    schedule(peer) {
        setTimeout(() => {
            void this.send(peer).catch((error) => {
                this.cfg.emitError(error, "send FilterAnnounce");
            });
        }, 0);
    }
    async sendAll(excludedPeer) {
        const peers = [...this.cfg.getPeers()].filter((peer) => peer !== excludedPeer && peer.link.state === "established");
        await Promise.allSettled(peers.map((peer) => this.send(peer)));
    }
    async handle(peer, payload) {
        const encoded = new Uint8Array(payload.length + 1);
        encoded[0] = LinkMessageType.FilterAnnounce;
        encoded.set(payload, 1);
        const announce = decodeFilterAnnounce(encoded);
        if (announce.sequence <= (peer.inboundFilterSequence ?? 0n))
            return;
        const fpr = announce.filter.fillRatio() ** announce.filter.hashCount;
        if (fpr > MAX_INBOUND_FILTER_FPR) {
            this.cfg.logger.warn("filter announce rejected above FPR cap", peerNodeKey(peer));
            return;
        }
        peer.inboundFilter = announce.filter;
        peer.inboundFilterSequence = announce.sequence;
        this.cfg.logger.debug("filter announce accepted", peerNodeKey(peer), "entries-bits", announce.filter.countOnes());
        if (this.cfg.isTreePeer(deriveNodeAddr(peer.pubkey)))
            await this.sendAll(peer);
    }
    async send(peer) {
        if (peer.link.state !== "established")
            return;
        const filter = this.outgoingFilterFor(peer);
        if (peer.outboundFilter && sameFilter(peer.outboundFilter, filter))
            return;
        const previous = peer.outboundFilter;
        peer.outboundFilter = filter;
        this.sequence += 1n;
        const encoded = encodeFilterAnnounce(buildFilterAnnounce(filter, this.sequence));
        try {
            await this.cfg.sendLinkMessage(peer, LinkMessageType.FilterAnnounce, encoded.subarray(1));
        }
        catch (error) {
            if (peer.outboundFilter === filter)
                peer.outboundFilter = previous;
            throw error;
        }
        this.cfg.logger.debug("filter announce sent", peerNodeKey(peer), "entries-bits", filter.countOnes());
    }
    outgoingFilterFor(excludedPeer) {
        const filter = BloomFilter.empty();
        filter.insertBytes(this.cfg.identity.nodeAddr);
        for (const peer of this.cfg.getPeers()) {
            if (peer === excludedPeer
                || peer.link.state !== "established"
                || !peer.inboundFilter
                || !this.cfg.isTreePeer(deriveNodeAddr(peer.pubkey)))
                continue;
            filter.merge(peer.inboundFilter);
        }
        return filter;
    }
}
function peerNodeKey(peer) {
    return nodeAddrToHex(deriveNodeAddr(peer.pubkey));
}
function sameFilter(left, right) {
    return bytesEqual(left.asBytes(), right.asBytes())
        && left.hashCount === right.hashCount;
}
//# sourceMappingURL=BloomRouting.js.map