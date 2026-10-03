import { type NodeAddr } from "../nodeaddr/index.js";
import type { Transport, TransportAddress } from "../transport/types.js";
import type { AdjacentPeer } from "./PeerState.js";
export declare function peerNodeKey(peer: AdjacentPeer): string;
export declare function frameCapacity(peer: AdjacentPeer): number;
/** Keep a newer narrow link from hiding a usable carrier to the same identity. */
export declare function selectCarrier(preferred: AdjacentPeer | undefined, peers: Iterable<AdjacentPeer>, excludedPeer: AdjacentPeer | undefined, minMtu: number): AdjacentPeer | undefined;
export declare function delay(milliseconds: number): Promise<void>;
export declare function discoveryPublicKey(discovered: {
    publicKey?: Uint8Array;
    remoteAddr: TransportAddress;
}): Uint8Array;
export declare function lookupReverseKey(requestId: bigint, target: NodeAddr): string;
export declare function isKnownUnhandledLinkMessage(msgType: number): boolean;
interface ResolvedTransportIdentity {
    transport: Transport;
    remoteAddr: TransportAddress;
    remotePubkey: Uint8Array;
}
/** Resolve signed transport discovery without opening its physical carrier. */
export declare function resolveTransportIdentity(transports: Transport[], destNodeAddr: NodeAddr, abort: AbortController, isStarted: () => boolean): Promise<ResolvedTransportIdentity>;
export {};
//# sourceMappingURL=routingHelpers.d.ts.map