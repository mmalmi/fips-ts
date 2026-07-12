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
import { toHex } from "@fips/core";
import { FIPS_SIGNAL_RUMOR_KIND, buildGiftWrap, unwrapGiftWrap, } from "./giftWrap.js";
import { signEvent, verifyEvent } from "./nostrEvent.js";
export const FIPS_ADVERT_KIND = 37195;
export const FIPS_SIGNAL_KIND = 21059;
export const FIPS_ADVERT_IDENTIFIER = "fips-overlay-v1";
export const FIPS_ADVERT_D_TAG = FIPS_ADVERT_IDENTIFIER;
export const FIPS_DEFAULT_DISCOVERY_APP = "fips-overlay-v1";
export const FIPS_PROTOCOL_VERSION = "1";
export const DEFAULT_FIPS_ADVERT_TTL_MS = 60 * 60 * 1000;
const RELAY_OPERATION_WARMUP_MS = 1_500;
export class NostrWebRtcSignaling {
    identity;
    relays;
    relayFactory;
    relayByUrl = new Map();
    dynamicRelays = new Set();
    signalSubscriptions = new Map();
    discoveryApp;
    advertTtlMs;
    logger;
    onSignal;
    seenEventIds = new Set();
    cleanups = [];
    constructor(opts) {
        this.identity = opts.identity;
        this.relays = opts.relays;
        this.relayFactory = opts.relayFactory;
        for (const relay of this.relays) {
            this.relayByUrl.set(normalizeRelayUrl(relay.url), relay);
        }
        this.discoveryApp = normalizeDiscoveryApp(opts.discoveryApp);
        this.advertTtlMs = opts.advertTtlMs ?? DEFAULT_FIPS_ADVERT_TTL_MS;
        this.logger = opts.logger;
        this.onSignal = opts.onSignal;
    }
    /** Subscribe to incoming signals for the local pubkey. */
    async start() {
        await Promise.all(this.relays.map((relay) => this.ensureSignalSubscription(relay)));
    }
    stop() {
        for (const c of this.cleanups)
            c();
        this.cleanups.length = 0;
        this.signalSubscriptions.clear();
        for (const relay of this.dynamicRelays)
            relay.close();
        this.dynamicRelays.clear();
        for (const [url, relay] of this.relayByUrl) {
            if (!this.relays.includes(relay))
                this.relayByUrl.delete(url);
        }
    }
    async publishAdvert(advert) {
        const expiresAt = Math.floor((Date.now() + this.advertTtlMs) / 1000);
        const ev = signEvent(this.identity, {
            created_at: Math.floor(Date.now() / 1000),
            kind: FIPS_ADVERT_KIND,
            tags: [
                ["d", this.discoveryApp],
                ["protocol", this.discoveryApp],
                ["version", FIPS_PROTOCOL_VERSION],
                ["expiration", String(expiresAt)],
            ],
            content: JSON.stringify(advert),
        });
        await this.publishToRelays(this.relays, ev, "advert publish failed");
    }
    async sendSignal(recipientXOnlyHex, signal, relayUrls) {
        const now = Math.floor(Date.now() / 1000);
        const giftWrap = buildGiftWrap(this.identity, recipientXOnlyHex, JSON.stringify(signal), FIPS_SIGNAL_RUMOR_KIND, {
            outerCreatedAt: now,
            expiration: Math.max(now + 1, Math.floor(signal.expiresAtMs / 1000)),
        });
        const relays = relayUrls === undefined
            ? this.relays
            : await this.ensureSignalRelays(relayUrls);
        await this.publishToRelays(relays, giftWrap, "signal publish failed");
        this.logger?.debug("signal published", signal.kind, signal.sessionId, recipientXOnlyHex);
    }
    /** Discover adverts (kind 37195) matching the d-tag. */
    async subscribeAdverts(cb, extraFilter = {}) {
        const localCleanups = [];
        const operations = this.relays.map(async (relay) => {
            try {
                const off = await relay.subscribe({
                    kinds: [FIPS_ADVERT_KIND],
                    "#d": [this.discoveryApp],
                    ...extraFilter,
                }, {
                    onEvent: (ev) => {
                        if (this.seenEventIds.has(ev.id))
                            return;
                        if (!verifyEvent(ev))
                            return;
                        if (tagValue(ev, "protocol") !== this.discoveryApp)
                            return;
                        const version = tagValue(ev, "version");
                        if (version && version !== FIPS_PROTOCOL_VERSION)
                            return;
                        try {
                            const parsed = JSON.parse(ev.content);
                            if (parsed.identifier !== FIPS_ADVERT_IDENTIFIER)
                                return;
                            this.seenEventIds.add(ev.id);
                            cb(ev, parsed);
                        }
                        catch {
                            /* malformed advert; ignore */
                        }
                    },
                });
                localCleanups.push(off);
                return true;
            }
            catch (err) {
                this.logger?.warn("advert subscription failed", relay.url, err);
                return false;
            }
        });
        await waitForRelayWarmup(operations);
        return () => localCleanups.forEach((c) => c());
    }
    async publishToRelays(relays, event, failureMessage) {
        const operations = relays.map(async (relay) => {
            try {
                await relay.publish(event);
                return true;
            }
            catch (err) {
                this.logger?.warn(failureMessage, relay.url, err);
                return false;
            }
        });
        const results = await Promise.all(operations);
        if (!results.some(Boolean))
            throw new Error("no signal relay accepted event");
    }
    async ensureSignalRelays(urls) {
        const normalized = [...new Set(urls.map(normalizeRelayUrl))];
        if (normalized.length === 0)
            throw new Error("signal relay list is empty");
        const relays = normalized.map((url) => {
            const existing = this.relayByUrl.get(url);
            if (existing)
                return existing;
            if (!this.relayFactory)
                throw new Error(`signal relay is unavailable: ${url}`);
            const relay = this.relayFactory(url);
            this.relayByUrl.set(url, relay);
            this.dynamicRelays.add(relay);
            return relay;
        });
        const ready = await Promise.all(relays.map((relay) => this.ensureSignalSubscription(relay)));
        const usable = relays.filter((_, index) => ready[index]);
        if (usable.length === 0)
            throw new Error("no signal relay subscription available");
        return usable;
    }
    ensureSignalSubscription(relay) {
        const relayUrl = normalizeRelayUrl(relay.url);
        const existing = this.signalSubscriptions.get(relayUrl);
        if (existing)
            return existing;
        const localXOnly = toHex(this.identity.xOnlyPubkey);
        const operation = (async () => {
            try {
                await relay.connect();
                const cleanup = await relay.subscribe({ kinds: [FIPS_SIGNAL_KIND], "#p": [localXOnly], limit: 100 }, { onEvent: (ev) => this.handleSignalEvent(ev, relayUrl) });
                this.cleanups.push(cleanup);
                this.logger?.debug("signal subscription ready", relayUrl, localXOnly);
                return true;
            }
            catch (err) {
                this.logger?.warn("signal subscription failed", relayUrl, err);
                this.signalSubscriptions.delete(relayUrl);
                return false;
            }
        })();
        this.signalSubscriptions.set(relayUrl, operation);
        return operation;
    }
    handleSignalEvent(ev, sourceRelayUrl) {
        if (this.seenEventIds.has(ev.id))
            return;
        this.seenEventIds.add(ev.id);
        this.logger?.debug("signal event received", ev.id, ev.pubkey);
        if (!verifyEvent(ev)) {
            this.logger?.warn("signal event sig invalid", ev.id);
            return;
        }
        let unwrapped;
        try {
            unwrapped = unwrapGiftWrap(this.identity, ev);
        }
        catch (err) {
            this.logger?.warn("gift wrap decrypt failed", err);
            return;
        }
        this.logger?.debug("signal event unwrapped", ev.id, unwrapped.senderXOnlyHex, unwrapped.kind);
        if (unwrapped.kind !== FIPS_SIGNAL_RUMOR_KIND) {
            this.logger?.warn("gift wrap rumor kind unexpected", unwrapped.kind);
            return;
        }
        let signal;
        try {
            signal = JSON.parse(unwrapped.content);
        }
        catch {
            this.logger?.warn("signal JSON parse failed");
            return;
        }
        this.logger?.debug("signal parsed", signal.kind, signal.sessionId, signal.sender);
        this.onSignal(signal, unwrapped.senderXOnlyHex, sourceRelayUrl);
    }
}
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
async function waitForRelayWarmup(operations) {
    if (operations.length === 0)
        return;
    await Promise.race([
        Promise.any(operations.map((operation) => operation.then((ok) => {
            if (!ok)
                throw new Error("relay operation failed");
            return true;
        }))).catch(() => false),
        Promise.all(operations).catch(() => []),
        sleep(RELAY_OPERATION_WARMUP_MS),
    ]);
}
function normalizeRelayUrl(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        throw new Error(`unsupported signal relay protocol: ${parsed.protocol}`);
    }
    return parsed.toString();
}
function normalizeDiscoveryApp(app) {
    const normalized = app?.trim();
    return normalized || FIPS_DEFAULT_DISCOVERY_APP;
}
function tagValue(ev, tagName) {
    return ev.tags.find((tag) => tag[0] === tagName)?.[1];
}
//# sourceMappingURL=NostrWebRtcSignaling.js.map