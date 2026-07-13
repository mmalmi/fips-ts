/**
 * NostrWebRtcSignaling - publishes FIPS adverts (kind 37195) and exchanges
 * WebRTC offers/answers via NIP-59 gift-wrapped signals (kind 21059).
 *
 * Adverts are addressed-replaceable per identity and app scope (`d=<app>`).
 * Signaling events are NIP-59 gift wraps: the outer event is signed by a
 * fresh one-time ephemeral key (not the real sender), its content is the
 * NIP-44-encrypted seal (kind 13, signed by the real sender), whose content
 * is the NIP-44-encrypted rumor carrying the WebRTC signal.
 *
 * See `giftWrap.ts` for the layering details and Rust FIPS kind choices.
 */
import { type FipsIdentity, type Logger } from "@fips/core";
import { NostrRelayClient, type NostrEvent } from "./NostrRelayClient.js";
import type { WebRtcSignal } from "./WebRtcSignal.js";
export declare const FIPS_ADVERT_KIND = 37195;
export declare const FIPS_SIGNAL_KIND = 21059;
export declare const FIPS_ADVERT_IDENTIFIER = "fips-overlay-v1";
export declare const FIPS_ADVERT_D_TAG = "fips-overlay-v1";
export declare const FIPS_DEFAULT_DISCOVERY_APP = "fips-overlay-v1";
export declare const FIPS_PROTOCOL_VERSION = "1";
export declare const DEFAULT_FIPS_ADVERT_TTL_MS: number;
export interface FipsAdvertContent {
    identifier: typeof FIPS_ADVERT_IDENTIFIER;
    version: 1;
    endpoints: Array<{
        transport: "webrtc";
        addr: string;
    }>;
    signalRelays: string[];
    stunServers: string[];
}
export interface NostrWebRtcSignalingOptions {
    identity: FipsIdentity;
    relays: NostrRelayClient[];
    relayFactory?: (url: string) => NostrRelayClient;
    discoveryApp?: string;
    advertTtlMs?: number;
    logger?: Logger;
    /** Called with the parsed inner signal and the outer event sender. */
    onSignal: (signal: WebRtcSignal, senderXOnlyHex: string, sourceRelayUrl: string) => void;
    signalReplayWindowMs?: number;
}
export declare class NostrWebRtcSignaling {
    private readonly identity;
    private readonly relays;
    private readonly relayFactory?;
    private readonly relayByUrl;
    private readonly dynamicRelays;
    private readonly signalSubscriptions;
    private readonly discoveryApp;
    private readonly advertTtlMs;
    private readonly logger?;
    private readonly onSignal;
    private readonly seenEventIds;
    private readonly cleanups;
    constructor(opts: NostrWebRtcSignalingOptions);
    /** Subscribe to incoming signals for the local pubkey. */
    start(): Promise<void>;
    stop(): void;
    publishAdvert(advert: FipsAdvertContent): Promise<void>;
    sendSignal(recipientXOnlyHex: string, signal: WebRtcSignal, relayUrls?: string[]): Promise<void>;
    /** Discover adverts (kind 37195) matching the d-tag. */
    subscribeAdverts(cb: (ev: NostrEvent, advert: FipsAdvertContent, sourceRelayUrl: string) => void, extraFilter?: {
        authors?: string[];
    }): Promise<() => void>;
    private publishToRelays;
    private ensureSignalRelays;
    private ensureSignalSubscription;
    private handleSignalEvent;
}
//# sourceMappingURL=NostrWebRtcSignaling.d.ts.map