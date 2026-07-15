export const LINK_NEGOTIATION_SERVICE_PORT = 257;
export const LINK_NEGOTIATION_VERSION = 1;
export function encodeLinkNegotiationMessage(message) {
    return new TextEncoder().encode(JSON.stringify(message));
}
export function decodeLinkNegotiationMessage(payload) {
    let value;
    try {
        value = JSON.parse(new TextDecoder().decode(payload));
    }
    catch {
        throw new Error("invalid link-negotiation JSON");
    }
    if (typeof value !== "object" || value === null) {
        throw new Error("link negotiation must be an object");
    }
    const message = value;
    if (message.version !== LINK_NEGOTIATION_VERSION)
        throw new Error("bad link-negotiation version");
    if (typeof message.negotiationId !== "string" || message.negotiationId.length === 0) {
        throw new Error("missing link-negotiation id");
    }
    if (typeof message.linkType !== "string" || message.linkType.length === 0) {
        throw new Error("missing link-negotiation type");
    }
    if (!["offer", "answer", "candidate", "reject"].includes(message.kind)) {
        throw new Error("bad link-negotiation kind");
    }
    if (!Number.isSafeInteger(message.createdAtMs) || !Number.isSafeInteger(message.expiresAtMs)) {
        throw new Error("bad link-negotiation lifetime");
    }
    return message;
}
//# sourceMappingURL=linkNegotiation.js.map