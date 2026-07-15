export class SignalValidationError extends Error {
}
const MAX_SDP_LENGTH = 48 * 1_024;
const MAX_CANDIDATES = 32;
const MAX_CANDIDATE_LENGTH = 2_048;
export function validateWebRtcSignal(message, ctx) {
    if (message.linkType !== "webrtc") {
        throw new SignalValidationError(`bad link type ${message.linkType}`);
    }
    if (message.expiresAtMs < ctx.nowMs) {
        throw new SignalValidationError("signal expired");
    }
    if (message.createdAtMs > ctx.nowMs + 60_000) {
        throw new SignalValidationError("signal createdAtMs in future");
    }
    if (typeof message.payload !== "object" || message.payload === null) {
        throw new SignalValidationError("WebRTC negotiation payload must be an object");
    }
    const signal = message;
    validateSignalBody(signal);
    validateSignalSession(signal, ctx);
    return signal;
}
function validateSignalBody(signal) {
    if (signal.kind === "offer" || signal.kind === "answer") {
        if (typeof signal.payload.sdp !== "string" || signal.payload.sdp.length === 0) {
            throw new SignalValidationError("offer/answer requires sdp");
        }
        if (signal.payload.sdp.length > MAX_SDP_LENGTH) {
            throw new SignalValidationError("offer/answer SDP is too large");
        }
    }
    else if (signal.kind === "candidate") {
        if (!Array.isArray(signal.payload.candidates) || signal.payload.candidates.length === 0) {
            throw new SignalValidationError("candidate signal requires candidates[]");
        }
        if (signal.payload.candidates.length > MAX_CANDIDATES
            || signal.payload.candidates.some((candidate) => candidate.candidate.length > MAX_CANDIDATE_LENGTH)) {
            throw new SignalValidationError("candidate signal exceeds limits");
        }
    }
}
function validateSignalSession(signal, ctx) {
    if (signal.kind === "answer"
        || signal.kind === "candidate"
        || signal.kind === "reject") {
        if (!ctx.knownNegotiationIds.has(signal.negotiationId)) {
            throw new SignalValidationError("unknown negotiationId for answer/candidate");
        }
    }
    const replayKey = `${signal.negotiationId}:${signal.kind}`;
    if (ctx.seenNegotiationIds.has(replayKey)) {
        throw new SignalValidationError("duplicate signal in replay window");
    }
}
//# sourceMappingURL=WebRtcSignal.js.map