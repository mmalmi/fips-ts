export declare const LINK_NEGOTIATION_SERVICE_PORT = 257;
export declare const LINK_NEGOTIATION_VERSION: 1;
export type LinkNegotiationKind = "offer" | "answer" | "candidate" | "reject";
export interface LinkNegotiationMessage<T = unknown> {
    version: typeof LINK_NEGOTIATION_VERSION;
    negotiationId: string;
    linkType: string;
    kind: LinkNegotiationKind;
    createdAtMs: number;
    expiresAtMs: number;
    payload: T;
}
export declare function encodeLinkNegotiationMessage(message: LinkNegotiationMessage): Uint8Array;
export declare function decodeLinkNegotiationMessage(payload: Uint8Array): LinkNegotiationMessage;
//# sourceMappingURL=linkNegotiation.d.ts.map