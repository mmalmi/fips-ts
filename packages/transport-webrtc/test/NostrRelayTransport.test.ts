import { describe, expect, it } from "vitest";

import { identityFromSecretKey, toHex, type TransportContext } from "@fips/core";

import {
  NOSTR_RELAY_DATAGRAM_KIND,
  NostrRelayTransport,
} from "../src/NostrRelayTransport.js";
import type { NostrEvent, NostrFilter, NostrRelayClient } from "../src/NostrRelayClient.js";

class FakeRelay {
  readonly url: string;
  readonly published: NostrEvent[] = [];
  private subscriptions: Array<{
    filter: NostrFilter;
    handler: (event: NostrEvent) => void;
  }> = [];

  constructor(
    url = "ws://relay.test",
    private readonly subscribeError?: Error,
  ) {
    this.url = new URL(url).toString();
  }

  get subscriptionCount(): number {
    return this.subscriptions.length;
  }

  async publish(event: NostrEvent): Promise<void> {
    this.published.push(event);
    for (const subscription of this.subscriptions) {
      if (subscription.filter.kinds?.includes(event.kind)) subscription.handler(event);
    }
  }

  async subscribe(
    filter: NostrFilter,
    callbacks: { onEvent: (event: NostrEvent) => void },
  ): Promise<() => void> {
    if (this.subscribeError) throw this.subscribeError;
    const subscription = { filter, handler: callbacks.onEvent };
    this.subscriptions.push(subscription);
    return () => {
      this.subscriptions = this.subscriptions.filter((item) => item !== subscription);
    };
  }

  close(): void {}
}

function relayClient(relay: FakeRelay): NostrRelayClient {
  return relay as unknown as NostrRelayClient;
}

describe("NostrRelayTransport", () => {
  it("roundtrips a Rust-compatible kind-21060 base64url FIPS datagram", async () => {
    const alice = await identityFromSecretKey(new Uint8Array(32).fill(0x41));
    const bob = await identityFromSecretKey(new Uint8Array(32).fill(0x42));
    const relay = new FakeRelay();
    const received: Parameters<TransportContext["onPacket"]>[0][] = [];
    const aliceTransport = new NostrRelayTransport({
      relays: [relay.url],
      relayClients: [relayClient(relay)],
    });
    const bobTransport = new NostrRelayTransport({
      relays: [relay.url],
      relayClients: [relayClient(relay)],
    });
    await aliceTransport.start({ localIdentity: alice, onPacket: () => undefined });
    await bobTransport.start({ localIdentity: bob, onPacket: (packet) => received.push(packet) });

    await aliceTransport.send(
      { transport: "nostr_relay", addr: toHex(bob.publicKey) },
      new Uint8Array([0x01, 0x80, 0xff, 0x00, 0x42]),
    );
    await Promise.resolve();

    expect(relay.published).toHaveLength(1);
    const [event] = relay.published;
    expect(event.kind).toBe(NOSTR_RELAY_DATAGRAM_KIND);
    expect(event.tags).toEqual([["p", toHex(bob.xOnlyPubkey)]]);
    expect(event.content).not.toContain("=");
    expect(received).toHaveLength(1);
    expect(received[0]!.remoteAddr).toEqual({
      transport: "nostr_relay",
      addr: toHex(alice.xOnlyPubkey),
    });
    expect([...received[0]!.data]).toEqual([0x01, 0x80, 0xff, 0x00, 0x42]);
  });

  it("uses the relay that delivered a peer advert", async () => {
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x51));
    const remote = await identityFromSecretKey(new Uint8Array(32).fill(0x52));
    const first = new FakeRelay("ws://first.test");
    const second = new FakeRelay("ws://second.test");
    const transport = new NostrRelayTransport({
      relays: [first.url, second.url],
      relayClients: [relayClient(first), relayClient(second)],
    });
    await transport.start({ localIdentity: local, onPacket: () => undefined });
    transport.recordAdvertSource(toHex(remote.publicKey), second.url);

    await transport.send(
      { transport: "nostr_relay", addr: toHex(remote.publicKey) },
      new Uint8Array([1]),
    );
    await Promise.resolve();

    expect(first.published).toHaveLength(0);
    expect(second.published).toHaveLength(1);
  });

  it("starts when any configured relay accepts the datagram subscription", async () => {
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x61));
    const unavailable = new FakeRelay(
      "ws://unavailable.test",
      new Error("relay connect error"),
    );
    const available = new FakeRelay("ws://available.test");
    const transport = new NostrRelayTransport({
      relays: [unavailable.url, available.url],
      relayClients: [relayClient(unavailable), relayClient(available)],
    });

    await transport.start({ localIdentity: local, onPacket: () => undefined });

    expect(unavailable.subscriptionCount).toBe(0);
    expect(available.subscriptionCount).toBe(1);
    await transport.stop();
    expect(available.subscriptionCount).toBe(0);
  });

  it("reports a clear error when every configured relay subscription fails", async () => {
    const local = await identityFromSecretKey(new Uint8Array(32).fill(0x62));
    const first = new FakeRelay("ws://first.test", new Error("first unavailable"));
    const second = new FakeRelay("ws://second.test", new Error("second unavailable"));
    const transport = new NostrRelayTransport({
      relays: [first.url, second.url],
      relayClients: [relayClient(first), relayClient(second)],
    });

    await expect(transport.start({
      localIdentity: local,
      onPacket: () => undefined,
    })).rejects.toThrow("no configured Nostr relay accepted the FIPS datagram subscription");
  });
});
