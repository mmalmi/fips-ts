import type { DiscoveredPeer } from "@fips/core";

import type { NostrEvent } from "./NostrRelayClient.js";

export function waitForIceGatheringComplete(
  pc: RTCPeerConnection,
  timeoutMs: number,
): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, timeoutMs);
    function onChange() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    }
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

export class AsyncEventStream<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.values.length = 0;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

export async function* emptyAsyncIterable<T>(): AsyncIterable<T> {
  return;
}

export function normalizeSignalRelays(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const relays: string[] = [];
  for (const candidate of value.slice(0, 8)) {
    if (typeof candidate !== "string") continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") continue;
      const normalized = parsed.toString();
      if (!relays.includes(normalized)) relays.push(normalized);
    } catch {
      /* Invalid advertised relay URL. */
    }
  }
  return relays;
}

export function cloneDiscoveredPeer(peer: DiscoveredPeer): DiscoveredPeer {
  return {
    remoteAddr: { ...peer.remoteAddr },
    publicKey: peer.publicKey ? new Uint8Array(peer.publicKey) : undefined,
    meta: peer.meta
      ? Object.fromEntries(Object.entries(peer.meta).map(([key, value]) => [
        key,
        Array.isArray(value) ? [...value] : value,
      ]))
      : undefined,
  };
}

export function advertExpiryMs(
  event: NostrEvent,
  ttlMs: number,
  nowMs: number,
): number | undefined {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return undefined;
  const createdAtMs = event.created_at * 1_000;
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) return undefined;
  const localExpiryMs = Math.min(createdAtMs + ttlMs, nowMs + ttlMs);
  const expiration = event.tags.find((tag) => tag[0] === "expiration")?.[1];
  if (expiration === undefined) return localExpiryMs;
  if (!/^\d+$/.test(expiration)) return undefined;
  const advertisedExpiryMs = Number(expiration) * 1_000;
  if (!Number.isSafeInteger(advertisedExpiryMs)) return undefined;
  return Math.min(localExpiryMs, advertisedExpiryMs);
}
