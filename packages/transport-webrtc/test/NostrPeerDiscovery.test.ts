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


it("restores through an injected provider without opening a relay and keeps advert validation", async () => {
  const identity = await identityFromSecretKey(new Uint8Array(32).fill(0x62));
  const now = Math.floor(Date.now() / 1_000);
  const event = signEvent(identity, { kind: FIPS_ADVERT_KIND, created_at: now,
    tags: [["d", FIPS_ADVERT_D_TAG], ["protocol", FIPS_ADVERT_D_TAG],
      ["version", "1"], ["expiration", String(now + 600)]],
    content: JSON.stringify(advertContent(toHex(identity.publicKey))) });
  const published: NostrEvent[] = [], received: NostrEvent[] = [];
  let closed = false;
  const relay = new FakeRelay();
  const discovery = new NostrPeerDiscovery({ identity, relays: [relayClient(relay)],
    provider: {
      publish: async value => { published.push(value); },
      subscribe: async (filter, onEvent) => {
        expect(filter).toMatchObject({ kinds: [FIPS_ADVERT_KIND], "#d": [FIPS_ADVERT_D_TAG] });
        onEvent(event, "local-cache");
        onEvent({ ...event, content: "tampered" }, "local-cache");
        onEvent(signEvent(identity, { kind: FIPS_ADVERT_KIND, created_at: now - 601,
          tags: [["d", FIPS_ADVERT_D_TAG], ["protocol", FIPS_ADVERT_D_TAG], ["expiration", String(now - 1)]],
          content: event.content }), "local-cache");
        return () => { closed = true; };
      },
    },
  });
  await discovery.subscribeAdverts(value => received.push(value));
  await discovery.publishAdvert(advertContent(toHex(identity.publicKey)));
  expect(received).toEqual([event]);
  expect(published).toHaveLength(1);
  expect(relay.filters).toEqual([]);
  expect(relay.published).toEqual([]);
  discovery.stop(); expect(closed).toBe(true);
});

it("closes a provider whose restoration completes after discovery stops", async () => {
  const identity = await identityFromSecretKey(new Uint8Array(32).fill(0x63));
  let finish!: (close: () => void) => void;
  let closes = 0;
  const pending = new Promise<() => void>(resolve => { finish = resolve; });
  const discovery = new NostrPeerDiscovery({ identity, relays: [], provider: {
    publish: async () => {}, subscribe: async () => pending,
  } });
  const opening = discovery.subscribeAdverts(() => { throw new Error("stopped discovery delivered an advert"); });
  discovery.stop();
  finish(() => { closes++; });
  const close = await opening;
  close(); discovery.stop();
  expect(closes).toBe(1);
});
