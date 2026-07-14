import { advertExpiryMs, cloneDiscoveredPeer, } from "./WebRtcTransportSupport.js";
const MAX_ADVERT_CACHE_ENTRIES = 256;
export class WebRtcAdvertCache {
    advertTtlMs;
    onEvict;
    entries = new Map();
    constructor(advertTtlMs, onEvict) {
        this.advertTtlMs = advertTtlMs;
        this.onEvict = onEvict;
    }
    clear() {
        this.entries.clear();
    }
    values() {
        return this.entries.values();
    }
    store(nodeAddrHex, peer, event, nowMs = Date.now()) {
        this.prune(nowMs);
        const expiresAtMs = advertExpiryMs(event, this.advertTtlMs, nowMs);
        if (expiresAtMs === undefined || expiresAtMs <= nowMs)
            return undefined;
        const existing = this.entries.get(nodeAddrHex);
        if (existing && existing.createdAtSeconds > event.created_at) {
            return cloneDiscoveredPeer(existing.peer);
        }
        if (existing)
            this.entries.delete(nodeAddrHex);
        while (this.entries.size >= MAX_ADVERT_CACHE_ENTRIES) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined)
                break;
            this.evict(oldest);
        }
        this.entries.set(nodeAddrHex, {
            peer: cloneDiscoveredPeer(peer),
            createdAtSeconds: event.created_at,
            expiresAtMs,
        });
        return cloneDiscoveredPeer(peer);
    }
    get(nodeAddrHex, nowMs = Date.now()) {
        const cached = this.entries.get(nodeAddrHex);
        if (!cached)
            return undefined;
        if (cached.expiresAtMs <= nowMs) {
            this.evict(nodeAddrHex);
            return undefined;
        }
        this.entries.delete(nodeAddrHex);
        this.entries.set(nodeAddrHex, cached);
        return cloneDiscoveredPeer(cached.peer);
    }
    prune(nowMs) {
        for (const [nodeAddrHex, cached] of this.entries) {
            if (cached.expiresAtMs <= nowMs)
                this.evict(nodeAddrHex);
        }
    }
    evict(nodeAddrHex) {
        const evicted = this.entries.get(nodeAddrHex);
        if (!evicted)
            return;
        this.entries.delete(nodeAddrHex);
        this.onEvict(evicted.peer.remoteAddr.addr);
    }
}
//# sourceMappingURL=WebRtcAdvertCache.js.map