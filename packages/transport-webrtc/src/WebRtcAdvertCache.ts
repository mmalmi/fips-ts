import type { DiscoveredPeer } from "@fips/core";

import type { NostrEvent } from "./NostrRelayClient.js";
import {
  advertExpiryMs,
  cloneDiscoveredPeer,
} from "./WebRtcTransportSupport.js";

export interface CachedWebRtcAdvert {
  peer: DiscoveredPeer;
  createdAtSeconds: number;
  expiresAtMs: number;
}

const MAX_ADVERT_CACHE_ENTRIES = 256;

export class WebRtcAdvertCache {
  private readonly entries = new Map<string, CachedWebRtcAdvert>();

  constructor(
    private readonly advertTtlMs: number,
    private readonly onEvict: (remoteAddr: string) => void,
  ) {}

  clear(): void {
    this.entries.clear();
  }

  values(): IterableIterator<CachedWebRtcAdvert> {
    return this.entries.values();
  }

  store(
    nodeAddrHex: string,
    peer: DiscoveredPeer,
    event: NostrEvent,
    nowMs = Date.now(),
  ): DiscoveredPeer | undefined {
    this.prune(nowMs);
    const expiresAtMs = advertExpiryMs(event, this.advertTtlMs, nowMs);
    if (expiresAtMs === undefined || expiresAtMs <= nowMs) return undefined;

    const existing = this.entries.get(nodeAddrHex);
    if (existing && existing.createdAtSeconds > event.created_at) {
      return cloneDiscoveredPeer(existing.peer);
    }
    if (existing) this.entries.delete(nodeAddrHex);
    while (this.entries.size >= MAX_ADVERT_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.evict(oldest);
    }
    this.entries.set(nodeAddrHex, {
      peer: cloneDiscoveredPeer(peer),
      createdAtSeconds: event.created_at,
      expiresAtMs,
    });
    return cloneDiscoveredPeer(peer);
  }

  get(nodeAddrHex: string, nowMs = Date.now()): DiscoveredPeer | undefined {
    const cached = this.entries.get(nodeAddrHex);
    if (!cached) return undefined;
    if (cached.expiresAtMs <= nowMs) {
      this.evict(nodeAddrHex);
      return undefined;
    }
    this.entries.delete(nodeAddrHex);
    this.entries.set(nodeAddrHex, cached);
    return cloneDiscoveredPeer(cached.peer);
  }

  prune(nowMs: number): void {
    for (const [nodeAddrHex, cached] of this.entries) {
      if (cached.expiresAtMs <= nowMs) this.evict(nodeAddrHex);
    }
  }

  private evict(nodeAddrHex: string): void {
    const evicted = this.entries.get(nodeAddrHex);
    if (!evicted) return;
    this.entries.delete(nodeAddrHex);
    this.onEvict(evicted.peer.remoteAddr.addr);
  }
}
