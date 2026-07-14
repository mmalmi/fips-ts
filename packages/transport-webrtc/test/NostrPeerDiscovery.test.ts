import { describe, expect, it } from "vitest";

import { identityFromSecretKey, toHex } from "@fips/core";

import {
  FIPS_ADVERT_D_TAG,
  FIPS_ADVERT_KIND,
  FIPS_PROTOCOL_VERSION,
  NostrPeerDiscovery,
  type FipsAdvertContent,
} from "../src/NostrPeerDiscovery.js";
import type { NostrEvent, NostrFilter, NostrRelayClient } from "../src/NostrRelayClient.js";
import { signEvent } from "../src/nostrEvent.js";

class FakeRelay {
  readonly url = "ws://relay.test";
  readonly published: NostrEvent[] = [];
  readonly filters: NostrFilter[] = [];
  private handlers: Array<(event: NostrEvent) => void> = [];

  async publish(event: NostrEvent): Promise<void> {
    this.published.push(event);
  }

  async subscribe(
    filter: NostrFilter,
    callbacks: { onEvent: (event: NostrEvent) => void },
  ): Promise<() => void> {
    this.filters.push(filter);
    this.handlers.push(callbacks.onEvent);
    return () => {
      this.handlers = this.handlers.filter((handler) => handler !== callbacks.onEvent);
    };
  }

  emit(event: NostrEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

function relayClient(relay: FakeRelay): NostrRelayClient {
  return relay as unknown as NostrRelayClient;
}

function advertContent(pubkey: string): FipsAdvertContent {
  return {
    identifier: FIPS_ADVERT_D_TAG,
    version: 1,
    endpoints: [
      { transport: "webrtc", addr: pubkey },
      { transport: "nostr_relay", addr: "npub1example" },
    ],
    stunServers: [],
  };
}

describe("NostrPeerDiscovery", () => {
  it("publishes only the public Rust-compatible kind-37195 advert", async () => {
    const identity = await identityFromSecretKey(new Uint8Array(32).fill(0x11));
    const relay = new FakeRelay();
    const discovery = new NostrPeerDiscovery({
      identity,
      relays: [relayClient(relay)],
      discoveryApp: "hashtree-v1",
    });

    await discovery.publishAdvert(advertContent(toHex(identity.publicKey)));

    expect(relay.published).toHaveLength(1);
    const [event] = relay.published;
    expect(event.kind).toBe(FIPS_ADVERT_KIND);
    expect(event.tags).toContainEqual(["d", "hashtree-v1"]);
    expect(event.tags).toContainEqual(["protocol", "hashtree-v1"]);
    expect(event.tags).toContainEqual(["version", FIPS_PROTOCOL_VERSION]);
    expect(Object.keys(JSON.parse(event.content)).sort()).toEqual([
      "endpoints",
      "identifier",
      "stunServers",
      "version",
    ]);
  });

  it("accepts signed app-scoped adverts and reports their source relay", async () => {
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x22));
    const remote = await identityFromSecretKey(new Uint8Array(32).fill(0x33));
    const relay = new FakeRelay();
    const discovery = new NostrPeerDiscovery({
      identity: local,
      relays: [relayClient(relay)],
      discoveryApp: "hashtree-v1",
    });
    const seen: Array<[NostrEvent, string]> = [];

    await discovery.subscribeAdverts((event, _advert, sourceRelay) => {
      seen.push([event, sourceRelay]);
    });
    const event = signEvent(remote, {
      created_at: Math.floor(Date.now() / 1_000),
      kind: FIPS_ADVERT_KIND,
      tags: [
        ["d", "hashtree-v1"],
        ["protocol", "hashtree-v1"],
        ["version", FIPS_PROTOCOL_VERSION],
      ],
      content: JSON.stringify(advertContent(toHex(remote.publicKey))),
    });
    relay.emit(event);

    expect(relay.filters).toEqual([{ kinds: [FIPS_ADVERT_KIND], "#d": ["hashtree-v1"] }]);
    expect(seen).toEqual([[event, "ws://relay.test/"]]);
  });
});
