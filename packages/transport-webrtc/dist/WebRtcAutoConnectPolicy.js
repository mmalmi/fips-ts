export class WebRtcAutoConnectPolicy {
    preferredRanks = new Map();
    constructor(preferredPeers) {
        for (const [rank, peer] of preferredPeers.entries()) {
            const normalized = peer.toLowerCase();
            if (/^(02|03)[0-9a-f]{64}$/.test(normalized)
                && !this.preferredRanks.has(normalized))
                this.preferredRanks.set(normalized, rank);
        }
    }
    sort(candidates, attempts) {
        return candidates.sort((left, right) => {
            const preference = this.rank(left) - this.rank(right);
            if (preference !== 0)
                return preference;
            const leftAttempt = attempts.get(left.peer.remoteAddr.addr) ?? 0;
            const rightAttempt = attempts.get(right.peer.remoteAddr.addr) ?? 0;
            return leftAttempt - rightAttempt || right.expiresAtMs - left.expiresAtMs;
        });
    }
    isPreferred(remote) {
        return this.preferredRanks.has(remote);
    }
    shouldReserveSlot(cachedPeers, ...activePeerSets) {
        if (this.preferredRanks.size === 0)
            return false;
        const cached = new Set(cachedPeers);
        const active = new Set(activePeerSets.flatMap((peers) => [...peers]));
        return [...this.preferredRanks.keys()].some((peer) => !cached.has(peer) && !active.has(peer));
    }
    connectionLimit(maximum, reservePreferredSlot, remote) {
        return Math.max(0, maximum - (reservePreferredSlot && !this.isPreferred(remote) ? 1 : 0));
    }
    rank(candidate) {
        return this.preferredRanks.get(candidate.peer.remoteAddr.addr) ?? Number.MAX_SAFE_INTEGER;
    }
}
//# sourceMappingURL=WebRtcAutoConnectPolicy.js.map