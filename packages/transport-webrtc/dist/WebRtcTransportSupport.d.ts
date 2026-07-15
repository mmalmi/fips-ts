import { type DiscoveredPeer } from "@fips/core";
import type { NostrEvent } from "./NostrRelayClient.js";
export declare function randomId(): string;
export declare function incomingOfferReplacesPendingDial(localPubkeyHex: string, remotePubkeyHex: string): boolean;
export declare function hasPendingInboundForPeer(pending: Iterable<{
    remotePubkeyHex: string;
}>, remotePubkeyHex: string): boolean;
export declare function waitForIceGatheringComplete(pc: RTCPeerConnection, timeoutMs: number): Promise<void>;
export declare class AsyncEventStream<T> implements AsyncIterable<T> {
    private readonly values;
    private readonly waiters;
    private closed;
    push(value: T): void;
    close(): void;
    [Symbol.asyncIterator](): AsyncIterator<T>;
}
export declare function emptyAsyncIterable<T>(): AsyncIterable<T>;
export declare function cloneDiscoveredPeer(peer: DiscoveredPeer): DiscoveredPeer;
export declare function advertExpiryMs(event: NostrEvent, ttlMs: number, nowMs: number): number | undefined;
//# sourceMappingURL=WebRtcTransportSupport.d.ts.map