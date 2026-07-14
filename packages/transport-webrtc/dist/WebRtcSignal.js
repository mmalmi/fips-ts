export class SignalValidationError extends Error {
}
export function decodeWebRtcSignalPayload(payload) {
    try {
        return JSON.parse(new TextDecoder().decode(payload));
    }
    catch {
        throw new SignalValidationError("invalid WebRTC FSP signal JSON");
    }
}
export function validateWebRtcSignal(s, ctx) {
    if (typeof s !== "object" || s === null) {
        throw new SignalValidationError("signal must be a JSON object");
    }
    const obj = s;
    validateEnvelope(obj, ctx);
    validateSignalBody(obj);
    validateSignalSession(obj, ctx);
    return obj;
}
function validateEnvelope(obj, ctx) {
    if (obj.protocol !== "fips-webrtc-v1") {
        throw new SignalValidationError(`bad protocol ${String(obj.protocol)}`);
    }
    if (obj.version !== 1) {
        throw new SignalValidationError(`bad version ${String(obj.version)}`);
    }
    if (typeof obj.sessionId !== "string" || obj.sessionId.length === 0) {
        throw new SignalValidationError("missing sessionId");
    }
    if (typeof obj.sender !== "string" || obj.sender.length !== 66) {
        throw new SignalValidationError("bad sender pubkey");
    }
    if (typeof obj.recipient !== "string" || obj.recipient.length !== 66) {
        throw new SignalValidationError("bad recipient pubkey");
    }
    if (obj.recipient !== ctx.localPubkeyHex) {
        throw new SignalValidationError("recipient is not us");
    }
    if (obj.sender !== ctx.outerSenderPubkeyHex) {
        throw new SignalValidationError("inner sender ≠ outer event author");
    }
    const now = ctx.nowMs;
    if (typeof obj.expiresAtMs !== "number" || obj.expiresAtMs < now) {
        throw new SignalValidationError("signal expired");
    }
    if (typeof obj.createdAtMs !== "number" || obj.createdAtMs > now + 60_000) {
        throw new SignalValidationError("signal createdAtMs in future");
    }
}
function validateSignalBody(obj) {
    if (obj.kind === "offer" || obj.kind === "answer") {
        if (typeof obj.sdp !== "string" || obj.sdp.length === 0) {
            throw new SignalValidationError("offer/answer requires sdp");
        }
    }
    else if (obj.kind === "candidate") {
        if (!Array.isArray(obj.candidates) || obj.candidates.length === 0) {
            throw new SignalValidationError("candidate signal requires candidates[]");
        }
    }
    else if (obj.kind === "reject") {
        /* no extra body required */
    }
    else {
        throw new SignalValidationError(`bad kind ${String(obj.kind)}`);
    }
}
function validateSignalSession(obj, ctx) {
    if (typeof obj.sessionId !== "string") {
        throw new SignalValidationError("missing sessionId");
    }
    if (obj.kind === "answer" ||
        obj.kind === "candidate" ||
        obj.kind === "reject") {
        if (!ctx.knownSessionIds.has(obj.sessionId)) {
            throw new SignalValidationError("unknown sessionId for answer/candidate");
        }
    }
    if (ctx.seenSessionIds.has(`${obj.sessionId}:${obj.kind}`)) {
        throw new SignalValidationError("duplicate signal in replay window");
    }
}
//# sourceMappingURL=WebRtcSignal.js.map