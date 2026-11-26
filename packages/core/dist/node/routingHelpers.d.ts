import { type NodeAddr } from "../nodeaddr/index.js";
import type { Transport, TransportAddress } from "../transport/types.js";
import { peerNodeKey, type AdjacentPeer } from "./PeerState.js";
export { peerNodeKey };
export declare function frameCapacity(peer: AdjacentPeer): number;
/** Keep a newer narrow link from hiding a usable carrier to the same identity. */
export declare function selectCarrier(preferred: AdjacentPeer | undefined, peers: Iterable<AdjacentPeer>, excludedPeer: AdjacentPeer | undefined, minMtu: number): AdjacentPeer | undefined;
export declare function delay(milliseconds: number): Promise<void>;
export declare function discoveryPublicKey(discovered: {
    publicKey?: Uint8Array;
    remoteAddr: TransportAddress;
}): Uint8Array;
export declare function lookupReverseKey(requestId: bigint, target: NodeAddr): string;
/**
 * Filter candidate lookup peers using their advertised inbound Bloom filters.
 * Computes SHA-256(target) at most once, skips client-only peers unless they
 * are the target, and falls back to all candidates only when requested.
 */
export declare function filterLookupPeersByBloom(peers: AdjacentPeer[], target: NodeAddr, targetHex: string, defaultPeer: AdjacentPeer | undefined, allowFallback: boolean, treeScope?: {
    isTreePeer: (peer: AdjacentPeer) => boolean;
    strictTreeOnly: boolean;
}): AdjacentPeer[];
export declare function nextClientRoleMessage(peer: AdjacentPeer, allowLegacyProbe: boolean, nextSequence: () => bigint): {
    msgType: number;
    payload: Uint8Array;
} | undefined;
export declare function isKnownUnhandledLinkMessage(msgType: number): boolean;
interface ResolvedTransportIdentity {
    transport: Transport;
    remoteAddr: TransportAddress;
    remotePubkey: Uint8Array;
}
/** Resolve signed transport discovery without opening its physical carrier. */
export declare function resolveTransportIdentity(transports: Transport[], destNodeAddr: NodeAddr, abort: AbortController, isStarted: () => boolean): Promise<ResolvedTransportIdentity>;
//# sourceMappingURL=routingHelpers.d.ts.map