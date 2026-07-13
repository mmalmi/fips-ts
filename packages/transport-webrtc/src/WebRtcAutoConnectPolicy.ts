import type { DiscoveredPeer } from "@fips/core";

interface AutoConnectCandidate {
  peer: DiscoveredPeer;
  expiresAtMs: number;
}

export class WebRtcAutoConnectPolicy {
  private readonly preferredRanks = new Map<string, number>();
  private readonly configuredSignalRelays: Set<string>;
  private readonly preferredSignalRelays: string[];

  constructor(
    configuredSignalRelays: string[],
    preferredPeers: string[],
    preferredSignalRelays: string[],
  ) {
    for (const [rank, peer] of preferredPeers.entries()) {
      const normalized = peer.toLowerCase();
      if (
        /^(02|03)[0-9a-f]{64}$/.test(normalized)
        && !this.preferredRanks.has(normalized)
      ) this.preferredRanks.set(normalized, rank);
    }
    this.configuredSignalRelays = new Set(
      configuredSignalRelays.map((relay) => new URL(relay).toString()),
    );
    this.preferredSignalRelays = preferredSignalRelays
      .map((relay) => new URL(relay).toString());
  }

  sort<T extends AutoConnectCandidate>(
    candidates: T[],
    attempts: ReadonlyMap<string, number>,
  ): T[] {
    return candidates.sort((left, right) => {
      const preference = this.rank(left) - this.rank(right);
      if (preference !== 0) return preference;
      const configuredRelayPreference = Number(this.usesConfiguredRelay(right.peer))
        - Number(this.usesConfiguredRelay(left.peer));
      if (configuredRelayPreference !== 0) return configuredRelayPreference;
      const leftAttempt = attempts.get(left.peer.remoteAddr.addr) ?? 0;
      const rightAttempt = attempts.get(right.peer.remoteAddr.addr) ?? 0;
      return leftAttempt - rightAttempt || right.expiresAtMs - left.expiresAtMs;
    });
  }

  isPreferred(remote: string): boolean {
    return this.preferredRanks.has(remote);
  }

  signalRelaysFor(remote: string, advertised: string[]): string[] {
    return this.isPreferred(remote) && this.preferredSignalRelays.length > 0
      ? [...this.preferredSignalRelays]
      : advertised;
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

  private usesConfiguredRelay(peer: DiscoveredPeer): boolean {
    const relays = peer.meta?.signalRelays;
    return Array.isArray(relays)
      && relays.some((relay) => this.configuredSignalRelays.has(new URL(relay).toString()));
  }
}
