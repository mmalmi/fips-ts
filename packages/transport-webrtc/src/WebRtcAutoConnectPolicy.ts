import type { DiscoveredPeer } from "@fips/core";

interface AutoConnectCandidate {
  peer: DiscoveredPeer;
  expiresAtMs: number;
}

export class WebRtcAutoConnectPolicy {
  private readonly preferredRanks = new Map<string, number>();

  constructor(preferredPeers: string[]) {
    for (const [rank, peer] of preferredPeers.entries()) {
      const normalized = peer.toLowerCase();
      if (
        /^(02|03)[0-9a-f]{64}$/.test(normalized)
        && !this.preferredRanks.has(normalized)
      ) this.preferredRanks.set(normalized, rank);
    }
  }

  partitionByInitiator<T extends AutoConnectCandidate>(
    candidates: T[],
    localXOnlyPubkey: string,
    acceptsConnections: boolean,
  ): { outbound: T[]; inbound: T[] } {
    if (!acceptsConnections) return { outbound: candidates, inbound: [] };
    // Both accepting peers see the same adverts. Only the lower x-only
    // identity dials automatically; both can still resolve either advert.
    return {
      outbound: candidates.filter((candidate) => (
        localXOnlyPubkey < candidate.peer.remoteAddr.addr.slice(2)
      )),
      inbound: candidates.filter((candidate) => (
        localXOnlyPubkey >= candidate.peer.remoteAddr.addr.slice(2)
      )),
    };
  }

  sort<T extends AutoConnectCandidate>(
    candidates: T[],
    attempts: ReadonlyMap<string, number>,
  ): T[] {
    return candidates.sort((left, right) => {
      const preference = this.rank(left) - this.rank(right);
      if (preference !== 0) return preference;
      const leftAttempt = attempts.get(left.peer.remoteAddr.addr) ?? 0;
      const rightAttempt = attempts.get(right.peer.remoteAddr.addr) ?? 0;
      return leftAttempt - rightAttempt || right.expiresAtMs - left.expiresAtMs;
    });
  }

  isPreferred(remote: string): boolean {
    return this.preferredRanks.has(remote);
  }

  shouldReserveSlot(
    cachedPeers: Iterable<string>,
    ...activePeerSets: Iterable<string>[]
  ): boolean {
    if (this.preferredRanks.size === 0) return false;
    const cached = new Set(cachedPeers);
    const active = new Set(activePeerSets.flatMap((peers) => [...peers]));
    return [...this.preferredRanks.keys()].some((peer) => !cached.has(peer) && !active.has(peer));
  }

  connectionLimit(maximum: number, reservePreferredSlot: boolean, remote: string): number {
    return Math.max(0, maximum - (reservePreferredSlot && !this.isPreferred(remote) ? 1 : 0));
  }

  private rank(candidate: AutoConnectCandidate): number {
    return this.preferredRanks.get(candidate.peer.remoteAddr.addr) ?? Number.MAX_SAFE_INTEGER;
  }
}
