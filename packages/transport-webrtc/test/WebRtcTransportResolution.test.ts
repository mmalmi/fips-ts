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

function advertEvent(identity: FipsIdentity, expirationOffsetSeconds = 60): NostrEvent {
  const now = Math.floor(Date.now() / 1_000);
  const advert: FipsAdvertContent = {
    identifier: FIPS_ADVERT_D_TAG,
    version: 1,
    endpoints: [{ transport: "webrtc", addr: toHex(identity.publicKey) }],
    signalRelays: ["ws://resolver.test"],
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

  it("resolves a cached signature-validated advert identity", async () => {
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
      relay.emit(advertEvent(remote));
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
});
