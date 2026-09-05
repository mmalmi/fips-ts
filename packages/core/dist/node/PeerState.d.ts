import type { FmpLink } from "../fmp/link.js";
import type { BloomFilter } from "../bloom/index.js";
import type { Transport, TransportAddress } from "../transport/types.js";
export declare const FMP_HANDSHAKE_TIMEOUT_MS = 15000;
export declare const MAX_PENDING_FMP_RESPONDERS = 64;
export interface AdjacentPeer {
    pubkey: Uint8Array;
    pubkeyHex: string;
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
    inboundFilter?: BloomFilter;
    inboundFilterSequence?: bigint;
    outboundFilter?: BloomFilter;
    outgoingHandshake?: {
        resolve: () => void;
        reject: (err: Error) => void;
        confirmCarrier?: () => void;
    };
}
export declare function pruneDrainingResponderLinks(peer: AdjacentPeer, nowMs: number): void;
//# sourceMappingURL=PeerState.d.ts.map