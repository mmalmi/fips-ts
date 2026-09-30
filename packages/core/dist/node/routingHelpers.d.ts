import { type NodeAddr } from "../nodeaddr/index.js";
import type { TransportAddress } from "../transport/types.js";
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
//# sourceMappingURL=routingHelpers.d.ts.map