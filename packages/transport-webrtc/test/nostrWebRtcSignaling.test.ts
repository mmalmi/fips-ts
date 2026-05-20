import { describe, expect, it } from "vitest";

import { identityFromSecretKey, toHex } from "@fips/core";

import {
  FIPS_ADVERT_D_TAG,
  FIPS_ADVERT_KIND,
  FIPS_PROTOCOL_VERSION,
  FIPS_SIGNAL_KIND,
  NostrWebRtcSignaling,
  type FipsAdvertContent,
} from "../src/NostrWebRtcSignaling.js";
import { FIPS_SIGNAL_RUMOR_KIND, unwrapGiftWrap } from "../src/giftWrap.js";
import type { NostrEvent, NostrFilter, NostrRelayClient } from "../src/NostrRelayClient.js";
import { signEvent } from "../src/nostrEvent.js";
import type { WebRtcSignal } from "../src/WebRtcSignal.js";

class FakeRelay {
  readonly url = "ws://relay.test";
  readonly published: NostrEvent[] = [];
  readonly filters: NostrFilter[] = [];
  private handlers: Array<(event: NostrEvent) => void> = [];

  async connect(): Promise<void> {
    return undefined;
  }

  async publish(event: NostrEvent): Promise<void> {
    this.published.push(event);
  }

  async subscribe(filter: NostrFilter, cb: { onEvent: (ev: NostrEvent) => void }): Promise<() => void> {
    this.filters.push(filter);
    this.handlers.push(cb.onEvent);
    return () => {
      this.handlers = this.handlers.filter((handler) => handler !== cb.onEvent);
    };
  }

  emit(event: NostrEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  close(): void {
    this.handlers = [];
  }
}

function relayClient(relay: FakeRelay): NostrRelayClient {
  return relay as unknown as NostrRelayClient;
}

function advertContent(): FipsAdvertContent {
  return {
    identifier: FIPS_ADVERT_D_TAG,
    version: 1,
    endpoints: [{ transport: "webrtc", addr: "02".padEnd(66, "1") }],
    signalRelays: ["ws://relay.test"],
    stunServers: [],
  };
}

describe("NostrWebRtcSignaling adverts", () => {
  it("publishes Rust FIPS-style app-scoped adverts", async () => {
    const identity = await identityFromSecretKey(new Uint8Array(32).fill(0x11));
    const relay = new FakeRelay();
    const signaling = new NostrWebRtcSignaling({
      identity,
      relays: [relayClient(relay)],
      discoveryApp: "hashtree-v1",
      onSignal: () => undefined,
    });

    await signaling.publishAdvert(advertContent());

    expect(relay.published).toHaveLength(1);
    const [event] = relay.published;
    expect(event.kind).toBe(FIPS_ADVERT_KIND);
    expect(event.tags).toContainEqual(["d", "hashtree-v1"]);
    expect(event.tags).toContainEqual(["protocol", "hashtree-v1"]);
    expect(event.tags).toContainEqual(["version", FIPS_PROTOCOL_VERSION]);
    expect(event.tags.some((tag) => tag[0] === "expiration")).toBe(true);
    expect(JSON.parse(event.content)).toMatchObject({
      identifier: FIPS_ADVERT_D_TAG,
      version: 1,
    });
  });

  it("subscribes by FIPS advert identifier and filters mismatched app scopes", async () => {
    const identity = await identityFromSecretKey(new Uint8Array(32).fill(0x22));
    const relay = new FakeRelay();
    const signaling = new NostrWebRtcSignaling({
      identity,
      relays: [relayClient(relay)],
      discoveryApp: "hashtree-v1",
      onSignal: () => undefined,
    });
    const seen: NostrEvent[] = [];

    await signaling.subscribeAdverts((event) => {
      seen.push(event);
    });

    expect(relay.filters).toEqual([
      {
        kinds: [FIPS_ADVERT_KIND],
        "#d": ["hashtree-v1"],
      },
    ]);

    const author = await identityFromSecretKey(new Uint8Array(32).fill(0x33));
    const base = {
      created_at: 1,
      kind: FIPS_ADVERT_KIND,
      content: JSON.stringify(advertContent()),
    };
    const wrongApp = signEvent(author, {
      ...base,
      tags: [["d", FIPS_ADVERT_D_TAG], ["protocol", "other-app"], ["version", FIPS_PROTOCOL_VERSION]],
    });
    const rightApp = signEvent(author, {
      ...base,
      tags: [["d", FIPS_ADVERT_D_TAG], ["protocol", "hashtree-v1"], ["version", FIPS_PROTOCOL_VERSION]],
    });

    relay.emit(wrongApp);
    relay.emit(rightApp);

    expect(seen.map((event) => event.pubkey)).toEqual([toHex(author.xOnlyPubkey)]);
  });

  it("sends Rust FIPS-compatible private-message rumors inside signal wraps", async () => {
    const sender = await identityFromSecretKey(new Uint8Array(32).fill(0x44));
    const recipient = await identityFromSecretKey(new Uint8Array(32).fill(0x55));
    const relay = new FakeRelay();
    const signaling = new NostrWebRtcSignaling({
      identity: sender,
      relays: [relayClient(relay)],
      onSignal: () => undefined,
    });
    const signal: WebRtcSignal = {
      protocol: "fips-webrtc-v1",
      version: 1,
      sessionId: "session",
      kind: "offer",
      sender: toHex(sender.publicKey),
      recipient: toHex(recipient.publicKey),
      sdp: "v=0",
      createdAtMs: 1,
      expiresAtMs: 2,
    };

    await signaling.sendSignal(toHex(recipient.xOnlyPubkey), signal);

    expect(relay.published).toHaveLength(1);
    const [event] = relay.published;
    expect(event.kind).toBe(FIPS_SIGNAL_KIND);
    const unwrapped = unwrapGiftWrap(recipient, event);
    expect(unwrapped.kind).toBe(FIPS_SIGNAL_RUMOR_KIND);
    expect(JSON.parse(unwrapped.content)).toEqual(signal);
  });
});
