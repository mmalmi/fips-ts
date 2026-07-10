import { type NodeAddr } from "../nodeaddr/index.js";
export interface LookupRequest {
    requestId: bigint;
    target: NodeAddr;
    origin: NodeAddr;
    ttl: number;
    minMtu: number;
    originCoords: NodeAddr[];
}
export interface LookupResponse {
    requestId: bigint;
    target: NodeAddr;
    pathMtu: number;
    targetCoords: NodeAddr[];
    proof: Uint8Array;
}
export declare function decodeLookupRequest(payload: Uint8Array): LookupRequest;
export declare function encodeLookupRequestPayload(request: LookupRequest): Uint8Array;
export declare function decodeLookupResponse(payload: Uint8Array): LookupResponse;
export declare function encodeLookupResponsePayload(response: LookupResponse): Uint8Array;
/** Bytes signed by a lookup target, matching Rust LookupResponse::proof_bytes. */
export declare function lookupResponseProofBytes(requestId: bigint, target: NodeAddr, targetCoords: NodeAddr[]): Uint8Array;
//# sourceMappingURL=discovery.d.ts.map