import { afterEach, describe, expect, it, vi } from "vitest";

import { identityFromSecretKey, toHex, type FipsIdentity, type TransportContext } from "@fips/core";

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
  readonly url = "ws://redial.test";
  private subscriptions: Array<{ filter: NostrFilter; handler: (event: NostrEvent) => void }> = [];
  async connect(): Promise<void> {}
  async publish(): Promise<void> {}
  async subscribe(filter: NostrFilter, callbacks: { onEvent: (event: NostrEvent) => void }): Promise<() => void> {
    const subscription = { filter, handler: callbacks.onEvent };
    this.subscriptions.push(subscription);
    return () => { this.subscriptions = this.subscriptions.filter((entry) => entry !== subscription); };
  }
  emit(event: NostrEvent): void {
    for (const { filter, handler } of this.subscriptions) {
      if (!filter.kinds || filter.kinds.includes(event.kind)) handler(event);
    }
  }
}

class SignalOnlyPeerConnection {
  iceGatheringState = "complete";
  localDescription?: RTCSessionDescriptionInit;
  createDataChannel() { return new EventTarget(); }
  async createOffer() { return { type: "offer", sdp: "test-offer" }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
  addEventListener() {}
  close() {}
}

function advertEvent(identity: FipsIdentity, createdAt: number, expiration: number): NostrEvent {
  const advert: FipsAdvertContent = {
    identifier: FIPS_ADVERT_D_TAG,
    version: 1,
    endpoints: [{ transport: "webrtc", addr: toHex(identity.publicKey) }],
    stunServers: [],
  };
  return signEvent(identity, {
    created_at: createdAt,
    kind: FIPS_ADVERT_KIND,
    tags: [["d", FIPS_ADVERT_D_TAG], ["protocol", FIPS_ADVERT_D_TAG],
      ["version", FIPS_PROTOCOL_VERSION], ["expiration", String(expiration)]],
    content: JSON.stringify(advert),
  });
}

const nowSeconds = () => Math.floor(Date.now() / 1_000);

async function harness(options: {
  isLinked?: () => boolean;
  maxConnections?: number;
  preferred?: string[];
  connectTimeoutMs?: number;
  sendLinkNegotiation?: TransportContext["sendLinkNegotiation"];
} = {}) {
  vi.useFakeTimers();
  const local = await identityFromSecretKey(new Uint8Array(32).fill(0x21));
  const relay = new FakeRelay();
  const sendOffer = vi.fn(options.sendLinkNegotiation ?? (async () => { throw new Error("no route"); }));
  const transport = new WebRtcTransport({
    relays: [relay.url], relayClients: [relay as unknown as NostrRelayClient],
    rtcPeerConnection: SignalOnlyPeerConnection as unknown as typeof RTCPeerConnection,
    autoConnect: true, connectTimeoutMs: options.connectTimeoutMs ?? 100, maxConnections: options.maxConnections,
    preferredAutoConnectPeers: options.preferred,
  });
  await transport.start({
    localIdentity: local, onPacket: () => undefined, sendLinkNegotiation: sendOffer,
    ...(options.isLinked ? { isLinked: options.isLinked } : {}),
  });
  const consume = (async () => {
    for await (const peer of transport.discover()) {
      void transport.connect(peer.remoteAddr).catch(() => undefined);
    }
  })();
  const stop = async () => { await transport.stop(); await consume; };
  return { transport, relay, sendOffer, stop };
}

afterEach(() => { vi.useRealTimers(); });

describe("WebRTC auto-connect redial backoff", () => {
  it("waits 30 minutes after five consecutive failed dials to one advert", async () => {
    const remote = await identityFromSecretKey(new Uint8Array(32).fill(0x22));
    const { relay, sendOffer, stop } = await harness();
    try {
      relay.emit(advertEvent(remote, nowSeconds(), nowSeconds() + 3_600));
      await vi.advanceTimersByTimeAsync(4 * 30_000 + 10_000);
      expect(sendOffer).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(25 * 60_000);
      expect(sendOffer).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(sendOffer).toHaveBeenCalledTimes(6);
    } finally { await stop(); }
  });

  it("redials at once when the peer publishes a newer advert", async () => {
    const remote = await identityFromSecretKey(new Uint8Array(32).fill(0x22));
    const { relay, sendOffer, stop } = await harness();
    try {
      relay.emit(advertEvent(remote, nowSeconds(), nowSeconds() + 3_600));
      await vi.advanceTimersByTimeAsync(4 * 30_000 + 10_000);
      expect(sendOffer).toHaveBeenCalledTimes(5);
      relay.emit(advertEvent(remote, nowSeconds() - 600, nowSeconds() + 3_600)); // older copy
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sendOffer).toHaveBeenCalledTimes(5);
      relay.emit(advertEvent(remote, nowSeconds(), nowSeconds() + 3_600));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sendOffer).toHaveBeenCalledTimes(6);
      // The streak restarts: four more ordinary 30 s retries before the long wait.
      await vi.advanceTimersByTimeAsync(4 * 30_000 + 5_000);
      expect(sendOffer).toHaveBeenCalledTimes(10);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(sendOffer).toHaveBeenCalledTimes(10);
    } finally { await stop(); }
  });

  it("keeps the ordinary 30 s retry while this node has no working link", async () => {
    const remote = await identityFromSecretKey(new Uint8Array(32).fill(0x22));
    let linked = false;
    const { relay, sendOffer, stop } = await harness({ isLinked: () => linked });
    try {
      relay.emit(advertEvent(remote, nowSeconds(), nowSeconds() + 3_600));
      await vi.advanceTimersByTimeAsync(7 * 30_000 + 10_000);
      expect(sendOffer).toHaveBeenCalledTimes(8);
      linked = true;
      await vi.advanceTimersByTimeAsync(5 * 30_000);
      expect(sendOffer).toHaveBeenCalledTimes(13);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(sendOffer).toHaveBeenCalledTimes(13);
    } finally { await stop(); }
  });

  it("dials fresh adverts before adverts that missed their refresh", async () => {
    const [stale, fresh] = await Promise.all([0x23, 0x24].map((fill) => identityFromSecretKey(new Uint8Array(32).fill(fill))));
    const dialed: string[] = [];
    const { relay, stop } = await harness({
      maxConnections: 2,
      sendLinkNegotiation: async (remote) => { dialed.push(remote); await new Promise<void>(() => {}); },
    });
    try {
      // Published 40 min ago with a long expiry: its 30 min refresh never came.
      const staleCreated = nowSeconds() - 40 * 60;
      relay.emit(advertEvent(stale!, staleCreated, staleCreated + 3 * 3_600));
      relay.emit(advertEvent(fresh!, nowSeconds(), nowSeconds() + 10 * 60));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(dialed[0]).toBe(toHex(fresh!.publicKey));
    } finally { await stop(); }
  });
});

describe("WebRTC preferred peers (own devices)", () => {
  const xOnly = (identity: FipsIdentity) => toHex(identity.xOnlyPubkey);
  const opposite = (compressed: string) => `${compressed.startsWith("02") ? "03" : "02"}${compressed.slice(2)}`;

  it("dials a peer made preferred at runtime at once, even during its 30 minute wait", async () => {
    const remote = await identityFromSecretKey(new Uint8Array(32).fill(0x22));
    const { transport, relay, sendOffer, stop } = await harness();
    try {
      relay.emit(advertEvent(remote, nowSeconds(), nowSeconds() + 3_600));
      await vi.advanceTimersByTimeAsync(4 * 30_000 + 10_000);
      expect(sendOffer).toHaveBeenCalledTimes(5);
      transport.setPreferredAutoConnectPeers([xOnly(remote)]);
      await vi.advanceTimersByTimeAsync(100);
      expect(sendOffer).toHaveBeenCalledTimes(6);
      transport.setPreferredAutoConnectPeers([xOnly(remote)]); // unchanged: no extra dial
      await vi.advanceTimersByTimeAsync(100);
      expect(sendOffer).toHaveBeenCalledTimes(6);
    } finally { await stop(); }
  });

  it("backs a failing preferred peer off from 1 s to 30 s, never to the 30 minute wait", async () => {
    const remote = await identityFromSecretKey(new Uint8Array(32).fill(0x22));
    const { relay, sendOffer, stop } = await harness({ preferred: [toHex(remote.publicKey)] });
    try {
      relay.emit(advertEvent(remote, nowSeconds(), nowSeconds() + 3_600));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sendOffer).toHaveBeenCalledTimes(1);
      // Retries after 1, 2, 4, 8 and 16 s, then every 30 s.
      await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 8_000 + 16_000 + 500);
      expect(sendOffer).toHaveBeenCalledTimes(6);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(sendOffer).toHaveBeenCalledTimes(6);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sendOffer).toHaveBeenCalledTimes(7);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(sendOffer).toHaveBeenCalledTimes(27);
    } finally { await stop(); }
  });

  it("matches preferred peers by identity, whichever key parity was given", async () => {
    const [other, own] = await Promise.all([0x23, 0x24].map((fill) => identityFromSecretKey(new Uint8Array(32).fill(fill))));
    const dialed: string[] = [];
    const { relay, stop } = await harness({
      maxConnections: 2,
      preferred: [opposite(toHex(own!.publicKey))],
      sendLinkNegotiation: async (remote) => { dialed.push(remote); await new Promise<void>(() => {}); },
    });
    try {
      relay.emit(advertEvent(other!, nowSeconds(), nowSeconds() + 3_600));
      relay.emit(advertEvent(own!, nowSeconds() - 60, nowSeconds() + 600));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(dialed[0]).toBe(toHex(own!.publicKey));
    } finally { await stop(); }
  });

  it("dials a preferred peer while speculative dials to strangers fill their slots", async () => {
    const strangers = await Promise.all([0x31, 0x32, 0x33, 0x34, 0x35]
      .map((fill) => identityFromSecretKey(new Uint8Array(32).fill(fill))));
    const own = await identityFromSecretKey(new Uint8Array(32).fill(0x36));
    const dialed: string[] = [];
    const { transport, relay, stop } = await harness({
      maxConnections: 8, connectTimeoutMs: 60_000,
      sendLinkNegotiation: async (remote) => { dialed.push(remote); await new Promise<void>(() => {}); },
    });
    try {
      for (const stranger of strangers) relay.emit(advertEvent(stranger, nowSeconds(), nowSeconds() + 3_600));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(dialed).toHaveLength(4);
      relay.emit(advertEvent(own, nowSeconds(), nowSeconds() + 3_600));
      transport.setPreferredAutoConnectPeers([toHex(own.publicKey)]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(dialed).toContain(toHex(own.publicKey));
      expect(dialed).toHaveLength(5);
    } finally { await stop(); }
  });
});
