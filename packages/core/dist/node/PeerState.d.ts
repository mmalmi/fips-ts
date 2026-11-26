import { type NodeAddr } from "../nodeaddr/index.js";
import type { PeerEvent } from "./types.js";
import type { FmpLink } from "../fmp/link.js";
import type { BloomFilter } from "../bloom/index.js";
import type { Transport, TransportAddress } from "../transport/types.js";
export declare const FMP_HANDSHAKE_TIMEOUT_MS = 15000;
export declare const MAX_PENDING_FMP_RESPONDERS = 64;
/** FIPS identity uses all x-only bytes; Noise retains the actual key parity. */
export declare function sameCompressedIdentity(a: Uint8Array, b: Uint8Array): boolean;
export interface AdjacentPeer {
    pubkey: Uint8Array;
    pubkeyHex: string;
    cachedNodeAddrPubkey?: Uint8Array;
    cachedNodeAddr?: NodeAddr;
    cachedNodeAddrHex?: string;
    remoteAddr: TransportAddress;
    transport: Transport;
    link: FmpLink;
    pendingResponderLink?: FmpLink;
    drainingResponderLinks?: Map<number, {
        link: FmpLink;
        expiresAtMs: number;
    }>;
    abandonedInitiatorSessionIdx?: number;
    treeAnnounced?: boolean;
    filterAnnounced?: boolean;
    clientSupported?: boolean;
    clientOnly?: boolean;
    routingRoleSequence?: bigint;
    extensionNamespace?: "legacy" | "namespaced";
    extensionCapabilities?: number;
    extensionRequestSent?: boolean;
    legacySupportProbes?: number;
    inboundFilter?: BloomFilter;
    inboundFilterSequence?: bigint;
    outboundFilter?: BloomFilter;
    outgoingHandshake?: {
        resolve: () => void;
        reject: (err: Error) => void;
        confirmCarrier?: () => void;
    };
}
/** Return the peer's 16-byte NodeAddr, deriving and caching it once per pubkey. */
export declare function peerNodeAddr(peer: AdjacentPeer): NodeAddr;
/** Return the peer's 32-char lowercase NodeAddr hex, cached per pubkey. */
export declare function peerNodeKey(peer: AdjacentPeer): string;
export declare function peerEvent(peer: AdjacentPeer, state: PeerEvent["state"]): PeerEvent;
export declare function pruneDrainingResponderLinks(peer: AdjacentPeer, nowMs: number): void;
//# sourceMappingURL=PeerState.d.ts.map