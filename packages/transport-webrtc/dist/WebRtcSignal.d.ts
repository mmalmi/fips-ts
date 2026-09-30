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
//# sourceMappingURL=WebRtcSignal.d.ts.map