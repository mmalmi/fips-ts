export class SignalValidationError extends Error {
}
const MAX_SDP_LENGTH = 48 * 1_024;
const MAX_CANDIDATES = 32;
const MAX_CANDIDATE_LENGTH = 2_048;
export function createWebRtcSignal(negotiationId, kind, payload = {}) {
    const createdAtMs = Date.now();
    return {
        version: 1, negotiationId, linkType: "webrtc", kind,
        createdAtMs, expiresAtMs: createdAtMs + 60_000, payload,
    };
}
/** Retry only answers rejected by routing, never successfully sent signals. */
export async function sendAnswerWithRouteRetry(send, isPending) {
    for (let attempt = 0; isPending(); attempt++) {
        try {
            await send();
            return;
        }
        catch (error) {
            if (!(error instanceof Error) || !error.message.startsWith("no route to ") || attempt === 3)
                throw error;
            await new Promise((resolve) => { setTimeout(resolve, 1_000 * 2 ** attempt); });
        }
    }
}
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
/** Bounded idempotency for authenticated retransmissions of the same SDP. */
export class WebRtcSignalCache {
    entries = new Map();
    duplicate(signal, remote) {
        this.prune();
        const cached = this.entries.get(`${signal.negotiationId}:${signal.kind}`);
        return cached?.remote === remote && cached.sdp === signal.payload?.sdp ? cached : undefined;
    }
    remember(signal, remote) {
        if (signal.kind !== "offer" && signal.kind !== "answer")
            return;
        this.prune();
        if (this.entries.size >= 64) {
            const evictable = [...this.entries].find(([, value]) => !value.inFlight && !value.responseIsLive?.());
            // Refused offers must not evict a response still needed by a live PC.
            if (!evictable)
                return;
            this.entries.delete(evictable[0]);
        }
        const cached = {
            remote, sdp: signal.payload.sdp, expiresAtMs: Math.min(signal.expiresAtMs, Date.now() + 60_000),
            inFlight: signal.kind === "offer", retryable: false, lastAttemptAtMs: Date.now(),
        };
        this.entries.set(`${signal.negotiationId}:${signal.kind}`, cached);
        return cached;
    }
    rememberResponse(cached, response, isLive) {
        // A stopped generation or expired entry cannot replace a newer record.
        if (this.entries.get(`${response.negotiationId}:offer`) !== cached)
            return;
        cached.response = response;
        cached.responseIsLive = isLive;
        cached.retryable = false;
    }
    clear() { this.entries.clear(); }
    prune() {
        for (const [key, value] of this.entries) {
            if (value.expiresAtMs < Date.now())
                this.entries.delete(key);
        }
    }
}
//# sourceMappingURL=WebRtcSignal.js.map