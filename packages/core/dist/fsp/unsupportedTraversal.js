import { toHex } from "../codec/hex.js";
const SIGNAL_TTL_MS = 120_000;
const CLOCK_SKEW_MS = 60_000;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const identifier = (value) => typeof value === "string" && /^[!-~]{1,128}$/.test(value);
const address = (value) => record(value)
    && typeof value.protocol === "string" && typeof value.ip === "string"
    && Number.isInteger(value.port) && value.port >= 0 && value.port <= 65535;
/** Called only for an admitted, authenticated session destination. */
export function unsupportedTraversalAnswer(body, now, actualSenderNpub, localNpub, random) {
    if (body.length > 4096 || !timestamp(now) || !timestamp(now + SIGNAL_TTL_MS))
        return;
    let offer;
    try {
        offer = JSON.parse(decoder.decode(body));
    }
    catch {
        return;
    }
    if (!record(offer) || offer.type !== "offer"
        || !identifier(offer.sessionId) || !identifier(offer.nonce)
        || !timestamp(offer.issuedAt) || !timestamp(offer.expiresAt) || offer.expiresAt <= offer.issuedAt
        || offer.senderNpub !== actualSenderNpub || offer.recipientNpub !== localNpub
        || !Array.isArray(offer.localAddresses) || !offer.localAddresses.every(address)
        || (offer.reflexiveAddress != null && !address(offer.reflexiveAddress))
        || (offer.stunServer != null && typeof offer.stunServer !== "string"))
        return;
    // Match native freshness: the sender can shorten, but cannot extend, our TTL.
    // JS rejects timestamps outside its exact integer range instead of rounding u64.
    const expiry = Math.min(offer.expiresAt, offer.issuedAt + SIGNAL_TTL_MS);
    if (offer.issuedAt - now > CLOCK_SKEW_MS || expiry + CLOCK_SKEW_MS <= now
        || now - offer.issuedAt > SIGNAL_TTL_MS + CLOCK_SKEW_MS)
        return;
    return encoder.encode(JSON.stringify({
        type: "answer", sessionId: offer.sessionId, issuedAt: now, expiresAt: now + SIGNAL_TTL_MS,
        nonce: `${now}-${toHex(random(8))}`, senderNpub: localNpub, recipientNpub: actualSenderNpub,
        inReplyTo: offer.nonce, accepted: false, reflexiveAddress: null, localAddresses: [],
        stunServer: null, punch: null, reason: "traversal-unsupported", offerReceivedAt: now,
    }));
}
//# sourceMappingURL=unsupportedTraversal.js.map