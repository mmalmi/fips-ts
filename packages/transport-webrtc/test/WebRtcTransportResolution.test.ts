import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deriveNodeAddr,
  identityFromSecretKey,
  nodeAddrToHex,
  toHex,
  type FipsIdentity,
  type TransportContext,
} from "@fips/core";

import {
  FIPS_ADVERT_D_TAG,
  FIPS_ADVERT_KIND,
  DEFAULT_FIPS_ADVERT_TTL_MS,
  FIPS_PROTOCOL_VERSION,
  WebRtcTransport,
  signEvent,
  type FipsAdvertContent,
  type NostrEvent,
  type NostrFilter,
  type NostrRelayClient,
} from "../src/index.js";
import { advertExpiryMs } from "../src/WebRtcTransportSupport.js";
import { incomingOfferReplacesPendingDial } from "../src/WebRtcTransport.js";

class FakeRelay {
  readonly url = "ws://resolver.test";
  readonly published: NostrEvent[] = [];
  private subscriptions: Array<{
    filter: NostrFilter;
    handler: (event: NostrEvent) => void;
  }> = [];

  async connect(): Promise<void> {}
  async publish(event: NostrEvent): Promise<void> {
    this.published.push(event);
  }

  async subscribe(
    filter: NostrFilter,
    callbacks: { onEvent: (event: NostrEvent) => void },
  ): Promise<() => void> {
    const subscription = { filter, handler: callbacks.onEvent };
    this.subscriptions.push(subscription);
    return () => {
      this.subscriptions = this.subscriptions.filter((entry) => entry !== subscription);
    };
  }

  emit(event: NostrEvent): void {
    for (const { filter, handler } of this.subscriptions) {
      if (!filter.kinds || filter.kinds.includes(event.kind)) handler(event);
    }
  }
}

class FakeRtcPeerConnection {}

function relayClient(relay: FakeRelay): NostrRelayClient {
  return relay as unknown as NostrRelayClient;
}

function transportContext(identity: FipsIdentity): TransportContext {
  return { localIdentity: identity, onPacket: () => undefined };
}

function advertEvent(
  identity: FipsIdentity,
  expirationOffsetSeconds = 60,
  signalRelays = ["ws://resolver.test"],
): NostrEvent {
  const now = Math.floor(Date.now() / 1_000);
  const advert: FipsAdvertContent = {
    identifier: FIPS_ADVERT_D_TAG,
    version: 1,
    endpoints: [{ transport: "webrtc", addr: toHex(identity.publicKey) }],
    signalRelays,
    stunServers: [],
  };
  return signEvent(identity, {
    created_at: now,
    kind: FIPS_ADVERT_KIND,
    tags: [
      ["d", FIPS_ADVERT_D_TAG],
      ["protocol", FIPS_ADVERT_D_TAG],
      ["version", FIPS_PROTOCOL_VERSION],
      ["expiration", String(now + expirationOffsetSeconds)],
    ],
    content: JSON.stringify(advert),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WebRtcTransport NodeAddr resolution", () => {
  it("resolves simultaneous WebRTC dials to the lower public-key initiator", () => {
    const lower = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const higher = "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    expect(incomingOfferReplacesPendingDial(higher, lower)).toBe(true);
    expect(incomingOfferReplacesPendingDial(lower, higher)).toBe(false);
  });

  it("honors the Rust-compatible one-hour advert freshness window", () => {
    const now = Date.now();
    const createdAt = Math.floor((now - 45 * 60 * 1_000) / 1_000);
    const event = {
      created_at: createdAt,
      tags: [["expiration", String(Math.floor((now + 15 * 60 * 1_000) / 1_000))]],
    } as NostrEvent;

    expect(advertExpiryMs(event, DEFAULT_FIPS_ADVERT_TTL_MS, now)).toBeGreaterThan(now);
  });

  it("refreshes its Nostr advert before the published advert expires", async () => {
    vi.useFakeTimers();
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x60));
    const relay = new FakeRelay();
    const transport = new WebRtcTransport({
      relays: [relay.url],
      relayClients: [relayClient(relay)],
      rtcPeerConnection: FakeRtcPeerConnection as unknown as typeof RTCPeerConnection,
      advertiseOnNostr: true,
      advertTtlMs: 2_000,
    });

    await transport.start(transportContext(local));
    expect(relay.published).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(relay.published).toHaveLength(2);
    await transport.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(relay.published).toHaveLength(2);
  });

  it("routes a validated advert through the relay that delivered it", async () => {
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x61));
    const remote = await identityFromSecretKey(new Uint8Array(32).fill(0x62));
    const relay = new FakeRelay();
    const transport = new WebRtcTransport({
      relays: [relay.url],
      relayClients: [relayClient(relay)],
      rtcPeerConnection: FakeRtcPeerConnection as unknown as typeof RTCPeerConnection,
    });

    await transport.start(transportContext(local));
    try {
      relay.emit(advertEvent(remote, 60, ["wss://stale.example"]));
      const resolved = await transport.resolve(remote.nodeAddr);

      expect(resolved).toEqual({
        remoteAddr: { transport: "webrtc", addr: toHex(remote.publicKey) },
        publicKey: remote.publicKey,
        meta: {
          source: "nostr-advert",
          signalRelays: ["ws://resolver.test/"],
        },
      });
    } finally {
      await transport.stop();
    }
  });

  it("waits for a later valid advert and ignores an invalid signed identity", async () => {
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x71));
    const remote = await identityFromSecretKey(new Uint8Array(32).fill(0x72));
    const relay = new FakeRelay();
    const transport = new WebRtcTransport({
      relays: [relay.url],
      relayClients: [relayClient(relay)],
      rtcPeerConnection: FakeRtcPeerConnection as unknown as typeof RTCPeerConnection,
    });

    await transport.start(transportContext(local));
    try {
      const resolving = transport.resolve(remote.nodeAddr);
      relay.emit(advertEvent(remote, -1));
      const invalid = advertEvent(remote);
      invalid.content = invalid.content.replace("webrtc", "tampered");
      relay.emit(invalid);
      await Promise.resolve();

      relay.emit(advertEvent(remote));
      const resolved = await resolving;

      expect(nodeAddrToHex(deriveNodeAddr(resolved!.publicKey!))).toBe(
        nodeAddrToHex(remote.nodeAddr),
      );
    } finally {
      await transport.stop();
    }
  });

  it("rotates to another cached advert when an auto-connected candidate fails", async () => {
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x73));
    const stale = await identityFromSecretKey(new Uint8Array(32).fill(0x74));
    const live = await identityFromSecretKey(new Uint8Array(32).fill(0x75));
    const relay = new FakeRelay();
    const transport = new WebRtcTransport({
      relays: [relay.url],
      relayClients: [relayClient(relay)],
      rtcPeerConnection: FakeRtcPeerConnection as unknown as typeof RTCPeerConnection,
      autoConnect: true,
      maxConnections: 1,
    });

    await transport.start(transportContext(local));
    try {
      const discovered = transport.discover()[Symbol.asyncIterator]();
      relay.emit(advertEvent(stale));
      relay.emit(advertEvent(live));
      const first = await discovered.next();
      expect(first.value?.remoteAddr.addr).toBe(toHex(stale.publicKey));

      await transport.close(first.value!.remoteAddr);
      const replacement = await discovered.next();
      expect(replacement.value?.remoteAddr.addr).toBe(toHex(live.publicKey));
    } finally {
      await transport.stop();
    }
  });

  it("tries every unseen advert before retrying an earlier failed candidate", async () => {
    vi.useFakeTimers();
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x79));
    const candidates = await Promise.all([0x7a, 0x7b, 0x7c, 0x7d].map(
      (byte) => identityFromSecretKey(new Uint8Array(32).fill(byte)),
    ));
    const relay = new FakeRelay();
    const transport = new WebRtcTransport({
      relays: [relay.url],
      relayClients: [relayClient(relay)],
      rtcPeerConnection: FakeRtcPeerConnection as unknown as typeof RTCPeerConnection,
      autoConnect: true,
      maxConnections: 1,
    });

    await transport.start(transportContext(local));
    try {
      const discovered = transport.discover()[Symbol.asyncIterator]();
      for (const candidate of candidates) relay.emit(advertEvent(candidate, 3_600));
      await vi.advanceTimersByTimeAsync(2_000);

      const first = await discovered.next();
      expect(first.value?.remoteAddr.addr).toBe(toHex(candidates[0]!.publicKey));
      await transport.close(first.value!.remoteAddr);
      await vi.advanceTimersByTimeAsync(1_300);

      const second = await discovered.next();
      expect(second.value?.remoteAddr.addr).toBe(toHex(candidates[1]!.publicKey));
      await vi.advanceTimersByTimeAsync(31_000);
      await transport.close(second.value!.remoteAddr);
      await vi.advanceTimersByTimeAsync(1_300);

      const third = await discovered.next();
      expect(third.value?.remoteAddr.addr).toBe(toHex(candidates[2]!.publicKey));
    } finally {
      await transport.stop();
    }
  });

  it("settles the initial relay backlog before choosing the freshest advert", async () => {
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x76));
    const shorter = await identityFromSecretKey(new Uint8Array(32).fill(0x77));
    const fresher = await identityFromSecretKey(new Uint8Array(32).fill(0x78));
    const relay = new FakeRelay();
    const transport = new WebRtcTransport({
      relays: [relay.url],
      relayClients: [relayClient(relay)],
      rtcPeerConnection: FakeRtcPeerConnection as unknown as typeof RTCPeerConnection,
      autoConnect: true,
      maxConnections: 1,
    });

    await transport.start(transportContext(local));
    try {
      const discovered = transport.discover()[Symbol.asyncIterator]();
      relay.emit(advertEvent(shorter, 60));
      relay.emit(advertEvent(fresher, 120));
      expect((await discovered.next()).value?.remoteAddr.addr).toBe(toHex(fresher.publicKey));
    } finally {
      await transport.stop();
    }
  });

  it("keeps queued auto-connect reservations when adverts resolve before connect", async () => {
    vi.useFakeTimers();
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x41));
    const candidates = await Promise.all([0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49]
      .map((byte) => identityFromSecretKey(new Uint8Array(32).fill(byte))));
    const relay = new FakeRelay();
    const queued: string[] = [];
    const transport = new WebRtcTransport({
      relays: [relay.url],
      relayClients: [relayClient(relay)],
      rtcPeerConnection: FakeRtcPeerConnection as unknown as typeof RTCPeerConnection,
      autoConnect: true,
      maxConnections: 8,
      logger: {
        debug: (...args) => {
          if (args[0] === "webrtc auto-connect queued" && typeof args[1] === "string") {
            queued.push(args[1]);
          }
        },
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    await transport.start(transportContext(local));
    try {
      transport.discover()[Symbol.asyncIterator]();
      for (const candidate of candidates) relay.emit(advertEvent(candidate, 3_600));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(queued).toHaveLength(4);

      await Promise.all(candidates.slice(0, 4).map((candidate) =>
        transport.resolve(candidate.nodeAddr)));
      relay.emit(advertEvent(candidates[4]!, 3_600));
      await vi.advanceTimersByTimeAsync(2_000);

      expect(queued).toHaveLength(4);
    } finally {
      await transport.stop();
    }
  });

  it("reserves connection capacity for requested inbound peers", async () => {
    vi.useFakeTimers();
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x51));
    const candidates = await Promise.all([0x52, 0x53, 0x54, 0x55]
      .map((byte) => identityFromSecretKey(new Uint8Array(32).fill(byte))));
    const relay = new FakeRelay();
    const queued: string[] = [];
    const transport = new WebRtcTransport({
      relays: [relay.url],
      relayClients: [relayClient(relay)],
      rtcPeerConnection: FakeRtcPeerConnection as unknown as typeof RTCPeerConnection,
      autoConnect: true,
      maxConnections: 4,
      maxAutoConnections: 2,
      logger: {
        debug: (...args) => {
          if (args[0] === "webrtc auto-connect queued" && typeof args[1] === "string") {
            queued.push(args[1]);
          }
        },
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    await transport.start(transportContext(local));
    try {
      transport.discover()[Symbol.asyncIterator]();
      for (const candidate of candidates) relay.emit(advertEvent(candidate, 3_600));
      await vi.advanceTimersByTimeAsync(2_000);

      expect(queued).toHaveLength(2);
    } finally {
      await transport.stop();
    }
  });

  it("prioritizes a previously successful auto-connect ingress", async () => {
    vi.useFakeTimers();
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x71));
    const arbitrary = await identityFromSecretKey(new Uint8Array(32).fill(0x72));
    const preferred = await identityFromSecretKey(new Uint8Array(32).fill(0x73));
    const relay = new FakeRelay();
    const queued: string[] = [];
    const transport = new WebRtcTransport({
      relays: [relay.url],
      relayClients: [relayClient(relay)],
      rtcPeerConnection: FakeRtcPeerConnection as unknown as typeof RTCPeerConnection,
      autoConnect: true,
      maxConnections: 4,
      maxAutoConnections: 1,
      preferredAutoConnectPeers: [toHex(preferred.publicKey)],
      logger: {
        debug: (...args) => {
          if (args[0] === "webrtc auto-connect queued" && typeof args[1] === "string") {
            queued.push(args[1]);
          }
        },
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    await transport.start(transportContext(local));
    try {
      transport.discover()[Symbol.asyncIterator]();
      relay.emit(advertEvent(arbitrary));
      relay.emit(advertEvent(preferred));
      await vi.advanceTimersByTimeAsync(2_000);

      expect(queued).toEqual([toHex(preferred.publicKey)]);
    } finally {
      await transport.stop();
    }
  });

  it("retries a preferred ingress without the arbitrary-peer cooldown", async () => {
    vi.useFakeTimers();
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x74));
    const preferred = await identityFromSecretKey(new Uint8Array(32).fill(0x75));
    const relay = new FakeRelay();
    const queued: string[] = [];
    const transport = new WebRtcTransport({
      relays: [relay.url],
      relayClients: [relayClient(relay)],
      rtcPeerConnection: FakeRtcPeerConnection as unknown as typeof RTCPeerConnection,
      autoConnect: true,
      maxConnections: 1,
      preferredAutoConnectPeers: [toHex(preferred.publicKey)],
      logger: {
        debug: (...args) => {
          if (args[0] === "webrtc auto-connect queued" && typeof args[1] === "string") {
            queued.push(args[1]);
          }
        },
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    await transport.start(transportContext(local));
    try {
      const discovered = transport.discover()[Symbol.asyncIterator]();
      relay.emit(advertEvent(preferred, 3_600));
      await vi.advanceTimersByTimeAsync(2_500);
      const first = await discovered.next();
      expect(first.value?.remoteAddr.addr).toBe(toHex(preferred.publicKey));

      await transport.close(first.value!.remoteAddr);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(queued).toEqual([toHex(preferred.publicKey), toHex(preferred.publicKey)]);
    } finally {
      await transport.stop();
    }
  });

  it("reserves an auto-connect slot for a preferred ingress discovered later", async () => {
    vi.useFakeTimers();
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x74));
    const arbitrary = await Promise.all([0x75, 0x76]
      .map((byte) => identityFromSecretKey(new Uint8Array(32).fill(byte))));
    const preferred = await identityFromSecretKey(new Uint8Array(32).fill(0x77));
    const relay = new FakeRelay();
    const queued: string[] = [];
    const transport = new WebRtcTransport({
      relays: [relay.url],
      relayClients: [relayClient(relay)],
      rtcPeerConnection: FakeRtcPeerConnection as unknown as typeof RTCPeerConnection,
      autoConnect: true,
      maxConnections: 4,
      maxAutoConnections: 2,
      preferredAutoConnectPeers: [toHex(preferred.publicKey)],
      logger: {
        debug: (...args) => {
          if (args[0] === "webrtc auto-connect queued" && typeof args[1] === "string") {
            queued.push(args[1]);
          }
        },
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    await transport.start(transportContext(local));
    try {
      transport.discover()[Symbol.asyncIterator]();
      arbitrary.forEach((candidate) => relay.emit(advertEvent(candidate)));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(queued).toHaveLength(1);

      relay.emit(advertEvent(preferred));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(queued).toContain(toHex(preferred.publicKey));
      expect(queued).toHaveLength(2);
    } finally {
      await transport.stop();
    }
  });
});
