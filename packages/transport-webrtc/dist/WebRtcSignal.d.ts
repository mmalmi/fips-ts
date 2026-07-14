export interface IceCandidateJson {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
}
export type WebRtcSignalKind = "offer" | "answer" | "candidate" | "reject";
export interface WebRtcSignal {
    protocol: "fips-webrtc-v1";
    version: 1;
    sessionId: string;
    kind: WebRtcSignalKind;
    sender: string;
    recipient: string;
    sdp?: string;
    candidates?: IceCandidateJson[];
    createdAtMs: number;
    expiresAtMs: number;
}
export interface WebRtcSignalValidationContext {
    localPubkeyHex: string;
    outerSenderPubkeyHex: string;
    knownSessionIds: Set<string>;
    seenSessionIds: Set<string>;
    nowMs: number;
}
export declare class SignalValidationError extends Error {
}
export declare function decodeWebRtcSignalPayload(payload: Uint8Array): WebRtcSignal;
export declare function validateWebRtcSignal(s: unknown, ctx: WebRtcSignalValidationContext): WebRtcSignal;
//# sourceMappingURL=WebRtcSignal.d.ts.map