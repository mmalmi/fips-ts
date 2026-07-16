import { toHex, noopLogger, } from "@fips/core";
import { NostrRelayClient, } from "./NostrRelayClient.js";
import { signEvent, verifyEvent } from "./nostrEvent.js";
export const NOSTR_RELAY_DATAGRAM_KIND = 21_060;
const DEFAULT_MTU = 1_280;
const MAX_EVENT_AGE_SECONDS = 60;
const MAX_FUTURE_SKEW_SECONDS = 30;
const MAX_AFFINITY_RELAYS = 2;
/**
 * Low-priority FIPS wire datagrams carried in targeted ephemeral Nostr events.
 * Relay selection and route affinity remain application-side policy.
 */
export class NostrRelayTransport {
    type = "nostr_relay";
    mtu;
    cfg;
    logger;
    ctx;
    clients = [];
    ownsClients = false;
    cleanups = [];
    affinity = new Map();
    constructor(config) {
        this.cfg = config;
        this.mtu = config.mtu ?? DEFAULT_MTU;
        this.logger = config.logger ?? noopLogger;
        if (!Number.isSafeInteger(this.mtu) || this.mtu <= 0) {
            throw new Error("Nostr relay MTU must be a positive safe integer");
        }
    }
    async start(ctx) {
        this.ctx = ctx;
        this.clients = this.createClients();
        const localXOnly = toHex(ctx.localIdentity.xOnlyPubkey);
        const since = Math.floor(Date.now() / 1_000) - MAX_EVENT_AGE_SECONDS;
        const subscriptions = await Promise.allSettled(this.clients.map((client) => client.subscribe({ kinds: [NOSTR_RELAY_DATAGRAM_KIND], "#p": [localXOnly], since }, {
            onEvent: (event) => {
                try {
                    this.ingestEvent(event);
                }
                catch (error) {
                    this.logger.debug("ignored Nostr relay datagram", client.url, error);
                }
            },
        })));
        const cleanups = [];
        const failures = [];
        for (const [index, subscription] of subscriptions.entries()) {
            if (subscription.status === "fulfilled") {
                cleanups.push(subscription.value);
                continue;
            }
            failures.push(subscription.reason);
            this.logger.warn("Nostr relay datagram subscription failed", this.clients[index].url, subscription.reason);
        }
        if (this.clients.length > 0 && cleanups.length === 0) {
            const error = new AggregateError(failures, "no configured Nostr relay accepted the FIPS datagram subscription");
            await this.stop();
            throw error;
        }
        this.cleanups = cleanups;
    }
    async stop() {
        for (const cleanup of this.cleanups)
            cleanup();
        this.cleanups = [];
        if (this.ownsClients) {
            for (const client of this.clients)
                client.close();
        }
        this.clients = [];
        this.ownsClients = false;
        this.affinity.clear();
        this.ctx = undefined;
    }
    async connect(addr) {
        this.destinationXOnly(addr);
        this.ctx?.onConnectionState?.({ remoteAddr: addr, state: "connected" });
    }
    async send(addr, packet) {
        if (!this.ctx)
            throw new Error("Nostr relay transport not started");
        if (packet.length === 0 || packet.length > this.mtu) {
            throw new Error(`packet ${packet.length} exceeds Nostr relay MTU ${this.mtu}`);
        }
        const recipient = this.destinationXOnly(addr);
        const event = signEvent(this.ctx.localIdentity, {
            created_at: Math.floor(Date.now() / 1_000),
            kind: NOSTR_RELAY_DATAGRAM_KIND,
            tags: [["p", recipient]],
            content: encodeBase64Url(packet),
        });
        const clients = this.deliveryClients(recipient);
        if (clients.length === 0)
            throw new Error("no Nostr relay connections configured");
        for (const client of clients) {
            void client.publish(event).catch((error) => {
                this.logger.debug("Nostr relay datagram publish failed", client.url, error);
            });
        }
    }
    /** Prefer fresh relays that delivered this peer's public advert. */
    recordAdvertSource(remotePubkeyHex, relayUrl) {
        const xOnly = compressedOrXOnlyHex(remotePubkeyHex);
        const normalized = new URL(relayUrl).toString();
        const routes = this.affinity.get(xOnly) ?? [];
        this.affinity.set(xOnly, [normalized, ...routes.filter((route) => route !== normalized)]
            .slice(0, MAX_AFFINITY_RELAYS));
    }
    /** Validate and inject a kind-21060 event received by an external adapter. */
    ingestEvent(event) {
        if (!this.ctx || event.kind !== NOSTR_RELAY_DATAGRAM_KIND)
            return false;
        if (!verifyEvent(event))
            throw new Error("invalid Nostr event signature");
        const recipients = event.tags
            .filter((tag) => tag[0] === "p" && typeof tag[1] === "string")
            .map((tag) => tag[1].toLowerCase());
        const localXOnly = toHex(this.ctx.localIdentity.xOnlyPubkey);
        if (recipients.length !== 1 || recipients[0] !== localXOnly)
            return false;
        const now = Math.floor(Date.now() / 1_000);
        if (event.created_at > now + MAX_FUTURE_SKEW_SECONDS
            || now - event.created_at > MAX_EVENT_AGE_SECONDS) {
            return false;
        }
        if (event.content.length > Math.ceil(this.mtu / 3) * 4)
            return false;
        const packet = decodeBase64Url(event.content);
        if (packet.length === 0 || packet.length > this.mtu)
            return false;
        const remoteAddr = { transport: this.type, addr: event.pubkey.toLowerCase() };
        this.ctx.onPacket({
            transportType: this.type,
            remoteAddr,
            data: packet,
            receivedAtMs: Date.now(),
        });
        return true;
    }
    createClients() {
        if (this.cfg.relayClients) {
            const configured = this.cfg.relays.map((url) => new URL(url).toString());
            const shared = this.cfg.relayClients.map((client) => new URL(client.url).toString());
            if (configured.length !== shared.length
                || configured.some((url, index) => url !== shared[index])) {
                throw new Error("shared relay clients must match configured relays in order");
            }
            this.ownsClients = false;
            return this.cfg.relayClients;
        }
        this.ownsClients = true;
        return this.cfg.relays.map((url) => new NostrRelayClient({
            url,
            webSocket: this.cfg.webSocket,
            connectTimeoutMs: this.cfg.relayConnectTimeoutMs,
            logger: this.logger,
        }));
    }
    destinationXOnly(addr) {
        if (addr.transport !== this.type)
            throw new Error("wrong transport");
        return compressedOrXOnlyHex(addr.addr);
    }
    deliveryClients(recipientXOnly) {
        const byUrl = new Map(this.clients.map((client) => [new URL(client.url).toString(), client]));
        const preferred = (this.affinity.get(recipientXOnly) ?? [])
            .map((url) => byUrl.get(url))
            .filter((client) => client !== undefined);
        return preferred.length > 0 ? preferred : this.clients;
    }
}
function compressedOrXOnlyHex(value) {
    const lower = value.toLowerCase();
    if (/^[0-9a-f]{64}$/.test(lower))
        return lower;
    if (/^(02|03)[0-9a-f]{64}$/.test(lower))
        return lower.slice(2);
    throw new Error("Nostr relay address must be an x-only or compressed pubkey hex");
}
function encodeBase64Url(data) {
    let binary = "";
    for (const byte of data)
        binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function decodeBase64Url(value) {
    if (!/^[A-Za-z0-9_-]*$/u.test(value))
        throw new Error("invalid base64url content");
    const padded = value.replaceAll("-", "+").replaceAll("_", "/")
        + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
//# sourceMappingURL=NostrRelayTransport.js.map