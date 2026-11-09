import type { LinkNegotiationMessage } from "@fips/core";
export interface IceCandidateJson {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
}
export interface WebRtcSignalPayload {
    sdp?: string;
    candidates?: IceCandidateJson[];
}
export type WebRtcSignal = LinkNegotiationMessage<WebRtcSignalPayload> & {
    linkType: "webrtc";
};
export interface WebRtcSignalValidationContext {
    knownNegotiationIds: Set<string>;
    seenNegotiationIds: Set<string>;
    nowMs: number;
}
export declare class SignalValidationError extends Error {
}
export declare function createWebRtcSignal(negotiationId: string, kind: WebRtcSignal["kind"], payload?: WebRtcSignalPayload): WebRtcSignal;
/** Retry only answers rejected by routing, never successfully sent signals. */
export declare function sendAnswerWithRouteRetry(send: () => Promise<void>, isPending: () => boolean): Promise<void>;
export declare function validateWebRtcSignal(message: LinkNegotiationMessage, ctx: WebRtcSignalValidationContext): WebRtcSignal;
export interface CachedSignal {
    remote: string;
    sdp: string;
    expiresAtMs: number;
    inFlight: boolean;
    retryable: boolean;
    lastAttemptAtMs: number;
    response?: WebRtcSignal;
    responseIsLive?: () => boolean;
}
/** Bounded idempotency for authenticated retransmissions of the same SDP. */
export declare class WebRtcSignalCache {
    private readonly entries;
    duplicate(signal: WebRtcSignal, remote: string): CachedSignal | undefined;
    remember(signal: WebRtcSignal, remote: string): CachedSignal | undefined;
    rememberResponse(cached: CachedSignal, response: WebRtcSignal, isLive?: () => boolean): void;
    clear(): void;
    private prune;
}
//# sourceMappingURL=WebRtcSignal.d.ts.map