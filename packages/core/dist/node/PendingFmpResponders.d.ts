import type { FmpLink } from "../fmp/link.js";
import { type AdjacentPeer } from "./PeerState.js";
/** Owns the bounded lifetime of responder keys awaiting confirmation. */
export declare class PendingFmpResponders {
    private readonly removePeerPath;
    private readonly pending;
    constructor(removePeerPath: (peer: AdjacentPeer) => void);
    clear(): void;
    discard(peer: AdjacentPeer): void;
    take(peer: AdjacentPeer): FmpLink | undefined;
    set(peer: AdjacentPeer, link: FmpLink): void;
}
//# sourceMappingURL=PendingFmpResponders.d.ts.map