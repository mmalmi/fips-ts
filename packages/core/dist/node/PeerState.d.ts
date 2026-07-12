import type { FmpLink } from "../fmp/link.js";
import type { Transport, TransportAddress } from "../transport/types.js";
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
    outgoingHandshake?: {
        resolve: () => void;
        reject: (err: Error) => void;
    };
}
//# sourceMappingURL=PeerState.d.ts.map