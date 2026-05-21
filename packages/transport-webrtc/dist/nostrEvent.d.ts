/**
 * Lightweight Nostr event builder and verifier — kind 1/37195/21059 etc.
 * Signs with BIP-340 Schnorr. The event id is SHA-256 of the canonical
 * serialization (NIP-01).
 */
import { type FipsIdentity } from "@fips/core";
import type { NostrEvent } from "./NostrRelayClient.js";
export interface UnsignedEvent {
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
}
export declare function serializeForId(e: UnsignedEvent): Uint8Array;
export declare function computeEventId(e: UnsignedEvent): string;
export declare function signEvent(identity: FipsIdentity, e: Omit<UnsignedEvent, "pubkey">): NostrEvent;
export declare function verifyEvent(e: NostrEvent): boolean;
//# sourceMappingURL=nostrEvent.d.ts.map