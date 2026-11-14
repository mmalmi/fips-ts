import type { DiscoveredPeer } from "@fips/core";

interface AutoConnectCandidate {
  peer: DiscoveredPeer;
  createdAtSeconds: number;
  expiresAtMs: number;
}

const FAILURE_COOLDOWN_MS = 30_000;
// Preferred peers (an application's own devices or ingress) retry promptly and
// are never put in the long wait, like native auto-reconnect peers, but back
// off so a closed device whose advert lingers is not redialed every second.
const PREFERRED_FAILURE_COOLDOWN_MS = 1_000;
const PREFERRED_MAX_COOLDOWN_MS = 30_000;
// Rust FIPS Nostr failure state: after five consecutive failures, suppress a
// peer's retries for 30 minutes so dead or full adverts stop costing a
// mesh-wide route lookup every 30 seconds.
const FAILURE_STREAK_THRESHOLD = 5;
const EXTENDED_COOLDOWN_MS = 30 * 60_000;
const MAX_FAILURE_STREAKS = 1_024;
// Publishers refresh at half their advert lifetime. A copy older than that,
// plus this grace, missed its refresh and most likely belongs to a gone node.
const ADVERT_REFRESH_GRACE_MS = 5 * 60_000;

export class WebRtcAutoConnectPolicy {
  private readonly preferredRanks = new Map<string, number>();
  private readonly cooldowns = new Map<string, {
    until: number;
    awaitingSessionRecovery: boolean;
  }>();
  private readonly failureStreaks = new Map<string, number>();

  constructor(preferredPeers: readonly string[]) {
    this.setPreferredPeers(preferredPeers);
  }

  /**
   * Replace the preferred identities (compressed or x-only hex; either parity
   * matches). Returns the x-only keys that became preferred, whose earlier
   * failure cooldowns no longer apply.
   */
  setPreferredPeers(peers: readonly string[]): string[] {
    const next = new Map<string, number>();
    for (const peer of peers) {
      const key = identityKey(peer);
      if (key && !next.has(key)) next.set(key, next.size);
    }
    const added = [...next.keys()].filter((key) => !this.preferredRanks.has(key));
    this.preferredRanks.clear();
    for (const [key, rank] of next) this.preferredRanks.set(key, rank);
    for (const key of added) {
      for (const remote of [...this.cooldowns.keys(), ...this.failureStreaks.keys()]) {
        if (identityKey(remote) !== key) continue;
        this.cooldowns.delete(remote);
        this.failureStreaks.delete(remote);
      }
    }
    return added;
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
    nowMs = Date.now(),
  ): T[] {
    return candidates.sort((left, right) => {
      const preference = this.rank(left) - this.rank(right);
      if (preference !== 0) return preference;
      const freshness = Number(missedRefresh(left, nowMs)) - Number(missedRefresh(right, nowMs));
      if (freshness !== 0) return freshness;
      const leftAttempt = attempts.get(left.peer.remoteAddr.addr) ?? 0;
      const rightAttempt = attempts.get(right.peer.remoteAddr.addr) ?? 0;
      return leftAttempt - rightAttempt || right.expiresAtMs - left.expiresAtMs;
    });
  }

  isPreferred(remote: string): boolean {
    const key = identityKey(remote);
    return key !== undefined && this.preferredRanks.has(key);
  }

  /**
   * `attributable` is false while this node itself has no working link: such
   * failures say nothing about the remote and must not extend its cooldown.
   */
  recordFailure(remote: string, awaitingSessionRecovery: boolean, attributable = true): void {
    let failures = this.failureStreaks.get(remote) ?? 0;
    if (attributable) {
      failures += 1;
      this.failureStreaks.delete(remote);
      if (this.failureStreaks.size >= MAX_FAILURE_STREAKS) {
        const oldest = this.failureStreaks.keys().next().value as string | undefined;
        if (oldest !== undefined) this.failureStreaks.delete(oldest);
      }
      this.failureStreaks.set(remote, failures);
    }
    const cooldownMs = this.isPreferred(remote)
      ? Math.min(PREFERRED_FAILURE_COOLDOWN_MS * 2 ** Math.max(0, Math.min(failures - 1, 16)), PREFERRED_MAX_COOLDOWN_MS)
      : failures >= FAILURE_STREAK_THRESHOLD ? EXTENDED_COOLDOWN_MS : FAILURE_COOLDOWN_MS;
    this.cooldowns.set(remote, {
      until: Date.now() + cooldownMs,
      awaitingSessionRecovery,
    });
  }

  /** A connected carrier ends the failure streak. */
  recordSuccess(remote: string): void {
    this.failureStreaks.delete(remote);
  }

  /** A newer advert proves the peer is alive: forget its failures and cooldown. */
  advertRefreshed(remote: string): boolean {
    const hadStreak = this.failureStreaks.delete(remote);
    const hadCooldown = this.cooldowns.delete(remote);
    return hadStreak || hadCooldown;
  }

  cooldownUntil(remote: string): number {
    return this.cooldowns.get(remote)?.until ?? 0;
  }

  pruneCooldowns(now: number): void {
    for (const [remote, cooldown] of this.cooldowns) {
      if (cooldown.until <= now) this.cooldowns.delete(remote);
    }
  }

  recoverSession(remote: string): boolean {
    if (!this.cooldowns.get(remote)?.awaitingSessionRecovery) return false;
    this.cooldowns.delete(remote);
    this.failureStreaks.delete(remote);
    return true;
  }

  clearCooldowns(): void {
    this.cooldowns.clear();
    this.failureStreaks.clear();
  }

  shouldReserveSlot(
    cachedPeers: Iterable<string>,
    ...activePeerSets: Iterable<string>[]
  ): boolean {
    if (this.preferredRanks.size === 0) return false;
    const cached = new Set([...cachedPeers].map(identityKey));
    const active = new Set(activePeerSets.flatMap((peers) => [...peers].map(identityKey)));
    return [...this.preferredRanks.keys()].some((peer) => !cached.has(peer) && !active.has(peer));
  }

  connectionLimit(maximum: number, reservePreferredSlot: boolean, remote: string): number {
    return Math.max(0, maximum - (reservePreferredSlot && !this.isPreferred(remote) ? 1 : 0));
  }

  private rank(candidate: AutoConnectCandidate): number {
    const key = identityKey(candidate.peer.remoteAddr.addr);
    return (key === undefined ? undefined : this.preferredRanks.get(key)) ?? Number.MAX_SAFE_INTEGER;
  }
}

/** x-only identity of a compressed or x-only hex key; adverts and rosters may differ in parity. */
function identityKey(pubkeyHex: string): string | undefined {
  const normalized = pubkeyHex.toLowerCase();
  if (/^(02|03)[0-9a-f]{64}$/.test(normalized)) return normalized.slice(2);
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : undefined;
}

function missedRefresh(candidate: AutoConnectCandidate, nowMs: number): boolean {
  const createdAtMs = candidate.createdAtSeconds * 1_000;
  const refreshDueMs = createdAtMs + Math.max(0, candidate.expiresAtMs - createdAtMs) / 2;
  return nowMs > refreshDueMs + ADVERT_REFRESH_GRACE_MS;
}
