/**
 * NostrWebRtcSignaling — publishes FIPS adverts (kind 37195) and exchanges
 * WebRTC offers/answers via NIP-59 gift-wrapped signals (kind 21059).
 *
 * Adverts are addressed-replaceable per identity (d=fips-overlay-v1).
 * Signaling events are NIP-59 gift wraps: the outer event is signed by a
 * fresh one-time ephemeral key (not the real sender), its content is the
 * NIP-44-encrypted seal (kind 13, signed by the real sender), whose content
 * is the NIP-44-encrypted rumor carrying the WebRTC signal.
 *
 * See `giftWrap.ts` for the layering details and Rust-FIPS-vs-NIP59 kind
 * choice (21059 vs 1059).
 */

import { toHex, type FipsIdentity, type Logger } from "@fips/core";

import { buildGiftWrap, unwrapGiftWrap, FIPS_SIGNAL_RUMOR_KIND } from "./giftWrap.js";
import { NostrRelayClient, type NostrEvent } from "./NostrRelayClient.js";
import { signEvent, verifyEvent } from "./nostrEvent.js";
import type { WebRtcSignal } from "./WebRtcSignal.js";

export const FIPS_ADVERT_KIND = 37195;
export const FIPS_SIGNAL_KIND = 21059;
export const FIPS_ADVERT_D_TAG = "fips-overlay-v1";

export interface FipsAdvertContent {
  identifier: typeof FIPS_ADVERT_D_TAG;
  version: 1;
  endpoints: Array<{ transport: "webrtc"; addr: string }>;
  signalRelays: string[];
  stunServers: string[];
}

export interface NostrWebRtcSignalingOptions {
  identity: FipsIdentity;
  relays: NostrRelayClient[];
  logger?: Logger;
  /** Called with the parsed inner signal and the outer event sender. */
  onSignal: (signal: WebRtcSignal, senderXOnlyHex: string) => void;
  signalReplayWindowMs?: number;
}

export class NostrWebRtcSignaling {
  private readonly identity: FipsIdentity;
  private readonly relays: NostrRelayClient[];
  private readonly logger?: Logger;
  private readonly onSignal: NostrWebRtcSignalingOptions["onSignal"];
  private readonly seenEventIds = new Set<string>();
  private readonly cleanups: Array<() => void> = [];

  constructor(opts: NostrWebRtcSignalingOptions) {
    this.identity = opts.identity;
    this.relays = opts.relays;
    this.logger = opts.logger;
    this.onSignal = opts.onSignal;
  }

  /** Subscribe to incoming signals for the local pubkey. */
  async start(): Promise<void> {
    const localXOnly = toHex(this.identity.xOnlyPubkey);
    for (const relay of this.relays) {
      await relay.connect();
      const cleanup = await relay.subscribe(
        { kinds: [FIPS_SIGNAL_KIND], "#p": [localXOnly], limit: 100 },
        {
          onEvent: (ev) => this.handleSignalEvent(ev),
        },
      );
      this.cleanups.push(cleanup);
    }
  }

  stop(): void {
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
  }

  async publishAdvert(advert: FipsAdvertContent): Promise<void> {
    const ev = signEvent(this.identity, {
      created_at: Math.floor(Date.now() / 1000),
      kind: FIPS_ADVERT_KIND,
      tags: [["d", FIPS_ADVERT_D_TAG]],
      content: JSON.stringify(advert),
    });
    await Promise.all(this.relays.map((r) => r.publish(ev).catch((err) => {
      this.logger?.warn("advert publish failed", r.url, err);
    })));
  }

  async sendSignal(recipientXOnlyHex: string, signal: WebRtcSignal): Promise<void> {
    const giftWrap = buildGiftWrap(
      this.identity,
      recipientXOnlyHex,
      JSON.stringify(signal),
    );
    await Promise.all(this.relays.map((r) => r.publish(giftWrap).catch((err) => {
      this.logger?.warn("signal publish failed", r.url, err);
    })));
  }

  /** Discover adverts (kind 37195) matching the d-tag. */
  async subscribeAdverts(
    cb: (ev: NostrEvent, advert: FipsAdvertContent) => void,
    extraFilter: { authors?: string[] } = {},
  ): Promise<() => void> {
    const localCleanups: Array<() => void> = [];
    for (const relay of this.relays) {
      const off = await relay.subscribe(
        {
          kinds: [FIPS_ADVERT_KIND],
          "#d": [FIPS_ADVERT_D_TAG],
          ...extraFilter,
        },
        {
          onEvent: (ev) => {
            if (this.seenEventIds.has(ev.id)) return;
            if (!verifyEvent(ev)) return;
            try {
              const parsed = JSON.parse(ev.content) as FipsAdvertContent;
              if (parsed.identifier !== FIPS_ADVERT_D_TAG) return;
              this.seenEventIds.add(ev.id);
              cb(ev, parsed);
            } catch {
              /* malformed advert; ignore */
            }
          },
        },
      );
      localCleanups.push(off);
    }
    return () => localCleanups.forEach((c) => c());
  }

  private handleSignalEvent(ev: NostrEvent): void {
    if (this.seenEventIds.has(ev.id)) return;
    this.seenEventIds.add(ev.id);
    if (!verifyEvent(ev)) {
      this.logger?.warn("signal event sig invalid", ev.id);
      return;
    }
    let unwrapped;
    try {
      unwrapped = unwrapGiftWrap(this.identity, ev);
    } catch (err) {
      this.logger?.warn("gift wrap decrypt failed", err);
      return;
    }
    if (unwrapped.kind !== FIPS_SIGNAL_RUMOR_KIND) {
      this.logger?.warn("gift wrap rumor kind unexpected", unwrapped.kind);
      return;
    }
    let signal: WebRtcSignal;
    try {
      signal = JSON.parse(unwrapped.content);
    } catch {
      this.logger?.warn("signal JSON parse failed");
      return;
    }
    this.onSignal(signal, unwrapped.senderXOnlyHex);
  }
}

