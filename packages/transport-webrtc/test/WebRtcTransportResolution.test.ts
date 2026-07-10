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
  FIPS_PROTOCOL_VERSION,
  WebRtcTransport,
  signEvent,
  type FipsAdvertContent,
  type NostrEvent,
  type NostrFilter,
  type NostrRelayClient,
} from "../src/index.js";

class FakeRelay {
  readonly url = "ws://resolver.test";
  private subscriptions: Array<{
    filter: NostrFilter;
    handler: (event: NostrEvent) => void;
  }> = [];

  async connect(): Promise<void> {}
  async publish(): Promise<void> {}

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
        meta: { source: "nostr-advert" },
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
});
