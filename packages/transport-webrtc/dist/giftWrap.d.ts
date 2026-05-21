/**
 * FIPS-flavored NIP-59 gift wrap.
 *
 * Standard NIP-59 publishes gift wraps as kind 1059 (regular event, stored by
 * relays). Rust FIPS uses kind 21059 for the outer gift wrap, which is in the
 * 20000-29999 ephemeral range; relays drop them after broadcast, so signaling
 * never accumulates relay state. We follow Rust FIPS for byte-compatible
 * interop.
 *
 * Layering on the wire:
 *
 *   gift-wrap event (kind 21059, signed by random ephemeral key)
 *     content: NIP-44(seal, ephemeralKey, recipientPubkey)
 *
 *   seal event (kind 13, signed by sender's real key)
 *     content: NIP-44(rumor, senderKey, recipientPubkey)
 *
 *   rumor (unsigned event, kind 14 - NIP-17 private message content)
 */
import { type FipsIdentity } from "@fips/core";
import type { NostrEvent } from "./NostrRelayClient.js";
export declare const FIPS_SIGNAL_RUMOR_KIND = 14;
export declare const FIPS_SIGNAL_WRAP_KIND = 21059;
export declare const NIP59_SEAL_KIND = 13;
/**
 * Build and sign a kind 21059 gift wrap containing the given rumor content,
 * sealed for `recipientXOnlyHex`.
 */
export declare function buildGiftWrap(sender: FipsIdentity, recipientXOnlyHex: string, rumorContent: string, rumorKind?: number): NostrEvent;
export interface UnwrappedRumor {
    /** Real sender's xOnly hex (from the seal). */
    senderXOnlyHex: string;
    /** The rumor's content string. */
    content: string;
    /** The rumor's kind (caller may want to validate it). */
    kind: number;
}
/**
 * Reverse of buildGiftWrap. Throws if any layer fails to decrypt or verify.
 */
export declare function unwrapGiftWrap(recipient: FipsIdentity, wrap: NostrEvent): UnwrappedRumor;
//# sourceMappingURL=giftWrap.d.ts.map